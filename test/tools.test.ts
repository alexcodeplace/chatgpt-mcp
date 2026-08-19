import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import test from 'node:test';
import type { ComputerAdapter } from '../src/adapter/computer-adapter.js';
import { parseConfig } from '../src/config.js';
import { adapterError } from '../src/errors.js';
import { registerTools } from '../src/tools/register-tools.js';

function fakeAdapter(): ComputerAdapter {
  return {
    async systemInfo() { return { hostname: 'test', platform: 'linux', architecture: 'x64', release: '1', uptimeSeconds: 1, cwd: '/tmp' }; },
    async listDirectory() { return [{ name: 'a.txt', type: 'file', size: 1 }]; },
    async readFile() { return 'a'; },
    async writeFile() {},
    async makeDirectory() {},
    async movePath() {},
    async deletePath() {},
    async exec() { return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false }; },
    async listProcesses() { return [{ pid: 1, command: 'init' }]; },
    async killProcess() {},
    async serviceStatus(name) { return { name, activeState: 'active', subState: 'running', description: 'test service' }; },
    async serviceControl() {},
    async launchApplication() { return { handle: 'app_test', pid: 42 }; },
    async closeApplication() {},
    async openBrowser() {},
    async captureScreen() { return { mimeType: 'image/png', data: Buffer.from('png').toString('base64'), bytes: 3 }; },
    async movePointer() {},
    async clickPointer() {},
    async typeText() {},
    async pressKey() {},
  };
}

async function harness(configValue: unknown, adapter: ComputerAdapter = fakeAdapter()) {
  const config = parseConfig(configValue);
  const server = new McpServer({ name: 'chatgpt-computer', version: '0.1.0' });
  registerTools(server, config, adapter);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

test('tool discovery omits disabled capabilities', async () => {
  const { client, server } = await harness({});
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ['system.info']);
  } finally {
    await client.close();
    await server.close();
  }
});

test('tool discovery exposes only granted capability families', async () => {
  const { client, server } = await harness({
    filesystem: { read: true, roots: ['/tmp'] },
    shell: { enabled: true, allowedCommands: ['node'] },
    process: { list: true },
  });
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['fs.list', 'fs.read', 'process.list', 'shell.exec', 'system.info']);
  } finally {
    await client.close();
    await server.close();
  }
});

test('tool discovery exposes the complete extended capability surface when granted', async () => {
  const { client, server } = await harness({
    service: { enabled: true, allowedServices: ['*'] },
    application: { enabled: true, applications: { editor: { command: 'editor' } } },
    browser: { enabled: true },
    desktop: { screenCapture: true, input: true },
  });
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, [
      'app.close', 'app.launch', 'browser.open', 'input.click', 'input.key', 'input.move', 'input.type',
      'screen.capture', 'service.control', 'service.status', 'system.info',
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test('system.info returns structured capability information', async () => {
  const { client, server } = await harness({ shell: { enabled: true, allowedCommands: ['node'] }, desktop: { input: true } });
  try {
    const result = await client.callTool({ name: 'system.info', arguments: {} });
    assert.equal(result.isError, undefined);
    const body = result.structuredContent as { hostname?: string; capabilities?: { shell?: boolean; input?: boolean } } | undefined;
    assert.equal(body?.hostname, 'test');
    assert.equal(body?.capabilities?.shell, true);
    assert.equal(body?.capabilities?.input, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('adapter errors become visible MCP tool errors', async () => {
  const adapter = fakeAdapter();
  adapter.readFile = async () => { throw adapterError('PATH_NOT_ALLOWED', 'fs.read', 'blocked'); };
  const { client, server } = await harness({ filesystem: { read: true, roots: ['/tmp'] } }, adapter);
  try {
    const result = await client.callTool({ name: 'fs.read', arguments: { path: '/tmp/nope' } });
    assert.equal(result.isError, true);
    const first = result.content[0];
    assert.match(first?.type === 'text' ? first.text : '', /PATH_NOT_ALLOWED/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('shell tool delegates argument-array execution unchanged', async () => {
  let seen: unknown;
  const adapter = fakeAdapter();
  adapter.exec = async request => {
    seen = request;
    return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false };
  };
  const { client, server } = await harness({ shell: { enabled: true, allowedCommands: ['node'] } }, adapter);
  try {
    const result = await client.callTool({ name: 'shell.exec', arguments: { command: 'node', args: ['--version'], timeoutMs: 100 } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(seen, { command: 'node', args: ['--version'], timeoutMs: 100 });
  } finally {
    await client.close();
    await server.close();
  }
});

test('application launch returns an explicit handle and close consumes that handle', async () => {
  const calls: unknown[] = [];
  const adapter = fakeAdapter();
  adapter.launchApplication = async (name, args) => {
    calls.push(['launch', name, args]);
    return { handle: 'app_123', pid: 77 };
  };
  adapter.closeApplication = async handle => { calls.push(['close', handle]); };
  const { client, server } = await harness({
    application: { enabled: true, applications: { editor: { command: 'editor', allowArguments: true } } },
  }, adapter);
  try {
    const launched = await client.callTool({ name: 'app.launch', arguments: { name: 'editor', args: ['file.txt'] } });
    assert.deepEqual(launched.structuredContent, { handle: 'app_123', pid: 77 });
    const closed = await client.callTool({ name: 'app.close', arguments: { handle: 'app_123' } });
    assert.equal(closed.isError, undefined);
    assert.deepEqual(calls, [['launch', 'editor', ['file.txt']], ['close', 'app_123']]);
  } finally {
    await client.close();
    await server.close();
  }
});

test('screen capture returns MCP image content and compact structured metadata', async () => {
  const { client, server } = await harness({ desktop: { screenCapture: true } });
  try {
    const result = await client.callTool({ name: 'screen.capture', arguments: {} });
    assert.deepEqual(result.structuredContent, { mimeType: 'image/png', bytes: 3 });
    assert.equal(result.content.some(item => item.type === 'image'), true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('input click schema rejects a lone coordinate before adapter invocation', async () => {
  let called = false;
  const adapter = fakeAdapter();
  adapter.clickPointer = async () => { called = true; };
  const { client, server } = await harness({ desktop: { input: true } }, adapter);
  try {
    const result = await client.callTool({ name: 'input.click', arguments: { x: 10 } });
    assert.equal(result.isError, true);
    assert.equal(called, false);
  } finally {
    await client.close();
    await server.close();
  }
});
