import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ChatGptMcpConfig } from '../config.js';

export const SECRET_REDACTED = '[SECRET_REDACTED]';
// These values are defined by our public tool schemas, not supplied credentials.
// Sanitizing them or object property names would invalidate an otherwise successful
// MCP response. Credential-bearing strings remain protected at the value boundary.
const PUBLIC_SCHEMA_VALUES: Readonly<Record<string, readonly string[]>> = {
  type: ['text', 'image', 'audio', 'resource', 'resource_link', 'file', 'directory', 'symlink', 'other'],
  mimeType: ['image/png'],
  state: ['starting', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'],
  mode: ['create', 'overwrite', 'append', 'output-only'],
  action: ['start', 'stop', 'restart'],
  button: ['left', 'middle', 'right'],
  stream: ['stdout', 'stderr'],
};

const MAX_FILES = 128;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_VALUES = 2048;
const MAX_VALUE_CHARACTERS = 512 * 1024;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g;
const PROVIDER_VALUE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,512}|xox[baprs]-[A-Za-z0-9-]{12,255}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
const ASSIGNMENT = /(["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*[:=][ \t]*)("(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|[^\s,;&}\]]+)/g;
const HEADER = /^([ \t]*(?:Proxy-)?Authorization|[ \t]*(?:Set-)?Cookie)([ \t]*:[ \t]*)([^\r\n]+)/gim;
const AUTH = /\b(Bearer|Basic)([ \t]+)([A-Za-z0-9+/_=.~-]{4,})/gi;
const CLI = /(--([A-Za-z][A-Za-z0-9_-]*)[ =]+)("(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|[^\s,;&}\]]+)/g;
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi;
const QUERY_SECRET = /([?&]([A-Za-z_][A-Za-z0-9_.-]*)=)([^&#\s]+)/g;

export function isSecretName(name: string): boolean {
  const normalized = name.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[.-]/g, '_').toLowerCase();
  return /(?:^|_)(?:token|secret|password|passwd|credential|credentials|api_key|private_key|access_key)(?:_id|_value)?$/.test(normalized)
    || /^(?:authorization|proxy_authorization|cookie|set_cookie)$/.test(normalized);
}

export function isCredentialPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  const name = basename(normalized).toLowerCase();
  return /(?:^|\/)\.secrets(?:\/|$)/.test(normalized)
    || /^(?:\.env|\.dev\.vars)(?:\.|$)/.test(name)
    || /^(?:\.npmrc|\.netrc|credentials(?:\.[a-z0-9]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|runtime-api-key)$/.test(name)
    || /(?:^|[._-])(?:token|api[._-]?key|private[._-]?key|secret)(?:[._-]|$)/.test(name) && !/\.(?:[cm]?[jt]sx?|py|md|test|map)$/.test(name)
    || /\.(?:pem|key)$/.test(name);
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
  }
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
}

/** Per-call, bounded, output-only state. It is never serialized or logged. */
export class OutputRedactor {
  private readonly values = new Set<string>();
  private readonly files = new Set<string>();
  private readonly directories = new Set<string>();
  private characters = 0;
  private exact: RegExp | undefined;
  private dirty = false;
  private suppressText = false;

  private constructor(private readonly config: Readonly<ChatGptMcpConfig>, private readonly input: unknown) {}

  static async create(config: Readonly<ChatGptMcpConfig>, input: unknown = {}): Promise<OutputRedactor> {
    const redactor = new OutputRedactor(config, input);
    try {
      redactor.learn(process.env);
      redactor.add(config.http.token);
      redactor.learn(input);
      redactor.discover();
      await redactor.refresh();
    } catch { redactor.suppressText = true; }
    return redactor;
  }

  private add(value: unknown): void {
    if (typeof value !== 'string' || value.length < 4 || value === SECRET_REDACTED || value.includes('SECRET_REDACTED')) return;
    const variants = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
    // Recognize common accidental encoding, not arbitrary transformations.
    if (value.length >= 8) {
      variants.add(Buffer.from(value).toString('base64'));
      variants.add(Buffer.from(value).toString('base64url'));
      variants.add(Buffer.from(value).toString('hex'));
    }
    for (const variant of variants) {
      if (this.values.has(variant)) continue;
      if (this.values.size >= MAX_VALUES || this.characters + variant.length > MAX_VALUE_CHARACTERS) {
        this.suppressText = true;
        return;
      }
      this.values.add(variant);
      this.characters += variant.length;
      this.dirty = true;
    }
  }

  private learnText(text: string, credentialSource = false): void {
    for (const match of text.matchAll(ASSIGNMENT)) {
      const raw = match[3]!;
      // Command/source text contains variable references such as credential=value.
      // They are not literal keys. Credential files are trusted value sources;
      // environment/structured credential fields are learned separately as values.
      const reference = /^[A-Za-z_$][A-Za-z_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(raw);
      if (isSecretName(match[2]!) && (credentialSource || !reference)) this.add(unquote(raw));
    }
    for (const match of text.matchAll(AUTH)) this.add(match[3]);
    for (const match of text.matchAll(CLI)) if (isSecretName(match[2]!)) this.add(unquote(match[3]!));
    for (const match of text.matchAll(QUERY_SECRET)) if (isSecretName(match[2]!)) this.add(unquote(match[3]!));
    for (const match of text.matchAll(PRIVATE_KEY)) {
      this.add(match[0]);
      for (const line of match[0].split(/\r?\n/)) if (/^[A-Za-z0-9+/=]{16,}$/.test(line)) this.add(line);
    }
  }

  private learn(value: unknown, depth = 0): void {
    if (depth > 32) { this.suppressText = true; return; }
    if (typeof value === 'string') { this.learnText(value); return; }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item: unknown = value[i];
        if (typeof item === 'string' && item.startsWith('--') && isSecretName(item.slice(2))) this.add(value[i + 1]);
        this.learn(item, depth + 1);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (isSecretName(key)) this.add(child);
        this.learn(child, depth + 1);
      }
    }
  }

  private allowed(path: string): boolean {
    return this.config.filesystem.roots.some(root => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));
  }

  private discover(): void {
    for (const path of this.config.outputRedaction.files) this.files.add(path);
    for (const path of this.config.outputRedaction.directories) this.directories.add(path);
    const input = this.input as Record<string, unknown> | null;
    const cwd = resolve(typeof input?.['cwd'] === 'string' ? input['cwd'] : process.cwd());
    const bases = new Set([cwd]);
    if (typeof input?.['path'] === 'string') {
      bases.add(resolve(input['path']));
      bases.add(dirname(resolve(input['path'])));
    }
    for (const base of bases) {
      let ancestor = base;
      for (let depth = 0; depth < 12 && this.allowed(ancestor); depth++) {
        this.directories.add(join(ancestor, '.secrets'));
        for (const name of ['.env', '.env.local', '.env.production', '.env.development', '.env.test', '.dev.vars', '.dev.vars.local']) this.files.add(join(ancestor, name));
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    for (const path of [join(homedir(), '.aws', 'credentials'), join(homedir(), '.npmrc'), join(homedir(), '.netrc'),
      join(homedir(), '.config', '.wrangler', 'config', 'default.toml'), join(homedir(), '.config', 'wrangler', 'config', 'default.toml')]) {
      if (this.allowed(path)) this.files.add(path);
    }
    const strings: string[] = [];
    const collect = (value: unknown, depth = 0): void => {
      if (depth > 16 || strings.length >= 256) return;
      if (typeof value === 'string') strings.push(value);
      else if (value !== null && typeof value === 'object') for (const child of Object.values(value)) collect(child, depth + 1);
    };
    collect(this.input);
    for (const text of strings) {
      const words: string[] = text.match(/[^\s"'`<>|;&()[\]{},=]+/g) ?? [];
      if (text.length <= 4096 && !/[\r\n]/.test(text)) words.unshift(text);
      for (const word of words) {
        if (word.length > 4096 || !isCredentialPath(word)) continue;
        const expanded = word.startsWith('~/') ? join(homedir(), word.slice(2)) : word;
        const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
        if (this.allowed(path)) this.files.add(path);
      }
    }
  }

  async refresh(): Promise<void> {
    // Missing candidates are normal. Other inspection errors suppress textual output
    // without blocking or changing the operation itself.
    try {
      const discovered = new Set(this.files);
      let count = 0;
      const scan = async (path: string, depth: number): Promise<void> => {
        try {
          const directory = await opendir(path);
          for await (const entry of directory) {
            if (++count > MAX_FILES) { this.suppressText = true; break; }
            const child = join(path, entry.name);
            if (entry.isFile() || entry.isSymbolicLink()) discovered.add(child);
            else if (entry.isDirectory() && depth < 2) await scan(child, depth + 1);
          }
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) this.suppressText = true;
        }
      };
      for (const directory of this.directories) await scan(directory, 0);
      let totalBytes = 0;
      let opened = 0;
      for (const path of discovered) {
        let file;
        try {
          // Nonblocking open plus fstat avoids hanging on a pipe or device.
          const canonical = await realpath(path);
          const explicit = this.config.outputRedaction.files.includes(path)
            || this.config.outputRedaction.directories.some(root => path.startsWith(root + sep));
          if (!explicit && !this.allowed(canonical)) continue;
          file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
          const metadata = await file.stat();
          if (!metadata.isFile()) continue;
          if (++opened > MAX_FILES || metadata.size > MAX_FILE_BYTES || totalBytes + metadata.size > MAX_TOTAL_BYTES) {
            this.suppressText = true; break;
          }
          // Read at most the limit even if the file grows between stat and read.
          const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > MAX_FILE_BYTES) { this.suppressText = true; break; }
          totalBytes += bytesRead;
          const text = buffer.subarray(0, bytesRead).toString('utf8');
          this.learnText(text, true);
          try { this.learn(JSON.parse(text)); } catch { /* Not all credential files are JSON. */ }
          for (const line of text.split(/\r?\n/)) {
            const plain = line.trim();
            if (plain && !/\s/.test(plain) && !/^(?:\{|\[|#|;|[A-Za-z_][\w]*=(?![=]*$))/.test(plain)) this.add(unquote(plain));
          }
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) this.suppressText = true;
        } finally { await file?.close(); }
      }
    } catch { this.suppressText = true; }
  }

  text(value: string): string {
    if (value.length === 0) return value;
    if (this.suppressText) return SECRET_REDACTED;
    if (this.dirty) {
      this.exact = this.values.size === 0 ? undefined : new RegExp([...this.values].sort((a, b) => b.length - a.length)
        .map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
      this.dirty = false;
    }
    let text = value.replace(ANSI, '');
    if (this.exact !== undefined) text = text.replace(this.exact, SECRET_REDACTED);
    text = text.replace(PRIVATE_KEY, SECRET_REDACTED).replace(PROVIDER_VALUE, SECRET_REDACTED);
    text = text.replace(AUTH, (_match, kind: string, space: string) => kind + space + SECRET_REDACTED);
    text = text.replace(HEADER, (_match, name: string, separator: string) => name + separator + SECRET_REDACTED);
    text = text.replace(QUERY_SECRET, (match, prefix: string, key: string) => isSecretName(key) ? prefix + SECRET_REDACTED : match);
    text = text.replace(ASSIGNMENT, (match, prefix: string, key: string, raw: string) => {
      if (!isSecretName(key) || raw.includes('SECRET_REDACTED')) return match;
      const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : '';
      return prefix + quote + SECRET_REDACTED + quote;
    });
    text = text.replace(CLI, (match, prefix: string, key: string) => isSecretName(key) && !match.includes('SECRET_REDACTED') ? prefix + SECRET_REDACTED : match);
    return text.replace(USERINFO, (_match, scheme: string) => scheme + SECRET_REDACTED + '@');
  }

  value<T>(input: T): T {
    try {
      const visit = (value: unknown, depth = 0): unknown => {
        if (depth > 32) return SECRET_REDACTED;
        if (typeof value === 'string') return this.text(value);
        if (Array.isArray(value)) return value.map(child => visit(child, depth + 1));
        if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [
          key,
          typeof child === 'string' && PUBLIC_SCHEMA_VALUES[key]?.includes(child) ? child
            : isSecretName(key) && (typeof child === 'string' || typeof child === 'number') ? SECRET_REDACTED
              : visit(child, depth + 1),
        ]));
        return value;
      };
      return visit(input) as T;
    } catch {
      // Caller handles unexpected output serialization errors without returning raw text.
      throw new Error('Output sanitization failed.');
    }
  }

  async result(result: CallToolResult, operation: string): Promise<CallToolResult> {
    await this.refresh();
    const input = this.input as Record<string, unknown> | null;
    let structured = result.structuredContent;
    const learnStructuredSecrets = (value: unknown, depth = 0): void => {
      if (depth > 32 || value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const child of value) learnStructuredSecrets(child, depth + 1); return; }
      for (const [key, child] of Object.entries(value)) {
        if (isSecretName(key)) this.add(child);
        else learnStructuredSecrets(child, depth + 1);
      }
    };
    learnStructuredSecrets(structured);
    // Never learn arbitrary returned text as a secret source. Doing so lets source code,
    // logs, or diagnostics such as `token = value` poison later output and over-redact
    // unrelated occurrences of `value`. Secret values are learned only from trusted
    // inputs, environment, and credential files; secret-named structured fields are
    // still redacted directly by value().
    if (operation === 'fs.read' && !result.isError && typeof input?.['path'] === 'string') {
      const path = resolve(input['path']);
      let canonical = path;
      try { canonical = await realpath(path); } catch { /* Adapter already authorizes and reads. */ }
      if (isCredentialPath(path) || isCredentialPath(canonical) || this.config.outputRedaction.files.includes(path)
        || this.config.outputRedaction.directories.some(root => path.startsWith(root + sep))) {
        structured = { ...(structured && typeof structured === 'object' ? structured : {}), content: SECRET_REDACTED, bytes: Buffer.byteLength(SECRET_REDACTED) };
      }
    }
    // Do not interpret image/audio data as text. Their visible pixels are out of scope.
    const { content, structuredContent: _structured, ...rest } = result;
    return {
      ...this.value(rest),
      content: content.map(part => {
        if (part.type === 'image' || part.type === 'audio') {
          const { data, ...metadata } = part;
          return Object.assign(this.value(metadata), { type: part.type, mimeType: part.mimeType, data });
        }
        return Object.assign(this.value(part), { type: part.type });
      }),
      ...(structured === undefined ? {} : { structuredContent: this.value(structured) }),
    };
  }
}
