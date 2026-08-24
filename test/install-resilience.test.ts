import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

async function text(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('installer keeps MCP lifetime independent from tunnel lifetime', async () => {
  const install = await text('install.sh');

  assert.match(install, /MCP_SERVICE_NAME="chatgpt-mcp\.service"/);
  assert.match(install, /TUNNEL_SERVICE_NAME="chatgpt-mcp-tunnel-\$\{PROFILE_NAME\}\.service"/);
  assert.match(install, /--sample sample_mcp_remote_no_auth/);
  assert.match(install, /--mcp-server-url "http:\/\/127\.0\.0\.1:3210\/mcp"/);
  assert.match(install, /Restart=always\nRestartSec=1/);
  assert.doesNotMatch(install, /--mcp-command .*dist\/src\/stdio\.js/);
});

test('status checks both supervised layers', async () => {
  const status = await text('scripts/tunnel-status.sh');

  assert.match(status, /MCP HTTP service:/);
  assert.match(status, /http:\/\/127\.0\.0\.1:3210\/healthz/);
  assert.match(status, /chatgpt-mcp-tunnel-\$\{PROFILE_NAME\}\.service/);
});

test('profile uninstall does not tear down shared backend', async () => {
  const uninstall = await text('scripts/tunnel-uninstall.sh');

  assert.match(uninstall, /shared chatgpt-mcp HTTP service/);
  assert.doesNotMatch(uninstall, /disable --now "\$MCP_SERVICE_NAME"/);
  assert.doesNotMatch(uninstall, /rm -rf "\$USER_LIB"/);
});
