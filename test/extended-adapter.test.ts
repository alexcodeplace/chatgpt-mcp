import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalComputerAdapter } from '../src/adapter/local-computer-adapter.js';
import { parseConfig } from '../src/config.js';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
}

test('service allow-list rejects before invoking systemctl', async () => {
  const adapter = new LocalComputerAdapter(parseConfig({
    service: { enabled: true, allowedServices: ['nginx.service'] },
  }));
  await assert.rejects(() => adapter.serviceStatus('ssh.service'), error => errorCode(error) === 'COMMAND_NOT_ALLOWED');
});

test('unknown named applications are rejected', async () => {
  const adapter = new LocalComputerAdapter(parseConfig({
    application: { enabled: true, applications: {} },
    desktop: { hostDisplayAccess: true },
  }));
  await assert.rejects(() => adapter.launchApplication('editor', [], ':0'), error => errorCode(error) === 'COMMAND_NOT_ALLOWED');
});

test('application-specific caller arguments can be disabled', async () => {
  const adapter = new LocalComputerAdapter(parseConfig({
    application: {
      enabled: true,
      applications: {
        worker: { command: process.execPath, args: ['-e', 'process.exit(0)'], allowArguments: false },
      },
    },
    desktop: { hostDisplayAccess: true },
  }));
  await assert.rejects(() => adapter.launchApplication('worker', ['extra'], ':0'), error => errorCode(error) === 'COMMAND_NOT_ALLOWED');
});

test('application launch returns an explicit handle that app.close accepts', async () => {
  const adapter = new LocalComputerAdapter(parseConfig({
    application: {
      enabled: true,
      applications: {
        worker: {
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 10000)'],
          allowArguments: false,
        },
      },
    },
    desktop: { hostDisplayAccess: true },
  }));

  const launched = await adapter.launchApplication('worker', [], ':0');
  assert.match(launched.handle, /^app_[a-f0-9]{32}$/);
  assert.ok(launched.pid > 0);
  await adapter.closeApplication(launched.handle);
  await assert.rejects(() => adapter.closeApplication(launched.handle), error => errorCode(error) === 'NOT_FOUND');
});

test('browser scheme policy rejects before invoking an opener', async () => {
  const adapter = new LocalComputerAdapter(parseConfig({
    browser: { enabled: true, allowedSchemes: ['https'] },
    desktop: { hostDisplayAccess: true },
  }));
  await assert.rejects(() => adapter.openBrowser('file:///etc/passwd', ':0'), error => errorCode(error) === 'COMMAND_NOT_ALLOWED');
  await assert.rejects(() => adapter.openBrowser('not a url', ':0'), error => errorCode(error) === 'INVALID_INPUT');
});

test('desktop screen and input operations fail closed while disabled', async () => {
  const adapter = new LocalComputerAdapter(parseConfig({}));
  await assert.rejects(() => adapter.captureScreen(':0'), error => errorCode(error) === 'CAPABILITY_DISABLED');
  await assert.rejects(() => adapter.movePointer(1, 2, ':0'), error => errorCode(error) === 'CAPABILITY_DISABLED');
  await assert.rejects(() => adapter.clickPointer('left', ':0'), error => errorCode(error) === 'CAPABILITY_DISABLED');
  await assert.rejects(() => adapter.typeText('hello', ':0'), error => errorCode(error) === 'CAPABILITY_DISABLED');
  await assert.rejects(() => adapter.pressKey('Enter', ':0'), error => errorCode(error) === 'CAPABILITY_DISABLED');
});

test('input validates coordinates and text before touching xdotool', async () => {
  const adapter = new LocalComputerAdapter(parseConfig({
    desktop: { hostDisplayAccess: true, input: true, maxTextBytes: 4 },
  }));
  await assert.rejects(() => adapter.movePointer(-1, 0, ':0'), error => errorCode(error) === 'INVALID_INPUT');
  await assert.rejects(() => adapter.clickPointer('left', ':0', 1), error => errorCode(error) === 'INVALID_INPUT');
  await assert.rejects(() => adapter.typeText('12345', ':0'), error => errorCode(error) === 'OUTPUT_LIMIT');
  await assert.rejects(() => adapter.pressKey('', ':0'), error => errorCode(error) === 'INVALID_INPUT');
});


test('application launches isolate caller-selected DISPLAY values without mutating server DISPLAY', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-multidisplay-'));
  const firstFile = join(root, 'first.txt');
  const secondFile = join(root, 'second.txt');
  const makeScript = (path: string) => `require('node:fs').writeFileSync(${JSON.stringify(path)}, process.env.DISPLAY ?? ''); setInterval(() => {}, 10000)`;
  const adapter = new LocalComputerAdapter(parseConfig({
    application: {
      enabled: true,
      applications: {
        first: { command: process.execPath, args: ['-e', makeScript(firstFile)] },
        second: { command: process.execPath, args: ['-e', makeScript(secondFile)] },
      },
    },
    desktop: { hostDisplayAccess: true },
  }));
  const previousDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ':server';
  let firstHandle: string | undefined;
  let secondHandle: string | undefined;
  try {
    const [first, second] = await Promise.all([
      adapter.launchApplication('first', [], ':71'),
      adapter.launchApplication('second', [], ':72'),
    ]);
    firstHandle = first.handle;
    secondHandle = second.handle;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const [firstValue, secondValue] = await Promise.all([readFile(firstFile, 'utf8'), readFile(secondFile, 'utf8')]);
        assert.equal(firstValue, ':71');
        assert.equal(secondValue, ':72');
        assert.equal(process.env.DISPLAY, ':server');
        return;
      } catch (error) {
        if (attempt === 99) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  } finally {
    if (firstHandle !== undefined) await adapter.closeApplication(firstHandle).catch(() => {});
    if (secondHandle !== undefined) await adapter.closeApplication(secondHandle).catch(() => {});
    if (previousDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = previousDisplay;
    await rm(root, { recursive: true, force: true });
  }
});
