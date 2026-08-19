import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { parseConfig } from '../src/config.js';
import { createComputerHttpServer } from '../src/http-server.js';

async function withServer(
  configValue: unknown,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const config = parseConfig(configValue);
  const { server, closeHandler } = createComputerHttpServer(config);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await closeHandler();
  }
}

test('health endpoint is available without MCP bearer token', async () => {
  await withServer({ http: { token: 'secret' } }, async baseUrl => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: '@platform-modules/chatgpt-mcp' });
  });
});

test('MCP endpoint enforces configured bearer token', async () => {
  await withServer({ http: { token: 'secret' } }, async baseUrl => {
    const denied = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('www-authenticate'), 'Bearer');

    const wrong = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer nope' },
    });
    assert.equal(wrong.status, 401);

    const admitted = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { Authorization: 'Bearer secret' },
    });
    assert.notEqual(admitted.status, 401);
  });
});

test('localhost origin validation rejects a foreign browser origin', async () => {
  await withServer({}, async baseUrl => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
  });
});

test('unknown routes do not fall through to MCP', async () => {
  await withServer({}, async baseUrl => {
    const response = await fetch(`${baseUrl}/anything-else`);
    assert.equal(response.status, 404);
  });
});

test('non-loopback bind requires explicit allowed hosts', () => {
  const config = parseConfig({ http: { host: '0.0.0.0' } });
  assert.throws(() => createComputerHttpServer(config), /allowedHosts/);
});
