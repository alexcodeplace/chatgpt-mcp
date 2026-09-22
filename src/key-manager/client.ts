import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface KeyManagerClientConfig { url: string; tokenFile: string; timeoutMs: number }
export interface VisibleKey { name: string }
export interface VisibleProfile { id: string; version: number; label: string; provider: string }
export class KeyManagerClientError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'KeyManagerClientError'; }
}

export function brokerUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('key-manager URL must use HTTPS or loopback HTTP, without credentials, query or fragment');
  }
  return url;
}
async function readPrivateToken(path: string): Promise<string> {
  try {
    const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > 4096) throw new Error('unsafe file');
      const token = (await file.readFile('utf8')).trim();
      if (!token || token.length > 4096 || /[\r\n\0]/.test(token)) throw new Error('invalid credential');
      return token;
    } finally { await file.close(); }
  } catch { throw new KeyManagerClientError('key-manager client credential is unavailable or not private'); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KeyManagerClientError('key-manager returned an invalid response');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 240): string {
  if (typeof value !== 'string' || !value || value.length > maximum) throw new KeyManagerClientError('key-manager response field is invalid');
  return value;
}
function project(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const input = object(value);
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(input, field)).map((field) => [field, input[field]]));
}
const REQUEST_FIELDS = ['id', 'revision', 'connectorId', 'project', 'keyName', 'keyVersion', 'profileId', 'profileVersion', 'profileLabel', 'scope', 'inputHash', 'state', 'createdAt', 'expiresAt', 'decision', 'decidedAt', 'jobId', 'notification'];
const JOB_FIELDS = ['id', 'requestId', 'state', 'createdAt', 'startedAt', 'finishedAt', 'result', 'error'];
async function boundedBody(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new KeyManagerClientError('key-manager response is empty');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new KeyManagerClientError('key-manager response exceeded client limit'); }
      chunks.push(item.value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof KeyManagerClientError) throw error;
    throw new KeyManagerClientError('key-manager response could not be read');
  } finally { reader.releaseLock(); }
}

export class KeyManagerClient {
  private readonly baseUrl: URL;
  constructor(private readonly config: KeyManagerClientConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = brokerUrl(config.url);
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 60_000) throw new Error('invalid key-manager timeout');
  }
  private async request(path: string, init: RequestInit = {}, acceptDenied = false, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const token = await readPrivateToken(this.config.tokenFile);
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(this.config.timeoutMs);
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init, redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw new KeyManagerClientError('key-manager request cancelled');
      if (error instanceof DOMException && error.name === 'TimeoutError') throw new KeyManagerClientError('key-manager request timed out');
      throw new KeyManagerClientError('key-manager is unavailable');
    }
    // Never reflect a server diagnostic that might contain a credential.
    if (!response.ok && !(acceptDenied && response.status === 403)) {
      await response.body?.cancel();
      throw new KeyManagerClientError(`key-manager returned HTTP ${response.status}`, response.status);
    }
    const body = await boundedBody(response);
    if (!response.ok && body.status !== 'denied') throw new KeyManagerClientError('key-manager denied the operation', response.status);
    return body;
  }
  async list(projectName?: string, signal?: AbortSignal): Promise<{ keys: VisibleKey[] }> {
    const body = await this.request(`/v1/keys${projectName ? `?project=${encodeURIComponent(projectName)}` : ''}`, {}, false, signal);
    if (!Array.isArray(body.keys)) throw new KeyManagerClientError('key-manager keys response is invalid');
    return { keys: body.keys.map((entry) => ({ name: text(object(entry).name) })) };
  }
  async profiles(keyName: string, signal?: AbortSignal): Promise<{ profiles: VisibleProfile[] }> {
    const body = await this.request(`/v1/profiles?key=${encodeURIComponent(keyName)}`, {}, false, signal);
    if (!Array.isArray(body.profiles)) throw new KeyManagerClientError('key-manager profiles response is invalid');
    return { profiles: body.profiles.map((entry) => {
      const value = object(entry);
      if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) throw new KeyManagerClientError('invalid profile version');
      return { id: text(value.id), version: Number(value.version), label: text(value.label), provider: text(value.provider) };
    }) };
  }
  async run(input: { project: string; keyName: string; profileId: string; input: unknown; idempotencyKey: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const body = await this.request('/v1/operations', { method: 'POST', body: JSON.stringify(input) }, true, signal);
    if (!['pending', 'accepted', 'denied'].includes(String(body.status))) throw new KeyManagerClientError('invalid key-manager operation status');
    const result: Record<string, unknown> = { status: body.status };
    if (body.request) result.request = project(body.request, REQUEST_FIELDS);
    if (body.job) result.job = project(body.job, JOB_FIELDS);
    if (body.rule) result.rule = project(body.rule, ['id', 'effect', 'scope']);
    if (typeof body.reason === 'string') result.reason = body.reason;
    return result;
  }
  async status(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (/^JOB-[0-9A-HJKMNP-TV-Z]{10}$/.test(id)) {
      const body = await this.request(`/v1/jobs/${id}`, {}, false, signal);
      return { job: project(body.job, JOB_FIELDS) };
    }
    if (/^KMGR-[0-9A-HJKMNP-TV-Z]{10}$/.test(id)) {
      const body = await this.request(`/v1/requests/${id}`, {}, false, signal);
      return { request: project(body.request, REQUEST_FIELDS) };
    }
    throw new KeyManagerClientError('status id must be a valid KMGR or JOB id');
  }
}
