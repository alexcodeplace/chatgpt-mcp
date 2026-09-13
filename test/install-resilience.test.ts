import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

async function text(path: string): Promise<string> { return readFile(new URL(`../${path}`, import.meta.url), 'utf8'); }

test('installer preserves configuration and pins a checksum-verified tunnel release', async () => {
  const install = await text('install.sh');
  assert.match(install, /MCP_SERVICE_NAME="chatgpt-mcp\.service"/);
  assert.match(install, /UnsetEnvironment=DISPLAY WAYLAND_DISPLAY MIR_SOCKET/);
  assert.match(install, /TUNNEL_SERVICE_NAME="chatgpt-mcp-tunnel-\$\{PROFILE_NAME\}\.service"/);
  assert.match(install, /install-tunnel\.py/);
  assert.match(install, /install --frozen-lockfile/);
  assert.doesNotMatch(install, /--no-frozen-lockfile/);
  assert.match(install, /if \[\[ ! -f "\$LOCAL_CONFIG" \]\]; then cp/);
  assert.match(install, /StartLimitBurst=3/);
  assert.match(install, /Restart=on-failure\nRestartSec=10/);
  assert.match(install, /RestartPreventExitStatus=78/);
  assert.match(install, /TUNNEL_VERSION_MISMATCH/);
  assert.match(install, /install-recovery\.py/);
  assert.doesNotMatch(install, /restore_last_good|config\.last-good|OnUnitActiveSec=15s/);
  const pin = await text('scripts/install-tunnel.py');
  assert.match(pin, /VERSION = "0\.0\.14"/);
  assert.match(pin, /hashlib\.sha256\(archive\)/);
  assert.doesNotMatch(pin, /releases\/latest/);
});

test('recovery installation has one bounded owner and retains polling evidence', async () => {
  const installer = await text('scripts/install-recovery.py');
  assert.match(installer, /chatgpt-mcp-recovery\.service/);
  assert.match(installer, /OnUnitInactiveSec=30s/);
  const recovery = await text('scripts/recovery.py');
  assert.match(recovery, /fcntl\.flock/);
  assert.match(recovery, /commands_poll_last_successful_timestamp_seconds/);
  assert.match(recovery, /maxRestartsPerHour/);
  assert.match(recovery, /circuit_open/);
  assert.doesNotMatch(recovery, /restore_last_good|chmod.*configPath/);
});

test('profile uninstall does not tear down the shared backend', async () => {
  const uninstall = await text('scripts/tunnel-uninstall.sh');
  assert.match(uninstall, /shared chatgpt-mcp HTTP service/);
  assert.doesNotMatch(uninstall, /disable --now "\$MCP_SERVICE_NAME"/);
  assert.doesNotMatch(uninstall, /rm -rf "\$USER_LIB"/);
});
