import { readFileSync } from 'node:fs';
import { instanceId, equalSecret, routingAbi, jobsAbi, policyFingerprint } from './hotswap/identity.js';
import { runtimeIdentity } from './diagnostics.js';
import { diagnosticId, trace, withDiagnosticRequest } from './diagnostics.js';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import type { ComputerAdapter } from './adapter/computer-adapter.js';
import { RoutingComputerAdapter } from './adapter/routing-computer-adapter.js';
import type { ChatGptMcpConfig } from './config.js';
import { ConcurrencyController } from './concurrency.js';
import { createComputerMcpServerFactory } from './server.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const HTTP_SHUTDOWN_GRACE_MS = 2_000;

export interface RunningHttpServer {
  server: NodeHttpServer;
  endpoint: string;
  close(): Promise<void>;
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export function requireBearer(req: IncomingMessage, res: ServerResponse, token: string | undefined): boolean {
  if (token === undefined) return true;
  if (tokenMatches(req.headers.authorization, token)) return true;
  writeJson(
    res,
    401,
    { error: 'unauthorized' },
    { 'WWW-Authenticate': 'Bearer' },
  );
  return false;
}

export function validators(config: Readonly<ChatGptMcpConfig>): {
  host: (req: IncomingMessage, res: ServerResponse) => boolean;
  origin: (req: IncomingMessage, res: ServerResponse) => boolean;
} {
  if (isLoopback(config.http.host)) {
    return {
      host: config.http.allowedHosts.length > 0
        ? hostHeaderValidation([...config.http.allowedHosts])
        : localhostHostValidation(),
      origin: config.http.allowedOrigins.length > 0
        ? originValidation([...config.http.allowedOrigins])
        : localhostOriginValidation(),
    };
  }

  if (config.http.allowedHosts.length === 0) {
    throw new Error('Non-loopback HTTP binding requires http.allowedHosts / CHATGPT_MCP_ALLOWED_HOSTS.');
  }

  return {
    host: hostHeaderValidation([...config.http.allowedHosts]),
    origin: originValidation(
      config.http.allowedOrigins.length > 0
        ? [...config.http.allowedOrigins]
        : [...config.http.allowedHosts],
    ),
  };
}

export function createComputerHttpServer(
  config: Readonly<ChatGptMcpConfig>,
  adapter: ComputerAdapter = new RoutingComputerAdapter(config),
  concurrency: ConcurrencyController = new ConcurrencyController(config.concurrency, config.execution.kubernetes.maxConcurrent),
): { server: NodeHttpServer; closeHandler(): Promise<void> } {
  const handler = createMcpHandler(createComputerMcpServerFactory(config, adapter, concurrency), {
    legacy: 'stateless',
    responseMode: 'json',
  });
  const nodeHandler = toNodeHandler(handler);
  const validate = validators(config);
  const keyPath = process.env.CHATGPT_MCP_ROUTER_KEY_FILE;
  const routerKey = keyPath ? readFileSync(keyPath, 'utf8').trim() : undefined;
  let fenced = false;
  let exchanges = 0;

  const server = createServer((req, res) => {
    if (!validate.host(req, res) || !validate.origin(req, res)) return;

    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
    if (pathname === '/__hotswap' || pathname === '/__hotswap/retire') {
      if (!routerKey || !equalSecret(req.headers['x-mcp-route-key'], routerKey)) {
        writeJson(res, 403, { error: 'router_auth_required' }); return;
      }
      const resources = adapter.ownedResources?.() ?? null;
      const work = concurrency.snapshot();
      const busy = exchanges > 0 || work.active.total > 0 || work.queued.total > 0;
      if (pathname.endsWith('/retire')) {
        if (req.method !== 'POST') { writeJson(res, 405, { error: 'method_not_allowed' }); return; }
        if (req.headers['x-mcp-route-instance'] !== instanceId || busy || !resources || resources.applications || resources.recordings) {
          writeJson(res, 409, { error: 'generation_has_owners' }); return;
        }
        fenced = true;
      } else if (req.method !== 'GET') { writeJson(res, 405, { error: 'method_not_allowed' }); return; }
      writeJson(res, 200, { instanceId, routingAbi, jobsAbi, policyFingerprint: policyFingerprint(config),
        runtime: runtimeIdentity(config), resources, exchanges, activeCalls: work.active.total, queuedCalls: work.queued.total, fenced });
      return;
    }
    if (pathname === '/healthz') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return;
      }
      writeJson(res, 200, { ok: true, service: '@platform-modules/chatgpt-mcp' });
      return;
    }

    if (pathname === '/readyz' || pathname === '/metrics') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return;
      }
      const snapshot = concurrency.snapshot();
      if (pathname === '/readyz') {
        const ready = snapshot.status !== 'overloaded';
        writeJson(res, ready ? 200 : 503, { ok: ready, service: '@platform-modules/chatgpt-mcp', concurrency: snapshot });
      } else {
        writeJson(res, 200, { service: '@platform-modules/chatgpt-mcp', concurrency: snapshot, ...(adapter.executionMetrics === undefined ? {} : { execution: adapter.executionMetrics() }) });
      }
      return;
    }

    if (pathname !== '/mcp') {
      writeJson(res, 404, { error: 'not_found' });
      return;
    }

    const expectedInstance = req.headers['x-mcp-route-instance'];
    if (expectedInstance !== undefined && (expectedInstance !== instanceId || !routerKey || !equalSecret(req.headers['x-mcp-route-key'], routerKey))) {
      writeJson(res, 409, { error: 'generation_identity_mismatch' }); return;
    }
    if (fenced) { writeJson(res, 503, { error: 'generation_retired' }); return; }
    if (!requireBearer(req, res, config.http.token)) return;
    if (req.method === undefined) {
      writeJson(res, 400, { error: 'missing_method' });
      return;
    }

    // Node's IncomingMessage types model `method` as optional, while the MCP
    // node bridge models it as required. A real server request has a method;
    // the guard above makes this cast the explicit type seam between the two.
    const transportAbort = new AbortController();
    const disconnect = () => { if (!res.writableFinished) transportAbort.abort(); };
    res.once('close', disconnect);
    if (res.destroyed) transportAbort.abort();
    exchanges += 1;
    withDiagnosticRequest(() => {
      const requestId = diagnosticId();
      let delivered = false;
      res.once('finish', () => { delivered = true; trace('http_response_finished', { requestId, status: res.statusCode }); });
      res.once('close', () => { if (!delivered) trace('http_response_interrupted', { requestId }); });
      void Promise.resolve().then(() => nodeHandler(req as Parameters<typeof nodeHandler>[0], res)).catch(() => {
        trace('http_handler_failed', { requestId });
        if (!res.headersSent && !res.destroyed) writeJson(res, 500, { error: 'backend_handler_failure', diagnosticId: requestId });
        else if (!res.destroyed) res.end();
      }).finally(() => { res.off('close', disconnect); exchanges -= 1; });
    }, transportAbort.signal);
  });

  return { server, closeHandler: handler.close };
}

export async function startComputerHttpServer(
  config: Readonly<ChatGptMcpConfig>,
  adapter: ComputerAdapter = new RoutingComputerAdapter(config),
): Promise<RunningHttpServer> {
  const { server, closeHandler } = createComputerHttpServer(config, adapter);
  server.listen(config.http.port, config.http.host);
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeHandler();
    throw new Error('HTTP server did not expose a TCP address.');
  }

  const endpoint = `http://${hostForUrl(config.http.host)}:${address.port}/mcp`;
  let closed = false;
  return {
    server,
    endpoint,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      server.closeIdleConnections();
      const forceTimer = setTimeout(() => server.closeAllConnections(), HTTP_SHUTDOWN_GRACE_MS);
      forceTimer.unref();
      try {
        await Promise.all([serverClosed, closeHandler()]);
      } finally {
        clearTimeout(forceTimer);
      }
    },
  };
}
