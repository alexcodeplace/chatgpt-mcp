import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig, parseConfig } from '../src/config.js';

test('safe defaults expose no filesystem, shell, or process authority', () => {
  const config = parseConfig({});
  assert.equal(config.http.host, '127.0.0.1');
  assert.equal(config.http.port, 3210);
  assert.deepEqual(config.http.allowedHosts, []);
  assert.deepEqual(config.http.allowedOrigins, []);
  assert.equal(config.filesystem.read, false);
  assert.equal(config.filesystem.write, false);
  assert.deepEqual(config.filesystem.roots, []);
  assert.equal(config.shell.enabled, false);
  assert.deepEqual(config.shell.allowedCommands, []);
  assert.equal(config.process.list, false);
  assert.equal(config.process.kill, false);
});

test('parsed configuration is deeply frozen', () => {
  const config = parseConfig({ filesystem: { roots: ['/tmp'] }, shell: { allowedCommands: ['node'] } });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.http), true);
  assert.equal(Object.isFrozen(config.filesystem), true);
  assert.equal(Object.isFrozen(config.filesystem.roots), true);
  assert.equal(Object.isFrozen(config.shell.allowedCommands), true);
});

test('environment overrides file transport settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-config-'));
  try {
    const file = join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ http: { host: '127.0.0.2', port: 3000 } }), 'utf8');
    const config = await loadConfig({
      CHATGPT_MCP_CONFIG: file,
      CHATGPT_MCP_HOST: '127.0.0.3',
      CHATGPT_MCP_PORT: '3333',
      CHATGPT_MCP_ALLOWED_HOSTS: 'localhost, mcp.internal',
      CHATGPT_MCP_ALLOWED_ORIGINS: 'localhost',
    });
    assert.equal(config.http.host, '127.0.0.3');
    assert.equal(config.http.port, 3333);
    assert.deepEqual(config.http.allowedHosts, ['localhost', 'mcp.internal']);
    assert.deepEqual(config.http.allowedOrigins, ['localhost']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('malformed configuration fails closed', () => {
  assert.throws(() => parseConfig({ shell: { enabled: true, maxRuntimeMs: -1 } }));
  assert.throws(() => parseConfig({ http: { port: 70000 } }));
});
