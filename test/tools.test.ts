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
    async startScreenRecording(display, path) { return { handle: 'rec_test', pid: 43, path, display, startedAt: '2026-09-09T00:00:00.000Z' }; },
    async stopScreenRecording(handle) { return { handle, path: '/tmp/test.mp4', display: ':0', bytes: 123, durationMs: 1000 }; },
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

test('host display master gate omits all display-dependent tools', async () => {
  const { client, server } = await harness({
    application: { enabled: true, applications: { editor: { command: 'editor' } } },
    browser: { enabled: true },
    desktop: { hostDisplayAccess: false, screenCapture: true, input: true },
  });
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['system.info']);
    const info = await client.callTool({ name: 'system.info', arguments: {} });
    const capabilities = (info.structuredContent as { capabilities?: Record<string, boolean> } | undefined)?.capabilities;
    assert.equal(capabilities?.hostDisplayAccess, false);
    assert.equal(capabilities?.screenCapture, false);
    assert.equal(capabilities?.input, false);
    assert.equal(capabilities?.application, false);
    assert.equal(capabilities?.browser, false);
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
    filesystem: { write: true, roots: ['/tmp'] },
    desktop: { hostDisplayAccess: true, screenCapture: true, screenRecording: true, input: true },
  });
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, [
      'app.close', 'app.launch', 'browser.open', 'fs.delete', 'fs.mkdir', 'fs.move', 'fs.write', 'input.click', 'input.key', 'input.move', 'input.type',
      'screen.capture', 'screen.record.start', 'screen.record.stop', 'service.control', 'service.status', 'system.info',
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test('system.info returns structured capability information', async () => {
  const { client, server } = await harness({ shell: { enabled: true, allowedCommands: ['node'] }, desktop: { hostDisplayAccess: true, input: true } });
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
    assert.equal(typeof seen, 'object');
    const request = seen as { command: string; args: string[]; timeoutMs: number; signal?: AbortSignal };
    assert.deepEqual({ command: request.command, args: request.args, timeoutMs: request.timeoutMs }, { command: 'node', args: ['--version'], timeoutMs: 100 });
    assert.ok(request.signal instanceof AbortSignal);
  } finally {
    await client.close();
    await server.close();
  }
});

test('successful structured results are not duplicated into text content', async () => {
  const adapter = fakeAdapter();
  adapter.exec = async () => ({ exitCode: 0, stdout: 'payload', stderr: '', durationMs: 1, timedOut: false });
  const { client, server } = await harness({ shell: { enabled: true, allowedCommands: ['node'] } }, adapter);
  try {
    const result = await client.callTool({ name: 'shell.exec', arguments: { command: 'node' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]?.type === 'text' ? result.content[0].text : '', 'ok');
    assert.equal((result.structuredContent as { stdout?: string } | undefined)?.stdout, 'payload');
  } finally {
    await client.close();
    await server.close();
  }
});

test('oversized tool responses fail locally before the tunnel transport limit', async () => {
  const adapter = fakeAdapter();
  adapter.exec = async () => ({
    exitCode: 0,
    stdout: 'x'.repeat(7 * 1024 * 1024),
    stderr: '',
    durationMs: 1,
    timedOut: false,
  });
  const { client, server } = await harness({ shell: { enabled: true, allowedCommands: ['node'] } }, adapter);
  try {
    const result = await client.callTool({ name: 'shell.exec', arguments: { command: 'node' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    const first = result.content[0];
    assert.match(first?.type === 'text' ? first.text : '', /OUTPUT_LIMIT/);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 64 * 1024);
  } finally {
    await client.close();
    await server.close();
  }
});

test('application launch returns an explicit handle and close consumes that handle', async () => {
  const calls: unknown[] = [];
  const adapter = fakeAdapter();
  adapter.launchApplication = async (name, args, display) => {
    calls.push(['launch', name, args, display]);
    return { handle: 'app_123', pid: 77 };
  };
  adapter.closeApplication = async handle => { calls.push(['close', handle]); };
  const { client, server } = await harness({
    application: { enabled: true, applications: { editor: { command: 'editor', allowArguments: true } } },
    desktop: { hostDisplayAccess: true },
  }, adapter);
  try {
    const launched = await client.callTool({ name: 'app.launch', arguments: { name: 'editor', args: ['file.txt'], display: ':0' } });
    assert.deepEqual(launched.structuredContent, { handle: 'app_123', pid: 77, display: ':0' });
    const closed = await client.callTool({ name: 'app.close', arguments: { handle: 'app_123' } });
    assert.equal(closed.isError, undefined);
    assert.deepEqual(calls, [['launch', 'editor', ['file.txt'], ':0'], ['close', 'app_123']]);
  } finally {
    await client.close();
    await server.close();
  }
});

test('screen capture returns MCP image content and compact structured metadata', async () => {
  const { client, server } = await harness({ desktop: { hostDisplayAccess: true, screenCapture: true } });
  try {
    const result = await client.callTool({ name: 'screen.capture', arguments: { display: ':99' } });
    assert.deepEqual(result.structuredContent, { mimeType: 'image/png', bytes: 3, display: ':99' });
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
  const { client, server } = await harness({ desktop: { hostDisplayAccess: true, input: true } }, adapter);
  try {
    const result = await client.callTool({ name: 'input.click', arguments: { display: ':0', x: 10 } });
    assert.equal(result.isError, true);
    assert.equal(called, false);
  } finally {
    await client.close();
    await server.close();
  }
});


test('display-dependent tools require and forward the caller-selected DISPLAY per invocation', async () => {
  const calls: unknown[] = [];
  const adapter = fakeAdapter();
  adapter.launchApplication = async (name, args, display) => {
    calls.push(['launch', name, args, display]);
    return { handle: 'app_display', pid: 90 };
  };
  adapter.openBrowser = async (url, display) => { calls.push(['browser', url, display]); };
  adapter.captureScreen = async display => {
    calls.push(['capture', display]);
    return { mimeType: 'image/png', data: Buffer.from('png').toString('base64'), bytes: 3 };
  };
  adapter.movePointer = async (x, y, display) => { calls.push(['move', x, y, display]); };
  adapter.clickPointer = async (button, display, x, y) => { calls.push(['click', button, display, x, y]); };
  adapter.typeText = async (text, display, delayMs) => { calls.push(['type', text, display, delayMs]); };
  adapter.pressKey = async (key, display) => { calls.push(['key', key, display]); };

  const { client, server } = await harness({
    application: { enabled: true, applications: { editor: { command: 'editor', allowArguments: true } } },
    browser: { enabled: true },
    desktop: { hostDisplayAccess: true, screenCapture: true, input: true },
  }, adapter);
  try {
    const launch = await client.callTool({ name: 'app.launch', arguments: { name: 'editor', display: ':0' } });
    const browser = await client.callTool({ name: 'browser.open', arguments: { url: 'https://example.com', display: ':99' } });
    const capture = await client.callTool({ name: 'screen.capture', arguments: { display: ':100' } });
    const move = await client.callTool({ name: 'input.move', arguments: { x: 10, y: 20, display: ':101' } });
    const click = await client.callTool({ name: 'input.click', arguments: { button: 'right', x: 30, y: 40, display: ':102' } });
    const type = await client.callTool({ name: 'input.type', arguments: { text: 'hello', delayMs: 5, display: ':103' } });
    const key = await client.callTool({ name: 'input.key', arguments: { key: 'Enter', display: ':104' } });

    assert.equal((launch.structuredContent as { display?: string })?.display, ':0');
    assert.equal((browser.structuredContent as { display?: string })?.display, ':99');
    assert.equal((capture.structuredContent as { display?: string })?.display, ':100');
    assert.equal((move.structuredContent as { display?: string })?.display, ':101');
    assert.equal((click.structuredContent as { display?: string })?.display, ':102');
    assert.equal((type.structuredContent as { display?: string })?.display, ':103');
    assert.equal((key.structuredContent as { display?: string })?.display, ':104');
    assert.deepEqual(calls, [
      ['launch', 'editor', [], ':0'],
      ['browser', 'https://example.com', ':99'],
      ['capture', ':100'],
      ['move', 10, 20, ':101'],
      ['click', 'right', ':102', 30, 40],
      ['type', 'hello', ':103', 5],
      ['key', 'Enter', ':104'],
    ]);

    const missingDisplay = await client.callTool({ name: 'screen.capture', arguments: {} });
    assert.equal(missingDisplay.isError, true);
    assert.equal(calls.length, 7);
  } finally {
    await client.close();
    await server.close();
  }
});


test('screen recording start and stop expose asynchronous handle contract with per-recording DISPLAY', async () => {
  const calls: unknown[] = [];
  const adapter = fakeAdapter();
  adapter.startScreenRecording = async (display, path, frameRate) => {
    calls.push(['start', display, path, frameRate]);
    return { handle: 'rec_123', pid: 88, path, display, startedAt: '2026-09-09T00:00:00.000Z' };
  };
  adapter.stopScreenRecording = async handle => {
    calls.push(['stop', handle]);
    return { handle, path: '/tmp/capture.mp4', display: ':77', bytes: 4567, durationMs: 2345 };
  };
  const { client, server } = await harness({
    filesystem: { write: true, roots: ['/tmp'] },
    desktop: { hostDisplayAccess: true, screenRecording: true },
  }, adapter);
  try {
    const started = await client.callTool({
      name: 'screen.record.start',
      arguments: { display: ':77', path: '/tmp/capture.mp4', frameRate: 24 },
    });
    assert.deepEqual(started.structuredContent, {
      handle: 'rec_123', pid: 88, path: '/tmp/capture.mp4', display: ':77', startedAt: '2026-09-09T00:00:00.000Z',
    });
    const stopped = await client.callTool({ name: 'screen.record.stop', arguments: { handle: 'rec_123' } });
    assert.deepEqual(stopped.structuredContent, {
      handle: 'rec_123', path: '/tmp/capture.mp4', display: ':77', bytes: 4567, durationMs: 2345,
    });
    assert.deepEqual(calls, [
      ['start', ':77', '/tmp/capture.mp4', 24],
      ['stop', 'rec_123'],
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test('screen recording tools stay hidden without filesystem write authority', async () => {
  const { client, server } = await harness({
    filesystem: { read: true, roots: ['/tmp'] },
    desktop: { hostDisplayAccess: true, screenRecording: true },
  });
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(names.includes('screen.record.start'), false);
    assert.equal(names.includes('screen.record.stop'), false);
  } finally {
    await client.close();
    await server.close();
  }
});


test('filesystem blocklist does not disable unrelated GUI browser or input capabilities', async () => {
  const { client, server } = await harness({
    filesystem: { read: true, write: true, roots: ['/tmp'], blocklist: [{ path: '/tmp' }] },
    application: { enabled: true, applications: { terminal: { command: 'xterm', allowArguments: true } } },
    browser: { enabled: true },
    desktop: { hostDisplayAccess: true, screenCapture: true, input: true },
  });
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(names.includes('app.launch'), true);
    assert.equal(names.includes('app.close'), true);
    assert.equal(names.includes('browser.open'), true);
    assert.equal(names.some(name => name.startsWith('input.')), true);
    assert.equal(names.includes('screen.capture'), true);
    const info = await client.callTool({ name: 'system.info', arguments: {} });
    const capabilities = (info.structuredContent as { capabilities?: Record<string, boolean> } | undefined)?.capabilities;
    assert.equal(capabilities?.application, true);
    assert.equal(capabilities?.browser, true);
    assert.equal(capabilities?.input, true);
    assert.equal(capabilities?.screenCapture, true);
  } finally {
    await client.close();
    await server.close();
  }
});


test('key manager tools are opt-in and expose only agent operations', async () => {
  const { client, server } = await harness({
    keyManager: { enabled: true, tokenFile: '/tmp/kmgr-test-token' },
  });
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['kmgr.list', 'kmgr.profiles', 'kmgr.run', 'kmgr.status', 'system.info']);
    const info = await client.callTool({ name: 'system.info', arguments: {} });
    const capabilities = (info.structuredContent as { capabilities?: Record<string, boolean> } | undefined)?.capabilities;
    assert.equal(capabilities?.keyManager, true);
    for (const forbidden of ['kmgr.get', 'kmgr.reveal', 'kmgr.import', 'kmgr.approve', 'kmgr.grant', 'kmgr.delete']) {
      assert.equal(names.includes(forbidden), false);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
