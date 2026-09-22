import { close as closeInspector, url as inspectorUrl } from 'node:inspector';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { request, Server, type IncomingMessage, type ServerResponse } from 'node:http';
import * as z from 'zod/v4';
import { processIdentity } from '../execution/job-store.js';
import { equalSecret } from './identity.js';
import { forwardHeaders, json, loopbackUrl, RouteError } from './wire.js';

const marker = Symbol.for('platform-modules.chatgpt-mcp.ingress-bridge.v1');
const schema = z.object({
  schema: z.literal(1), id: z.string().regex(/^[a-f0-9]{32}$/),
  port: z.number().int().min(1).max(65535), routerUrl: z.string(),
  expectedPid: z.number().int().positive(), expectedIdentity: z.string().min(1),
  expectedExecutable: z.string().startsWith('/'),
  expectedCommandSha256: z.string().regex(/^[a-f0-9]{64}$/),
  keyFile: z.string().startsWith('/'), configPath: z.string().startsWith('/'),
}).strict();
export type BridgeConfiguration = z.infer<typeof schema>;
export interface PreparedBridge {
  settings: BridgeConfiguration;
  key: string;
  fingerprint: string;
  legacyAvailable: boolean;
  adoptionInspectorUrl?: string;
}
interface Receipt { bridgeAbi: 1; pid: number; generation: string; legacyAvailable: boolean; port: number; unchanged: boolean }
interface Installed { fingerprint: string; listener: (req: IncomingMessage, res: ServerResponse) => void; receipt: Receipt }

export async function readPrivateFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new RouteError('PRIVATE_BRIDGE_CONFIGURATION_REQUIRED');
  }
  return readFile(path, 'utf8');
}
export async function loadBridgeSettings(path: string): Promise<BridgeConfiguration> {
  const result = schema.safeParse(JSON.parse(await readPrivateFile(path)));
  if (!result.success) throw new RouteError('INVALID_BRIDGE_CONFIGURATION');
  return result.data;
}

export async function prepareBridge(path: string, startup = false): Promise<PreparedBridge> {
  if (process.platform !== 'linux') throw new RouteError('LIVE_ADOPTION_REQUIRES_LINUX');
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  if (major < 22 || major > 26 || (major === 22 && minor < 13)) throw new RouteError('UNVERIFIED_NODE_ADOPTION_VERSION');
  const settings = await loadBridgeSettings(path);
  const target = loopbackUrl(settings.routerUrl);
  if (Number(target.port) === settings.port) throw new RouteError('INGRESS_ROUTING_LOOP');
  const identity = await processIdentity(process.pid);
  const legacyAvailable = process.pid === settings.expectedPid && identity === settings.expectedIdentity;
  if (!startup && !legacyAvailable) throw new RouteError('LEGACY_PROCESS_IDENTITY_CHANGED');
  const key = (await readPrivateFile(settings.keyFile)).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new RouteError('PRIVATE_ROUTER_KEY_REQUIRED');
  return { settings, key, legacyAvailable,
    fingerprint: createHash('sha256').update(JSON.stringify(settings)).update(key).digest('hex') };
}

/** Synchronous event-listener replacement is the adoption linearization point.
 * Already-dispatched request callbacks, bodies, responses and sockets are untouched.
 * This function must not await, close, unref or relisten on the existing server.
 */
export function installBridge(server: Server, prepared: PreparedBridge): Receipt {
  const previous = Object.getOwnPropertyDescriptor(server, marker)?.value as Installed | undefined;
  if (previous) {
    if (previous.fingerprint !== prepared.fingerprint || server.rawListeners('request').length !== 1
      || server.rawListeners('request')[0] !== previous.listener) throw new RouteError('INGRESS_ALREADY_OWNED');
    return { ...previous.receipt, unchanged: true };
  }
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port !== prepared.settings.port) {
    throw new RouteError('ENROLLED_LISTENER_NOT_FOUND');
  }
  const listeners = server.rawListeners('request');
  const original = listeners[0] as ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  if (listeners.length !== 1 || typeof original !== 'function' || !Object.isExtensible(server)) {
    throw new RouteError('UNSUPPORTED_LEGACY_LISTENER_SHAPE');
  }
  const receipt: Receipt = { bridgeAbi: 1, pid: process.pid, generation: prepared.settings.id,
    legacyAvailable: prepared.legacyAvailable, port: prepared.settings.port, unchanged: false };
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    try {
      const internal = equalSecret(req.headers['x-mcp-route-key'], prepared.key);
      if (internal && req.url === '/__hotswap/bridge' && req.method === 'GET') {
        json(res, 200, { ...receipt, inspectorOpen: inspectorUrl() !== undefined }); return;
      }
      if (internal && req.url === '/__hotswap/bridge/finalize-adoption' && req.method === 'POST') {
        // Only the exact debugger owned by this one-time adoption may be closed.
        // The controller first finishes its WebSocket disconnect: calling the
        // synchronous inspector.close() before that can freeze the event loop.
        if (!prepared.adoptionInspectorUrl || inspectorUrl() !== prepared.adoptionInspectorUrl
          || req.headers['x-mcp-route-instance'] !== prepared.settings.id) {
          json(res, 409, { error: 'ADOPTION_INSPECTOR_NOT_OWNED' }); return;
        }
        delete prepared.adoptionInspectorUrl;
        closeInspector();
        json(res, 200, { ...receipt, inspectorOpen: inspectorUrl() !== undefined }); return;
      }
      if (internal && req.headers['x-mcp-route-instance'] !== undefined) {
        if (!prepared.legacyAvailable || req.headers['x-mcp-route-instance'] !== prepared.settings.id) {
          json(res, 409, { error: 'LEGACY_GENERATION_GONE' }); return;
        }
        // This authenticated bypass addresses only the captured old handler.
        // It is never a caller-controlled choice of upstream port or module.
        for (const name of Object.keys(req.headers)) if (name.startsWith('x-mcp-route-')) delete req.headers[name];
        original.call(server, req, res);
        return;
      }
      const destination = new URL(req.url ?? '/', prepared.settings.routerUrl);
      if (!req.url?.startsWith('/') || destination.origin !== new URL(prepared.settings.routerUrl).origin
        || !['/mcp', '/healthz', '/readyz', '/metrics'].includes(destination.pathname)) {
        json(res, 404, { error: 'NOT_FOUND' }); return;
      }
      const headers = forwardHeaders(req.headers);
      // Preserve the original authority and Origin. The persistent router owns
      // the same configured Host/Origin checks; the private legacy bypass calls
      // its captured original handler, which also keeps its original checks.
      // Importing the MCP server here pulls SDK module initialization into a
      // one-time inspector attachment and is deliberately avoided.
      if (req.headers.host) headers.host = req.headers.host;
      // Unlike the MCP-aware router, this bridge never parses or rewrites bodies.
      if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
      if (req.headers['content-encoding']) headers['content-encoding'] = req.headers['content-encoding'];
      const upstream = request(destination, { method: req.method ?? 'GET', headers, agent: false }, response => {
        const responseHeaders = forwardHeaders(response.headers);
        if (response.headers['content-length']) responseHeaders['content-length'] = response.headers['content-length'];
        if (response.headers['content-encoding']) responseHeaders['content-encoding'] = response.headers['content-encoding'];
        if (res.destroyed) { response.destroy(); return; }
        res.writeHead(response.statusCode ?? 502, responseHeaders);
        response.once('error', () => res.destroy());
        response.pipe(res);
      });
      const disconnect = () => { if (!res.writableFinished) upstream.destroy(); };
      const abort = () => upstream.destroy();
      res.once('close', disconnect); req.once('aborted', abort); req.once('error', abort);
      upstream.once('close', () => { res.off('close', disconnect); req.off('aborted', abort); req.off('error', abort); });
      upstream.once('error', () => {
        if (res.headersSent) res.destroy();
        else json(res, 502, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'OUTCOME_UNKNOWN', data: { retryable: false } } });
      });
      if (res.destroyed || req.destroyed) upstream.destroy();
      else req.pipe(upstream);
    } catch {
      json(res, 502, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'INGRESS_FAILURE', data: { retryable: false } } });
    }
  };
  server.removeListener('request', original);
  try {
    server.on('request', listener);
    Object.defineProperty(server, marker, { value: { fingerprint: prepared.fingerprint, listener, receipt } satisfies Installed });
  } catch {
    server.removeListener('request', listener);
    server.on('request', original);
    throw new RouteError('INGRESS_INSTALLATION_REVERTED');
  }
  return receipt;
}

/** Narrow one-time compatibility seam for already-running enrolled Node servers. */
export async function adopt(path: string): Promise<Receipt> {
  const prepared = await prepareBridge(path);
  const ownedInspector = inspectorUrl();
  if (ownedInspector) prepared.adoptionInspectorUrl = ownedInspector;
  const handles = (process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })._getActiveHandles?.();
  if (!handles) throw new RouteError('UNSUPPORTED_NODE_LISTENER_DISCOVERY');
  const servers = handles.filter((value): value is Server => {
    if (!(value instanceof Server)) return false;
    const address = value.address();
    return !!address && typeof address !== 'string' && address.address === '127.0.0.1' && address.port === prepared.settings.port;
  });
  if (servers.length !== 1) throw new RouteError('ENROLLED_LISTENER_NOT_UNIQUE');
  return installBridge(servers[0]!, prepared);
}
