import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { adapterError } from '../errors.js';

export interface FilesystemBlockRule {
  readonly path: string;
  readonly mode: 'freeze-children' | 'deny-read';
  readonly message?: string | undefined;
}

const DEFAULT_FREEZE_MESSAGE = 'Filesystem policy prevents changing entries directly inside this directory.';
const DEFAULT_READ_DENY_MESSAGE = 'Filesystem policy prevents reading this path.';

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function canonicalRulePath(rule: FilesystemBlockRule, operation: string): Promise<string> {
  try {
    return await realpath(resolve(rule.path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw adapterError(
        'PATH_NOT_ALLOWED',
        operation,
        'A configured filesystem blocklist path does not exist; refusing the operation so the policy fails closed.',
        { blocklistPath: resolve(rule.path), mode: rule.mode },
      );
    }
    throw error;
  }
}

function blocked(rule: FilesystemBlockRule, operation: string, candidate: string): never {
  throw adapterError(
    'PATH_NOT_ALLOWED',
    operation,
    rule.message ?? (rule.mode === 'deny-read' ? DEFAULT_READ_DENY_MESSAGE : DEFAULT_FREEZE_MESSAGE),
    { path: candidate, blocklistPath: resolve(rule.path), mode: rule.mode },
  );
}

async function frozenParentRuleFor(parent: string, rules: readonly FilesystemBlockRule[], operation: string): Promise<FilesystemBlockRule | undefined> {
  let parentReal: string;
  try {
    parentReal = await realpath(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  for (const rule of rules) {
    if (rule.mode !== 'freeze-children') continue;
    if (parentReal === await canonicalRulePath(rule, operation)) return rule;
  }
  return undefined;
}

/**
 * Authorize an operation that may create a filesystem entry. Existing entries
 * are allowed because writing their contents does not mutate the protected
 * parent's directory-entry set. For recursive creation, the nearest existing
 * ancestor catches attempts such as /protected/new/nested in one call.
 */
export async function authorizePathEntryCreation(
  requestedPath: string,
  rules: readonly FilesystemBlockRule[],
  operation: string,
): Promise<void> {
  if (rules.length === 0) return;
  const candidate = resolve(requestedPath);
  try {
    await lstat(candidate);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const ancestor = await nearestExistingAncestor(candidate);
  const ancestorReal = await realpath(ancestor);
  for (const rule of rules) {
    if (rule.mode !== 'freeze-children') continue;
    if (ancestorReal === await canonicalRulePath(rule, operation)) blocked(rule, operation, candidate);
  }
}

/** Authorize removing, renaming, or moving a direct child of a frozen parent. */
export async function authorizePathEntryMutation(
  requestedPath: string,
  rules: readonly FilesystemBlockRule[],
  operation: string,
): Promise<void> {
  if (rules.length === 0) return;
  const candidate = resolve(requestedPath);
  for (const rule of rules) {
    if (rule.mode !== 'freeze-children') continue;
    const configured = resolve(rule.path);
    if (candidate === configured) blocked(rule, operation, candidate);
    try {
      const candidateReal = await realpath(candidate);
      if (candidateReal === await canonicalRulePath(rule, operation)) blocked(rule, operation, candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const rule = await frozenParentRuleFor(dirname(candidate), rules, operation);
  if (rule !== undefined) blocked(rule, operation, candidate);
}

const SHELL_CREATE_COMMANDS = new Set(['mkdir']);
const SHELL_REMOVE_COMMANDS = new Set(['rmdir', 'rm']);
const SHELL_DIRECT_READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'strings', 'wc', 'base64', 'xxd', 'hexdump', 'od',
  'md5sum', 'sha1sum', 'sha224sum', 'sha256sum', 'sha384sum', 'sha512sum', 'b2sum',
  'cp', 'grep', 'sed', 'awk',
]);

const SYSTEMD_RUN_OPTIONS_WITH_VALUE = new Set([
  '-p', '--property', '--unit', '--description', '--slice', '--service-type',
  '--uid', '--gid', '--nice', '--working-directory', '--setenv', '--umask',
]);

function unwrapSystemdRun(args: readonly string[]): { command: string; args: readonly string[] } | undefined {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined) return undefined;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;
    if (arg.includes('=')) {
      index += 1;
      continue;
    }
    if (SYSTEMD_RUN_OPTIONS_WITH_VALUE.has(arg)) {
      index += 2;
      continue;
    }
    index += 1;
  }
  const command = args[index];
  return command === undefined ? undefined : { command, args: args.slice(index + 1) };
}

function unwrapEnv(args: readonly string[]): { command: string; args: readonly string[] } | undefined {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined) return undefined;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      index += 1;
      continue;
    }
    if (arg === '-u' || arg === '--unset' || arg === '-C' || arg === '--chdir' || arg === '-S' || arg === '--split-string') {
      index += 2;
      continue;
    }
    if (arg.startsWith('--unset=') || arg.startsWith('--chdir=') || arg.startsWith('--split-string=')
        || arg === '-i' || arg === '--ignore-environment' || arg === '-0' || arg === '--null') {
      index += 1;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      index += 1;
      continue;
    }
    break;
  }
  const command = args[index];
  return command === undefined ? undefined : { command, args: args.slice(index + 1) };
}

function unwrapObviousReadCommand(command: string, args: readonly string[]): { command: string; args: readonly string[] } {
  let current = { command, args };
  for (let depth = 0; depth < 4; depth += 1) {
    const executable = basename(current.command);
    let next: { command: string; args: readonly string[] } | undefined;
    if (executable === 'systemd-run') next = unwrapSystemdRun(current.args);
    else if (executable === 'env') next = unwrapEnv(current.args);
    else if (executable === 'nohup') {
      const nested = current.args[0] === '--' ? current.args.slice(1) : current.args;
      const nestedCommand = nested[0];
      next = nestedCommand === undefined ? undefined : { command: nestedCommand, args: nested.slice(1) };
    } else break;
    if (next === undefined) break;
    current = next;
  }
  return current;
}

function shellReadOperands(command: string, args: readonly string[]): string[] {
  if (command === 'dd') {
    return args.flatMap(arg => arg.startsWith('if=') && arg.length > 3 ? [arg.slice(3)] : []);
  }
  if (!SHELL_DIRECT_READ_COMMANDS.has(command)) return [];
  const paths: string[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-') && arg !== '-') continue;
    if (arg !== '-') paths.push(arg);
  }
  return paths;
}

function shellOperands(command: string, args: readonly string[]): { paths: string[]; parents: boolean } {
  const paths: string[] = [];
  let options = true;
  let parents = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      if (command === 'mkdir') {
        if (arg === '-p' || arg === '--parents' || /^-[^-]*p/.test(arg)) parents = true;
        if (arg === '-m' || arg === '--mode' || arg === '--context') index += 1;
      } else if (command === 'rmdir') {
        if (arg === '-p' || arg === '--parents' || /^-[^-]*p/.test(arg)) parents = true;
      }
      continue;
    }
    paths.push(arg);
  }
  return { paths, parents };
}

/**
 * Guard the common direct shell commands that accidentally create/remove a
 * protected top-level project entry. This is intentionally not a shell sandbox:
 * it never changes the execution backend and does not try to parse arbitrary
 * wrappers or language runtimes.
 */
/**
 * Refuse common direct shell reads of protected paths. This covers obvious
 * argument-array readers without pretending to sandbox arbitrary runtimes.
 */
export async function authorizeShellFilesystemRead(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  rules: readonly FilesystemBlockRule[],
  operation = 'shell.exec',
): Promise<void> {
  if (!rules.some(rule => rule.mode === 'deny-read')) return;
  const unwrapped = unwrapObviousReadCommand(command, args);
  const executable = basename(unwrapped.command);
  const base = cwd ?? process.cwd();
  for (const rawPath of shellReadOperands(executable, unwrapped.args)) {
    const candidate = resolve(base, rawPath);
    let candidateReal: string;
    try {
      candidateReal = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const rule of rules) {
      if (rule.mode !== 'deny-read') continue;
      const protectedReal = await canonicalRulePath(rule, operation);
      if (isWithin(protectedReal, candidateReal)) blocked(rule, operation, candidate);
    }
  }
}

export async function authorizeShellFilesystemMutation(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  rules: readonly FilesystemBlockRule[],
  operation = 'shell.exec',
): Promise<void> {
  if (rules.length === 0) return;
  const executable = basename(command);
  if (!SHELL_CREATE_COMMANDS.has(executable) && !SHELL_REMOVE_COMMANDS.has(executable)) return;
  const { paths, parents } = shellOperands(executable, args);
  const base = cwd ?? process.cwd();
  for (const rawPath of paths) {
    const target = resolve(base, rawPath);
    if (SHELL_CREATE_COMMANDS.has(executable)) {
      await authorizePathEntryCreation(target, rules, operation);
      continue;
    }
    await authorizePathEntryMutation(target, rules, operation);
    if (executable === 'rmdir' && parents) {
      let parent = dirname(target);
      for (;;) {
        await authorizePathEntryMutation(parent, rules, operation);
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
    }
  }
}

/** Refuse direct reads of an exact protected file or descendants of a protected directory. */
export async function authorizePathRead(
  requestedPath: string,
  configuredRoots: readonly string[],
  rules: readonly FilesystemBlockRule[],
  operation = 'fs.read',
): Promise<string> {
  const candidate = await authorizePath(requestedPath, configuredRoots, operation);
  if (rules.length === 0) return candidate;
  let candidateReal: string;
  try {
    candidateReal = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
    throw error;
  }
  for (const rule of rules) {
    if (rule.mode !== 'deny-read') continue;
    const protectedReal = await canonicalRulePath(rule, operation);
    if (isWithin(protectedReal, candidateReal)) blocked(rule, operation, candidate);
  }
  return candidate;
}

export async function authorizePath(
  requestedPath: string,
  configuredRoots: readonly string[],
  operation: string,
): Promise<string> {
  if (configuredRoots.length === 0) {
    throw adapterError('PATH_NOT_ALLOWED', operation, 'No filesystem roots are configured.');
  }

  const candidate = resolve(requestedPath);
  for (const rawRoot of configuredRoots) {
    const root = resolve(rawRoot);
    if (!isWithin(root, candidate)) continue;

    try {
      const rootReal = await realpath(root);
      const ancestor = await nearestExistingAncestor(candidate);
      const ancestorReal = await realpath(ancestor);
      if (isWithin(rootReal, ancestorReal)) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }

  throw adapterError('PATH_NOT_ALLOWED', operation, 'Path is outside the configured filesystem roots.', {
    path: candidate,
  });
}
