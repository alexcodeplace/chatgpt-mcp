import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parseConfig } from '../src/config.js';
import { startComputerHttpServer } from '../src/http-server.js';

/** Opt-in test against a real, separately installed Godot AI package. */
test('real Godot AI tools are discoverable and callable through the main MCP', {
  skip: !process.env.GODOT_AI_COMMAND,
  timeout: 60_000,
}, async t => {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const address = socket.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(done => socket.close(() => done()));
  const config = parseConfig({ logLevel: 'silent', proxy: { upstreams: {
    godot: {
      transport: 'stdio', command: process.env.GODOT_AI_COMMAND!,
      args: ['--transport', 'stdio', '--ws-port', String(address.port)],
      connectTimeoutMs: 30_000,
      maxTools: 4096,
    },
  } } });
  const server = await startComputerHttpServer({ ...config, http: { ...config.http, port: 0 } });
  const client = new Client({ name: 'real-godot-proxy-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint)));
  const tools = (await client.listTools()).tools;
  const godotTools = tools.filter(tool => tool.name.startsWith('godot.'));
  assert.ok(godotTools.length > 0, JSON.stringify(await client.callTool({ name: 'proxy.status', arguments: {} })));
  const sessions = godotTools.find(tool => tool.name === 'godot.session_list');
  assert.ok(sessions, 'Godot AI must advertise its real session_list tool');
  const result = await client.callTool({ name: sessions.name, arguments: {} });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.content.length > 0 || result.structuredContent !== undefined);
  console.log(JSON.stringify({ realGodotTools: godotTools.length, called: sessions.name, success: result.isError !== true }));
});
