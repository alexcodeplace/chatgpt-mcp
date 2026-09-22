import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The test command itself is scheduled through K3s. These subprocesses are
// isolated fixtures, never the installed manager or a live user's systemd units.
test('private routing control, lifetime ownership, deployment refusal and recovery use the real Python helpers', { timeout: 90_000 }, async () => {
  try {
    const script = (import.meta.url.endsWith('.ts') ? '../' : '../../') + 'scripts/test_hot_swap.py';
    const result = await promisify(execFile)('python3', ['-B', fileURLToPath(new URL(script, import.meta.url))], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', MCP_TEST_NODE: process.execPath },
      timeout: 80_000, maxBuffer: 1024 * 1024,
    });
    assert.ok(result.stderr.includes('OK'), result.stderr);
    console.log(result.stderr);
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    assert.fail((failed.stdout ?? '') + (failed.stderr ?? '') + failed.message);
  }
});
