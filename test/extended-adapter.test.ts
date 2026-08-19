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
  }));
  await assert.rejects(() => adapter.launchApplication('editor'), error => errorCode(error) === 'COMMAND_NOT_ALLOWED');
});

test('application-specific caller arguments can be disabled', async () => {
  const adapter = new LocalComputerAdapter(parseConfig({
    application: {
      enabled: true,
      applications: {
        worker: { command: process.execPath, args: ['-e', 'process.exit(0)'], allowArguments: false },
      },
    },
  }));
  await assert.rejects(() => adapter.launchApplication('worker', ['extra']), error => errorCode(error) === 'COMMAND_NOT_ALLOWED');
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
  }));

  const launched = await adapter.launchApplication('worker');
  assert.match(launched.handle, /^app_[a-f0-9]{32}$/);
  assert.ok(launched.pid > 0);
  await adapter.closeApplication(launched.handle);
  await assert.rejects(() => adapter.closeApplication(launched.handle), error => errorCode(error) === 'NOT_FOUND');
});

test('browser scheme policy rejects before invoking an opener', async () => {
  const adapter = new LocalComputerAdapter(parseConfig({
    browser: { enabled: true, allowedSchemes: ['https'] },
  }));
  await assert.rejects(() => adapter.openBrowser('file:///etc/passwd'), error => errorCode(error) === 'COMMAND_NOT_ALLOWED');
  await assert.rejects(() => adapter.openBrowser('not a url'), error => errorCode(error) === 'INVALID_INPUT');
});

test('desktop screen and input operations fail closed while disabled', async () => {
  const adapter = new LocalComputerAdapter(parseConfig({}));
  await assert.rejects(() => adapter.captureScreen(), error => errorCode(error) === 'CAPABILITY_DISABLED');
  await assert.rejects(() => adapter.movePointer(1, 2), error => errorCode(error) === 'CAPABILITY_DISABLED');
  await assert.rejects(() => adapter.clickPointer('left'), error => errorCode(error) === 'CAPABILITY_DISABLED');
  await assert.rejects(() => adapter.typeText('hello'), error => errorCode(error) === 'CAPABILITY_DISABLED');
  await assert.rejects(() => adapter.pressKey('Enter'), error => errorCode(error) === 'CAPABILITY_DISABLED');
});

test('input validates coordinates and text before touching xdotool', async () => {
  const adapter = new LocalComputerAdapter(parseConfig({
    desktop: { input: true, maxTextBytes: 4 },
  }));
  await assert.rejects(() => adapter.movePointer(-1, 0), error => errorCode(error) === 'INVALID_INPUT');
  await assert.rejects(() => adapter.clickPointer('left', 1), error => errorCode(error) === 'INVALID_INPUT');
  await assert.rejects(() => adapter.typeText('12345'), error => errorCode(error) === 'OUTPUT_LIMIT');
  await assert.rejects(() => adapter.pressKey(''), error => errorCode(error) === 'INVALID_INPUT');
});
