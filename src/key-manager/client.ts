import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface KeyManagerClientConfig {
  url: string;
  tokenFile: string;
  timeoutMs: number;
}

export interface VisibleKey {
  name: string;
  project: string;
  provider: string;
  version: number;
  updatedAt: string;
}

export interface VisibleProfile {
  id: string;
  label: string;
  provider: string;
}

export class KeyManagerClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'KeyManagerClientError';
  }
}

function brokerUrl(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('key-manager URL must use HTTPS unless it is loopback');
  }
  return url;
}

async function readPrivateToken(path: string): Promise<string> {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new KeyManagerClientError('key-manager token file is not a private regular file');
  }
  const token = (await readFile(absolute, 'utf8')).trim();
  if (!token) throw new KeyManagerClientError('key-manager token file is empty');
  return token;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KeyManagerClientError('key-manager returned an invalid response');
  return value as Record<string, unknown>;
}

export class KeyManagerClient {
  private readonly baseUrl: URL;

  constructor(
    private readonly config: KeyManagerClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = brokerUrl(config.url);
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 60_000) {
      throw new Error('invalid key-manager timeout');
    }
  }

  private async request(path: string, init: RequestInit = {}, acceptDenied = false): Promise<Record<string, unknown>> {
    const token = await readPrivateToken(this.config.tokenFile);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') throw new KeyManagerClientError('key-manager request timed out');
      throw new KeyManagerClientError('key-manager is unavailable');
    }
    const raw = await response.text();
    if (raw.length > 2 * 1024 * 1024) throw new KeyManagerClientError('key-manager response exceeded client limit');
    let parsed: unknown;
    try { parsed = JSON.parse(raw || '{}'); } catch { throw new KeyManagerClientError('key-manager returned invalid JSON', response.status); }
    const body = asObject(parsed);
    if (!response.ok && !(acceptDenied && response.status === 403 && body.status === 'denied')) {
      throw new KeyManagerClientError(`key-manager returned HTTP ${response.status}`, response.status);
    }
    return body;
  }

  async list(project?: string): Promise<{ keys: VisibleKey[] }> {
    const query = project ? `?project=${encodeURIComponent(project)}` : '';
    const body = await this.request(`/v1/keys${query}`);
    if (!Array.isArray(body.keys)) throw new KeyManagerClientError('key-manager keys response is invalid');
    return { keys: body.keys as VisibleKey[] };
  }

  async profiles(keyName: string): Promise<{ profiles: VisibleProfile[] }> {
    const body = await this.request(`/v1/profiles?key=${encodeURIComponent(keyName)}`);
    if (!Array.isArray(body.profiles)) throw new KeyManagerClientError('key-manager profiles response is invalid');
    return { profiles: body.profiles as VisibleProfile[] };
  }

  async run(input: {
    project: string;
    keyName: string;
    profileId: string;
    input: unknown;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    return this.request('/v1/operations', { method: 'POST', body: JSON.stringify(input) }, true);
  }

  async status(id: string): Promise<Record<string, unknown>> {
    if (id.startsWith('JOB-')) return this.request(`/v1/jobs/${encodeURIComponent(id)}`);
    if (id.startsWith('KMGR-')) {
      const body = await this.request('/v1/requests');
      const requests = Array.isArray(body.requests) ? body.requests as Array<Record<string, unknown>> : [];
      const request = requests.find((entry) => entry.id === id);
      if (!request) throw new KeyManagerClientError('key-manager request was not found', 404);
      return { request };
    }
    throw new KeyManagerClientError('status id must be a KMGR or JOB id');
  }
}
