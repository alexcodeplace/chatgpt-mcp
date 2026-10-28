import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server, createMcpHandler, type CallToolRequest, type CallToolResult, type ServerContext, type Tool } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { parseConfig } from '../src/config.js';
import { startComputerHttpServer } from '../src/http-server.js';
import { McpProxy, exposedToolName } from '../src/proxy/manager.js';
import { resolveHeaders } from '../src/proxy/transport.js';

const echo: Tool = {
  name: 'inspect_scene', description: 'Inspect a scene', title: 'Scene inspection',
  inputSchema: {
    type: 'object', required: ['scene'], additionalProperties: false,
    properties: { scene: { type: 'string', minLength: 1 }, options: { $ref: '#/$defs/options' } },
    $defs: { options: { type: 'object', properties: { depth: { type: 'integer', minimum: 1 } }, additionalProperties: false } },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

type FixtureOptions = {
  tools?: Tool[];
  call?: (params: CallToolRequest['params'], ctx: ServerContext) => Promise<CallToolResult>;
  pages?: boolean;
  cycle?: boolean;
};
async function upstream(t: TestContext, options: FixtureOptions = {}) {
  const state = { tools: options.tools ?? [echo], calls: [] as CallToolRequest['params'][], lists: 0, headers: [] as Array<string | undefined> };
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', request => {
      state.lists++;
      if (options.cycle) return { tools: [], nextCursor: 'same' };
      if (options.pages && !request.params?.cursor) return { tools: [state.tools[0]!], nextCursor: 'page2' };
      return { tools: options.pages ? state.tools.slice(1) : state.tools };
    });
    server.setRequestHandler('tools/call', async (request, ctx) => {
      state.calls.push(request.params);
      return options.call ? options.call(request.params, ctx) : {
        content: [{ type: 'text', text: JSON.stringify(request.params.arguments ?? {}) }],
        structuredContent: request.params.arguments ?? {},
      };
    });
    return server;
  }, { legacy: 'stateless', responseMode: 'json' });
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((req, res) => {
    state.headers.push(req.headers.authorization);
    void nodeHandler(req as Parameters<typeof nodeHandler>[0], res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await handler.close();
  });
  return { url: `http://127.0.0.1:${address.port}/mcp`, state };
}

async function downstream(t: TestContext, upstreams: Record<string, unknown>, proxyOptions: Record<string, unknown> = {}, modern = false) {
  const config = parseConfig({ logLevel: 'silent', proxy: { upstreams, ...proxyOptions } });
  const server = await startComputerHttpServer({ ...config, http: { ...config.http, port: 0 } });
  const client = new Client({ name: 'proxy-test', version: '1' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint)));
  return { client, server };
}

function errorCode(result: CallToolResult): string {
  assert.equal(result.isError, true);
  const first = result.content[0];
  assert.ok(first?.type === 'text');
  return (JSON.parse(first.text) as { error: { code: string } }).error.code;
}

test('proxy is disabled by default and rejects ambiguous or unsafe configuration', () => {
  assert.deepEqual(parseConfig({}).proxy.upstreams, {});
  for (const name of ['system', 'fs', 'proxy', '__proto__', 'Bad.Name']) {
    assert.throws(() => parseConfig({ proxy: { upstreams: { [name]: { transport: 'stdio', command: 'node' } } } }), name);
  }
  for (const config of [
    { transport: 'http', url: 'https://user:password@example.com/mcp' },
    { transport: 'http', url: 'http://example.com/mcp' },
    { transport: 'http', url: 'file:///tmp/mcp' },
    { transport: 'http', url: 'https://example.com', headers: { Host: 'elsewhere' } },
    { transport: 'http', url: 'https://example.com', headers: { Authorization: 'a', authorization: 'b' } },
    { transport: 'stdio', command: 'node', typo: true },
    { transport: 'stdio', command: 'node', cwd: 'relative' },
  ]) assert.throws(() => parseConfig({ proxy: { upstreams: { godot: config } } }));
  assert.doesNotThrow(() => parseConfig({ proxy: { upstreams: { godot: { transport: 'http', url: 'http://192.0.2.1/mcp', allowInsecureHttp: true } } } }));
});

test('namespaces are deterministic, collision-resistant and bounded', () => {
  assert.equal(exposedToolName('godot', 'inspect_scene'), 'godot.inspect_scene');
  const name = 'x'.repeat(128);
  assert.equal(exposedToolName('godot', name).length, 128);
  assert.equal(exposedToolName('godot', name), exposedToolName('godot', name));
  assert.notEqual(exposedToolName('godot', name), exposedToolName('github', name));
  assert.throws(() => exposedToolName('godot', 'invalid name'));
});

for (const modern of [false, true]) test(`HTTP proxy preserves raw schemas, arguments and native tools (${modern ? 'modern' : 'legacy'} downstream)`, async t => {
  const source = await upstream(t);
  const { client } = await downstream(t, { godot: { transport: 'http', url: source.url } }, {}, modern);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'system.info'));
  const proxied = tools.find(tool => tool.name === 'godot.inspect_scene');
  assert.deepEqual(proxied?.inputSchema, echo.inputSchema);
  assert.deepEqual(proxied?.annotations, echo.annotations);
  const args = { scene: 'res://world.tscn', options: { depth: 3 } };
  const result = await client.callTool({ name: 'godot.inspect_scene', arguments: args });
  assert.deepEqual(result.structuredContent, args);
  assert.deepEqual(source.state.calls[0]?.arguments, args);
  assert.equal((await client.callTool({ name: 'system.info', arguments: {} })).isError, undefined);
  await client.callTool({ name: 'godot.inspect_scene', arguments: { scene: 'again' } });
  assert.equal(source.state.lists, 1, 'requests reuse one cached upstream catalogue');
});

test('invalid upstream arguments fail validation before forwarding', async t => {
  const source = await upstream(t);
  const { client } = await downstream(t, { godot: { transport: 'http', url: source.url } });
  const result = await client.callTool({ name: 'godot.inspect_scene', arguments: { scene: 'ok', options: { depth: 0 } } });
  assert.equal(result.isError, true);
  assert.equal(source.state.calls.length, 0);
});

test('same upstream names do not collide and allowlists are enforced', async t => {
  const source = await upstream(t, { tools: [echo, { ...echo, name: 'delete_scene' }] });
  const { client } = await downstream(t, {
    godot: { transport: 'http', url: source.url, allowTools: ['inspect_scene'] },
    github: { transport: 'http', url: source.url, allowTools: [] },
    other: { transport: 'http', url: source.url },
  });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('godot.inspect_scene'));
  assert.ok(names.includes('other.inspect_scene'));
  assert.ok(!names.includes('godot.delete_scene'));
  assert.ok(!names.some(name => name.startsWith('github.')));
});

test('offline and disabled upstreams do not disable native tools or healthy upstreams', async t => {
  const source = await upstream(t);
  const { client } = await downstream(t, {
    godot: { transport: 'http', url: source.url },
    offline: { transport: 'http', url: 'http://127.0.0.1:1/mcp', connectTimeoutMs: 100 },
    disabled: { transport: 'stdio', command: '/nonexistent-proxy-command', enabled: false },
  });
  assert.equal((await client.callTool({ name: 'system.info', arguments: {} })).isError, undefined);
  assert.equal((await client.callTool({ name: 'godot.inspect_scene', arguments: { scene: 'ok' } })).isError, undefined);
  const status = JSON.stringify(await client.callTool({ name: 'proxy.status', arguments: {} }));
  assert.match(status, /unavailable/);
  assert.match(status, /disabled/);
  assert.doesNotMatch(status, /127\.0\.0\.1|nonexistent-proxy-command/);
});

test('pagination is followed and cyclic discovery fails closed', async t => {
  const source = await upstream(t, { tools: [echo, { ...echo, name: 'second' }], pages: true });
  const broken = await upstream(t, { cycle: true });
  const { client } = await downstream(t, {
    godot: { transport: 'http', url: source.url }, broken: { transport: 'http', url: broken.url },
  });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('godot.second'));
  assert.equal(source.state.lists, 2);
  assert.equal(broken.state.lists, 2);
  assert.ok(!names.some(name => name.startsWith('broken.')));
});

test('duplicate definitions and discovery size limits cannot replace native tools', async t => {
  const source = await upstream(t, { tools: [echo, echo] });
  const { client } = await downstream(t, { duplicate: { transport: 'http', url: source.url }, limited: { transport: 'http', url: source.url, maxTools: 1 } });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['proxy.refresh', 'proxy.status', 'system.info']);
});

test('refresh replaces removed tools and is scoped to the requested namespace', async t => {
  const source = await upstream(t);
  const { client } = await downstream(t, { godot: { transport: 'http', url: source.url } });
  await client.listTools();
  source.state.tools = [{ ...echo, name: 'new_tool' }];
  const result = await client.callTool({ name: 'proxy.refresh', arguments: { upstream: 'godot' } });
  assert.equal(result.isError, undefined);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('godot.new_tool'));
  assert.ok(!names.includes('godot.inspect_scene'));
  assert.equal(errorCode(await client.callTool({ name: 'proxy.refresh', arguments: { upstream: 'unknown' } })), 'PROXY_REFRESH_FAILED');
});

test('tool error results, image content and metadata survive forwarding', async t => {
  const expected: CallToolResult = { isError: true, content: [
    { type: 'text', text: 'Scene missing' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
  ], _meta: { fixture: 'kept' } };
  const source = await upstream(t, { call: async () => expected });
  const { client } = await downstream(t, { godot: { transport: 'http', url: source.url } });
  const result = await client.callTool({ name: 'godot.inspect_scene', arguments: { scene: 'missing' } });
  assert.deepEqual(result, expected);
});

test('output schema is advertised unchanged and successful structured output is preserved', async t => {
  const outputSchema = { type: 'object', properties: { nodes: { type: 'integer' } }, required: ['nodes'], additionalProperties: false };
  const source = await upstream(t, { tools: [{ ...echo, outputSchema }], call: async () => ({ content: [], structuredContent: { nodes: 3 } }) });
  const { client } = await downstream(t, { godot: { transport: 'http', url: source.url } });
  assert.deepEqual((await client.listTools()).tools.find(tool => tool.name === 'godot.inspect_scene')?.outputSchema, outputSchema);
  assert.deepEqual((await client.callTool({ name: 'godot.inspect_scene', arguments: { scene: 'ok' } })).structuredContent, { nodes: 3 });
});

test('oversized responses become bounded errors and are not replayed', async t => {
  const source = await upstream(t, { call: async () => ({ content: [{ type: 'text', text: 'x'.repeat(2000) }] }) });
  const { client } = await downstream(t, { godot: { transport: 'http', url: source.url } }, { maxResultBytes: 1024 });
  const result = await client.callTool({ name: 'godot.inspect_scene', arguments: { scene: 'ok' } });
  assert.equal(errorCode(result), 'UPSTREAM_OUTPUT_LIMIT');
  assert.equal(source.state.calls.length, 1);
});

test('timeouts and transport errors are not automatically retried', async t => {
  const source = await upstream(t, { call: async () => {
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    return { content: [{ type: 'text', text: 'finished' }] };
  } });
  const { client } = await downstream(t, { godot: { transport: 'http', url: source.url, callTimeoutMs: 60 } });
  const result = await client.callTool({ name: 'godot.inspect_scene', arguments: { scene: 'ok' } });
  assert.ok(['UPSTREAM_TIMEOUT', 'UPSTREAM_CALL_FAILED'].includes(errorCode(result)));
  assert.equal(source.state.calls.length, 1);
});

test('credentials are resolved per request, isolated from callers, and absent from status', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-proxy-headers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'capability.json');
  await writeFile(path, JSON.stringify({ http: 'first-secret' }), { mode: 0o600 });
  const source = await upstream(t);
  const { client } = await downstream(t, { godot: {
    transport: 'http', url: source.url,
    headers: { Authorization: { file: path, jsonField: 'http', prefix: 'Bearer ' } },
  } });
  await client.listTools();
  assert.ok(source.state.headers.every(value => value === 'Bearer first-secret'));
  await writeFile(path, JSON.stringify({ http: 'rotated-secret' }));
  await client.callTool({ name: 'godot.inspect_scene', arguments: { scene: 'ok' } });
  assert.equal(source.state.headers.at(-1), 'Bearer rotated-secret');
  const status = JSON.stringify(await client.callTool({ name: 'proxy.status', arguments: {} }));
  assert.doesNotMatch(status, /first-secret|rotated-secret|capability\.json/);
  await writeFile(path, JSON.stringify({ http: 'bad\r\nHeader: value' }));
  assert.equal(errorCode(await client.callTool({ name: 'godot.inspect_scene', arguments: { scene: 'ok' } })), 'UPSTREAM_CALL_FAILED');
});

test('missing, multiline and oversized credential values fail closed', async t => {
  await assert.rejects(resolveHeaders({ Authorization: { env: 'MCP_PROXY_MISSING_TEST_VARIABLE', prefix: '' } }));
  const dir = await mkdtemp(join(tmpdir(), 'mcp-proxy-bad-secret-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'token');
  await writeFile(path, 'x'.repeat(17_000));
  await assert.rejects(resolveHeaders({ Authorization: { file: path, prefix: '' } }));
});

test('stdio sessions are reused, inherit only explicit secrets, and close with their owner', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-proxy-stdio-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pid');
  process.env.MCP_PROXY_UNRELATED_SECRET = 'must-not-be-inherited';
  process.env.MCP_PROXY_EXPLICIT = 'explicit-value';
  t.after(() => { delete process.env.MCP_PROXY_UNRELATED_SECRET; delete process.env.MCP_PROXY_EXPLICIT; });
  const proxy = new McpProxy(parseConfig({ proxy: { upstreams: { local: {
    transport: 'stdio', command: process.execPath, args: [resolve('test/proxy-stdio-fixture.mjs')],
    env: { PID_FILE: pidFile }, envFrom: ['MCP_PROXY_EXPLICIT'],
  } } } }).proxy);
  t.after(() => proxy.close());
  const tools = await proxy.tools();
  assert.equal(tools.length, 1, JSON.stringify(proxy.status()));
  const first = await proxy.call(tools[0]!, {}, new AbortController().signal);
  const second = await proxy.call(tools[0]!, {}, new AbortController().signal);
  assert.deepEqual(first.structuredContent, second.structuredContent);
  assert.equal((first.structuredContent as Record<string, unknown>)?.explicit, 'explicit-value');
  assert.equal((first.structuredContent as Record<string, unknown>)?.inherited, null);
  const pid = Number(await readFile(pidFile, 'utf8'));
  await proxy.close();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('a stalled stdio initialization is bounded and its child is cleaned up', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-proxy-stalled-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pid');
  const proxy = new McpProxy(parseConfig({ proxy: { upstreams: { stalled: {
    transport: 'stdio', command: process.execPath, args: [resolve('test/proxy-stdio-fixture.mjs')],
    env: { PID_FILE: pidFile, MODE: 'stall' }, connectTimeoutMs: 1000,
  } } } }).proxy);
  t.after(() => proxy.close());
  assert.deepEqual(await proxy.tools(), []);
  assert.match(JSON.stringify(proxy.status()), /UPSTREAM_DISCOVERY_FAILED/);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('legacy SSE discovers and calls namespaced tools with upstream-only credentials', async t => {
  let stream: import('node:http').ServerResponse | undefined;
  const auth: Array<string | undefined> = [];
  const server = createServer(async (req, res) => {
    auth.push(req.headers.authorization);
    if (req.method === 'GET' && req.url === '/sse') {
      stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('event: endpoint\ndata: /message\n\n');
      return;
    }
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body) as { id?: number; method: string; params?: { arguments?: Record<string, unknown> } };
    res.writeHead(202); res.end();
    if (request.id === undefined) return;
    const result = request.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'sse-fixture', version: '1' } }
      : request.method === 'tools/list' ? { tools: [echo] }
      : { content: [{ type: 'text', text: JSON.stringify(request.params?.arguments) }] };
    stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => {
    stream?.end(); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  });
  const { client } = await downstream(t, { legacy: {
    transport: 'sse', url: `http://127.0.0.1:${address.port}/sse`, headers: { Authorization: 'Bearer sse-fixture-secret' },
  } });
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'legacy.inspect_scene'));
  const result = await client.callTool({ name: 'legacy.inspect_scene', arguments: { scene: 'res://sse.tscn' } });
  assert.equal(result.isError, undefined);
  assert.ok(auth.length >= 3);
  assert.ok(auth.every(value => value === 'Bearer sse-fixture-secret'));
});

test('cancellation releases capacity and overlapping calls respect the upstream limit', async t => {
  let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  t.after(() => release());
  const source = await upstream(t, { call: async () => {
    entered(); await held;
    return { content: [{ type: 'text', text: 'done' }] };
  } });
  const proxy = new McpProxy(parseConfig({ proxy: { upstreams: { godot: {
    transport: 'http', url: source.url, maxConcurrent: 1,
  } } } }).proxy);
  t.after(() => proxy.close());
  const tools = await proxy.tools(); assert.equal(tools.length, 1);
  const controller = new AbortController();
  const first = proxy.call(tools[0]!, { scene: 'held' }, controller.signal);
  await started;
  assert.equal(errorCode(await proxy.call(tools[0]!, { scene: 'second' }, new AbortController().signal)), 'UPSTREAM_BUSY');
  assert.equal(source.state.calls.length, 1);
  controller.abort();
  assert.equal(errorCode(await first), 'CANCELLED');
  assert.match(JSON.stringify(proxy.status()), /"activeCalls":0/);
  release();
});

test('HTTP redirects cannot forward upstream credentials to another endpoint', async t => {
  let stolen = 0;
  const target = createServer((_req, res) => { stolen++; res.end('{}'); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const targetAddress = target.address(); assert.ok(targetAddress && typeof targetAddress === 'object');
  const redirect = createServer((_req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${targetAddress.port}/stolen` }); res.end();
  });
  redirect.listen(0, '127.0.0.1'); await once(redirect, 'listening');
  const address = redirect.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => {
    for (const server of [target, redirect]) {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    }
  });
  const { client } = await downstream(t, { redirect: {
    transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: 'Bearer never-forward' }, connectTimeoutMs: 1000,
  } });
  assert.equal((await client.callTool({ name: 'system.info', arguments: {} })).isError, undefined);
  assert.equal(stolen, 0);
});
