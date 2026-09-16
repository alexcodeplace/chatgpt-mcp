import { createHash, createHmac, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { createServer, request, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as z from 'zod/v4';
import type { ChatGptMcpConfig } from '../config.js';
import { atomicJobJson } from '../execution/job-store.js';
import { requireBearer, validators } from '../http-server.js';
import { equalSecret, jobsAbi, policyFingerprint, routingAbi } from './identity.js';
import { decodeRpc, SseRewriter } from './sse.js';
import { forwardHeaders, json, loopbackUrl, object, readBytes, RouteError } from './wire.js';

const idSchema = z.string().regex(/^[a-f0-9]{32}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const generationSchema = z.object({
  id: idSchema,
  url: z.string().max(100).refine(value => { try { loopbackUrl(value); return true; } catch { return false; } }),
  revision: z.string().regex(/^(?:[a-f0-9]{40}|development)$/),
  unit: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/),
  policyFingerprint: hashSchema,
  legacy: z.object({ pid: z.number().int().positive(), startedAt: z.string().min(1), configFingerprint: hashSchema }).strict().optional(),
}).strict();
export type Generation = z.infer<typeof generationSchema>;
const registrySchema = z.object({
  schema: z.literal(1), epoch: z.number().int().nonnegative(),
  active: idSchema.nullable(), previous: idSchema.nullable(), legacyOwner: idSchema.nullable(),
  generations: z.array(generationSchema).max(128),
}).strict();
type Registry = z.infer<typeof registrySchema>;
type Exchange = { generation: string; upstream: ClientRequest; cancelled: boolean };
export interface RouterOptions {
  config: Readonly<ChatGptMcpConfig>;
  port: number;
  controlSocket: string;
  statePath: string;
  key: string;
  /** Fault seam for deterministic persistence tests; never configured by CLI. */
  persist?: (path: string, value: unknown) => Promise<void>;
}
export interface RunningRouter {
  endpoint: string;
  server: Server;
  control: Server;
  close(): Promise<void>;
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RouteError('INVALID_CONTROL_INPUT', 400);
  return result.data;
}
function cancellationKey(req: IncomingMessage, id: unknown): string | undefined {
  if (typeof id !== 'string' && typeof id !== 'number') return undefined;
  if (typeof req.headers['mcp-session-id'] !== 'string' || !req.headers['mcp-session-id']) return undefined;
  // Unscoped stateless callers cancel by closing their own HTTP response.
  // IDs are typed and scoped. A missing session is not invented from the TCP
  // connection: HTTP pools multiplex independent agents on the same connection.
  return createHash('sha256').update(JSON.stringify([
    req.headers.authorization ?? null, req.headers['mcp-session-id'] ?? null, typeof id, id,
  ])).digest('hex');
}
function rpcError(res: ServerResponse, status: number, code: string, id: unknown = null): void {
  json(res, status, { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null,
    error: { code: code === 'CANCELLED' ? -32800 : -32000, message: code, data: { code, retryable: false } } });
}
async function upstreamJson(generation: Generation, path: string, key: string, token: string | undefined,
  body?: unknown): Promise<Record<string, unknown>> {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const upstream = request(new URL(path, generation.url), {
      method: data ? 'POST' : 'GET', agent: false,
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        'x-mcp-route-key': key, 'x-mcp-route-instance': generation.id,
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-length': data.length } : {}) },
    }, response => {
      void readBytes(response, 1024 * 1024).then(bytes => {
        if (response.statusCode !== 200) throw new RouteError('BACKEND_VALIDATION_FAILED');
        return decodeRpc(bytes, response.headers['content-type']);
      }).then(resolve, reject);
    });
    const timer = setTimeout(() => upstream.destroy(new RouteError('BACKEND_PROBE_TIMEOUT')), 5000);
    upstream.once('close', () => clearTimeout(timer));
    upstream.once('error', reject);
    upstream.end(data);
  });
}

export async function startRouter(options: RouterOptions): Promise<RunningRouter> {
  if (!/^[a-f0-9]{64}$/.test(options.key)) throw new RouteError('PRIVATE_ROUTER_KEY_REQUIRED');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new RouteError('INVALID_PORT');
  await mkdir(dirname(options.statePath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(options.controlSocket), { recursive: true, mode: 0o700 });
  const empty: Registry = { schema: 1, epoch: 0, active: null, previous: null, legacyOwner: null, generations: [] };
  let state: Registry;
  try {
    if ((await lstat(options.statePath)).isSymbolicLink()) throw new RouteError('UNSAFE_REGISTRY');
    state = parsed(registrySchema, JSON.parse(await readFile(options.statePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = empty;
  }
  const generation = (id: string | null): Generation => {
    const result = state.generations.find(item => item.id === id);
    if (!result) throw new RouteError('GENERATION_UNKNOWN', 503);
    return result;
  };
  for (const id of [state.active, state.previous, state.legacyOwner]) if (id !== null) generation(id);
  if (new Set(state.generations.map(item => item.id)).size !== state.generations.length) throw new RouteError('CORRUPT_REGISTRY');
  const inFlight = new Map<string, number>();
  const exchanges = new Map<string, Set<Exchange>>();
  const retiring = new Set<string>();
  let serial: Promise<unknown> = Promise.resolve();
  let admitted = 0;
  let closed = false;
  const expectedPolicy = policyFingerprint(options.config);
  const persist = options.persist ?? atomicJobJson;
  const commit = async (next: Registry): Promise<void> => {
    try { await persist(options.statePath, next); state = next; }
    catch {
      // rename may have succeeded before directory fsync failed. Reconcile the
      // visible epoch, never continue with a different on-disk routing decision.
      try { state = parsed(registrySchema, JSON.parse(await readFile(options.statePath, 'utf8'))); }
      catch { state = { ...state, active: null }; }
      throw new RouteError('REGISTRY_COMMIT_UNCERTAIN', 503);
    }
  };
  const probe = async (item: Generation): Promise<Record<string, unknown>> => {
    if (item.policyFingerprint !== expectedPolicy) throw new RouteError('INCOMPATIBLE_POLICY');
    if (item.legacy) {
      const result = await upstreamJson(item, '/mcp', options.key, options.config.http.token,
        { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'system.info', arguments: {} } });
      const runtime = object(object(object(result.result).structuredContent).runtime);
      for (const field of ['pid', 'startedAt', 'configFingerprint'] as const) {
        if (runtime[field] !== item.legacy[field]) throw new RouteError('LEGACY_INCARNATION_CHANGED');
      }
      if (runtime.release !== item.revision) throw new RouteError('BACKEND_REVISION_MISMATCH');
      return { runtime, resources: null, legacy: true };
    }
    const result = await upstreamJson(item, '/__hotswap', options.key, options.config.http.token);
    if (result.instanceId !== item.id || result.routingAbi !== routingAbi || result.jobsAbi !== jobsAbi
      || result.policyFingerprint !== expectedPolicy || result.fenced !== false
      || object(result.runtime).release !== item.revision) throw new RouteError('BACKEND_IDENTITY_OR_ABI_MISMATCH');
    return result;
  };
  const snapshot = () => ({ ...state, routerPid: process.pid,
    generations: state.generations.map(item => ({ ...item, inFlight: inFlight.get(item.id) ?? 0,
      ownership: item.legacy ? 'legacy-retained' : 'query-backend-inventory' })) });
  const cas = (epoch: unknown) => { if (epoch !== state.epoch) throw new RouteError('STALE_ROUTING_EPOCH'); };
  const control = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/status') { json(res, 200, snapshot()); return; }
      if (req.method !== 'POST') throw new RouteError('CONTROL_METHOD_NOT_ALLOWED', 405);
      const input = object(JSON.parse((await readBytes(req, 64 * 1024)).toString('utf8')));
      const change = async () => {
        if (req.url === '/register') {
          const item = parsed(generationSchema, input.generation);
          const listening = server.address();
          if (!listening || typeof listening === 'string' || Number(loopbackUrl(item.url).port) === listening.port) {
            throw new RouteError('ROUTING_LOOP_REFUSED', 409);
          }
          cas(input.expectedEpoch);
          await probe(item);
          const existing = state.generations.find(g => g.id === item.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(item)) throw new RouteError('INCARNATION_ALREADY_REGISTERED');
          if (!existing) {
            if (state.generations.length >= 128) throw new RouteError('RETAINED_GENERATION_LIMIT');
            if (item.legacy && state.legacyOwner) throw new RouteError('LEGACY_OWNER_ALREADY_REGISTERED');
            await commit({ ...state, epoch: state.epoch + 1, generations: [...state.generations, item],
              legacyOwner: item.legacy ? item.id : state.legacyOwner });
          }
        } else if (req.url === '/activate' || req.url === '/rollback') {
          cas(input.expectedEpoch);
          const selected = req.url === '/rollback' ? state.previous : parsed(idSchema, input.id);
          const item = generation(selected);
          await probe(item);
          if (state.active !== item.id) await commit({ ...state, epoch: state.epoch + 1, previous: state.active, active: item.id });
        } else if (req.url === '/inventory') {
          const item = generation(parsed(idSchema, input.id));
          json(res, 200, await probe(item)); return;
        } else if (req.url === '/retire') {
          cas(input.expectedEpoch);
          const item = generation(parsed(idSchema, input.id));
          if (item.id === state.active || item.id === state.previous || item.legacy || (inFlight.get(item.id) ?? 0) > 0) {
            throw new RouteError('GENERATION_HAS_OWNERS');
          }
          retiring.add(item.id);
          try {
            // The backend atomically fences new admissions only after its actual
            // operations and adapter-owned resources are empty. No idle timer.
            const result = await upstreamJson(item, '/__hotswap/retire', options.key, options.config.http.token, {});
            if (result.instanceId !== item.id || result.fenced !== true) throw new RouteError('RETIREMENT_NOT_CONFIRMED');
            if ((inFlight.get(item.id) ?? 0) !== 0) throw new RouteError('GENERATION_HAS_OWNERS');
            await commit({ ...state, epoch: state.epoch + 1, generations: state.generations.filter(g => g.id !== item.id) });
          } finally { retiring.delete(item.id); }
        } else throw new RouteError('CONTROL_NOT_FOUND', 404);
        json(res, 200, snapshot());
      };
      const pending = serial.catch(() => {}).then(change);
      serial = pending;
      await pending;
    })().catch(error => json(res, error instanceof RouteError ? error.status : 400,
      { error: error instanceof RouteError ? error.code : 'INVALID_CONTROL_INPUT' }));
  });

  const wrap = (id: string, kind: string, handle: string): string => {
    const value = `hs1.${id}.${kind}.${Buffer.from(handle).toString('base64url')}`;
    return `${value}.${createHmac('sha256', options.key).update(value).digest('base64url')}`;
  };
  const unwrap = (value: string, kind: string): { owner: Generation; handle: string } => {
    if (!value.startsWith('hs1.')) {
      if (!state.legacyOwner || !/^(?:app|rec)_[a-f0-9]{32}$/.test(value) || !value.startsWith(kind + '_')) {
        throw new RouteError('HANDLE_OWNER_UNKNOWN', 404);
      }
      return { owner: generation(state.legacyOwner), handle: value };
    }
    const fields = value.split('.');
    const [version, id, encodedKind, encoded, mac] = fields;
    if (fields.length !== 5 || version !== 'hs1' || !id || !encoded || encodedKind !== kind || value.length > 2048
      || !equalSecret(mac, createHmac('sha256', options.key).update(fields.slice(0, 4).join('.')).digest('base64url'))) {
      throw new RouteError('INVALID_OWNED_HANDLE', 400);
    }
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!new RegExp(`^${kind}_[a-f0-9]{32}$`).test(raw)) throw new RouteError('INVALID_OWNED_HANDLE', 400);
    return { owner: generation(id), handle: raw };
  };
  const validate = validators(options.config);
  const server = createServer((req, res) => {
    void (async () => {
      if (!validate.host(req, res) || !validate.origin(req, res)) return;
      const pathname = req.url?.split('?')[0];
      if (!['/mcp', '/healthz', '/readyz', '/metrics'].includes(pathname ?? '')) throw new RouteError('NOT_FOUND', 404);
      if (pathname === '/mcp' && !requireBearer(req, res, options.config.http.token)) return;
      if (pathname !== '/mcp' && req.method !== 'GET') throw new RouteError('METHOD_NOT_ALLOWED', 405);
      if (pathname === '/mcp' && !['GET', 'POST', 'DELETE'].includes(req.method ?? '')) throw new RouteError('METHOD_NOT_ALLOWED', 405);
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new RouteError('ENCODED_BODY_UNSUPPORTED', 415);
      if (admitted >= 256 || closed) throw new RouteError('ROUTER_OVERLOADED', 503);
      admitted += 1;
      let owned: Generation | undefined;
      let counted = false;
      let requestId: unknown = null;
      let exchange: Exchange | undefined;
      let cancelKey: string | undefined;
      let originalHandle: string | undefined;
      let tool: unknown;
      try {
        let body: Record<string, unknown> | undefined;
        if (req.method === 'POST') {
          try { body = object(JSON.parse((await readBytes(req)).toString('utf8'))); }
          catch (error) { throw error instanceof RouteError ? error : new RouteError('INVALID_JSON_RPC', 400); }
          requestId = body.id;
          if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') throw new RouteError('INVALID_JSON_RPC', 400);
          if (body.method === 'notifications/cancelled') {
            const key = cancellationKey(req, object(body.params).requestId);
            const matches = key ? exchanges.get(key) : undefined;
            if (matches && matches.size > 1) throw new RouteError('AMBIGUOUS_CANCELLATION', 409);
            for (const target of matches ?? []) { target.cancelled = true; target.upstream.destroy(new RouteError('CANCELLED')); }
            res.writeHead(202); res.end(); return;
          }
          if (body.method === 'tools/call') {
            const params = object(body.params); tool = params.name;
            if (tool === 'app.close' || tool === 'screen.record.stop') {
              const args = object(params.arguments);
              if (typeof args.handle !== 'string') throw new RouteError('INVALID_OWNED_HANDLE', 400);
              originalHandle = args.handle;
              const result = unwrap(args.handle, tool === 'app.close' ? 'app' : 'rec');
              owned = result.owner; args.handle = result.handle;
            }
          }
        }
        owned ??= generation(state.active);
        if (retiring.has(owned.id)) throw new RouteError('GENERATION_RETIRING', 409);
        const selected = owned;
        inFlight.set(selected.id, (inFlight.get(selected.id) ?? 0) + 1);
        counted = true;
        cancelKey = body ? cancellationKey(req, requestId) : undefined;
        if (body && (typeof requestId === 'string' || typeof requestId === 'number')) body.id = randomUUID();
        const wireId = body?.id;
        const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
        const headers = forwardHeaders(req.headers);
        headers['x-mcp-route-key'] = options.key;
        headers['x-mcp-route-instance'] = selected.id;
        if (data) headers['content-length'] = data.length;
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
          const upstream = request(new URL(req.url ?? '/mcp', selected.url), { method: req.method ?? 'GET', headers, agent: false }, resolve);
          exchange = { generation: selected.id, upstream, cancelled: false };
          if (cancelKey) {
            const group = exchanges.get(cancelKey) ?? new Set<Exchange>();
            group.add(exchange); exchanges.set(cancelKey, group);
          }
          const disconnect = () => { if (!res.writableFinished) upstream.destroy(new RouteError('CLIENT_DISCONNECTED')); };
          res.once('close', disconnect);
          upstream.once('close', () => res.off('close', disconnect));
          upstream.once('error', reject);
          if (res.destroyed) upstream.destroy(new RouteError('CLIENT_DISCONNECTED'));
          else upstream.end(data);
        });
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy();
          throw new RouteError('UNSUPPORTED_BACKEND_ENCODING', 502);
        }
        let replied = false;
        const rewrite = (result: Record<string, unknown>): Record<string, unknown> => {
          if ('id' in result && ('result' in result || 'error' in result)) {
            if (wireId !== undefined && result.id !== wireId) throw new RouteError('BACKEND_REPLY_ID_MISMATCH', 502);
            result.id = requestId; replied = true;
          }
          if (result.result && typeof result.result === 'object') {
            const payload = object(result.result);
            if (!payload.isError && payload.structuredContent && typeof payload.structuredContent === 'object') {
              const structured = object(payload.structuredContent);
              if (typeof structured.handle === 'string' && ['app.launch', 'app.close', 'screen.record.start', 'screen.record.stop'].includes(String(tool))) {
                const raw = structured.handle;
                const handle = originalHandle ?? wrap(selected.id, String(tool).startsWith('app.') ? 'app' : 'rec', raw);
                structured.handle = handle;
                for (const part of Array.isArray(payload.content) ? payload.content : []) {
                  if (part?.type !== 'text' || typeof part.text !== 'string') continue;
                  try { const text = object(JSON.parse(part.text)); if (text.handle === raw) { text.handle = handle; part.text = JSON.stringify(text); } } catch { /* Compact non-JSON text stays unchanged. */ }
                }
              }
            }
          }
          return result;
        };
        const responseHeaders = forwardHeaders(response.headers);
        responseHeaders['x-mcp-generation'] = selected.id;
        if (body && response.headers['content-type']?.includes('text/event-stream')) {
          const parser = new SseRewriter(rewrite);
          const writeFrame = async (frame: string) => {
            if (res.destroyed) throw new RouteError('CLIENT_DISCONNECTED');
            if (!res.headersSent) res.writeHead(response.statusCode ?? 502, responseHeaders);
            if (!res.write(frame)) await new Promise<void>(resolveDrain => {
              const finish = () => { res.off('drain', finish); res.off('close', finish); resolveDrain(); };
              res.once('drain', finish); res.once('close', finish);
            });
          };
          for await (const chunk of response) for (const frame of parser.push(chunk as Buffer)) await writeFrame(frame);
          for (const frame of parser.end()) await writeFrame(frame);
          if (wireId !== undefined && !replied && response.statusCode === 200) throw new RouteError('BACKEND_REPLY_MISSING', 502);
          if (!res.destroyed) { if (!res.headersSent) res.writeHead(response.statusCode ?? 502, responseHeaders); res.end(); }
        } else {
          let output = await readBytes(response);
          if (body && output.length && response.statusCode === 200) {
            output = Buffer.from(JSON.stringify(rewrite(object(JSON.parse(output.toString('utf8'))))));
          }
          if (wireId !== undefined && !replied && response.statusCode === 200) throw new RouteError('BACKEND_REPLY_MISSING', 502);
          responseHeaders['content-length'] = output.length;
          if (!res.destroyed) { res.writeHead(response.statusCode ?? 502, responseHeaders); res.end(output); }
        }
      } catch (error) {
        const code = exchange?.cancelled ? 'CANCELLED' : exchange ? 'OUTCOME_UNKNOWN' : error instanceof RouteError ? error.code : 'ROUTING_FAILED';
        if (res.headersSent) res.destroy();
        else rpcError(res, exchange ? 502 : error instanceof RouteError ? error.status : 500, code, requestId);
      } finally {
        admitted -= 1;
        if (owned && counted) inFlight.set(owned.id, Math.max(0, (inFlight.get(owned.id) ?? 1) - 1));
        if (cancelKey && exchange) {
          const group = exchanges.get(cancelKey); group?.delete(exchange);
          if (group?.size === 0) exchanges.delete(cancelKey);
        }
      }
    })().catch(error => rpcError(res, error instanceof RouteError ? error.status : 500,
      error instanceof RouteError ? error.code : 'ROUTING_FAILED'));
  });
  server.headersTimeout = 15_000;
  control.headersTimeout = 5_000;
  control.requestTimeout = 10_000;
  // Never unlink a potentially live controller's socket to start a second owner.
  try { await lstat(options.controlSocket); throw new RouteError('CONTROL_SOCKET_ALREADY_EXISTS'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    control.listen(options.controlSocket); await once(control, 'listening');
    await chmod(options.controlSocket, 0o600);
    server.listen(options.port, '127.0.0.1'); await once(server, 'listening');
  } catch (error) { control.close(); if (control.listening) await unlink(options.controlSocket).catch(() => {}); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new RouteError('ROUTER_LISTENER_MISSING');
  if (state.generations.some(item => Number(loopbackUrl(item.url).port) === address.port)) {
    server.close(); control.close(); throw new RouteError('REGISTRY_ROUTING_LOOP_REFUSED');
  }
  return { server, control, endpoint: `http://127.0.0.1:${address.port}`, async close() {
    closed = true;
    // Only explicit router maintenance calls this. Backend activation never does.
    await Promise.all([server, control].map(item => new Promise<void>((resolve, reject) => {
      item.close(error => error ? reject(error) : resolve()); item.closeIdleConnections();
    })));
    await unlink(options.controlSocket).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  } };
}
