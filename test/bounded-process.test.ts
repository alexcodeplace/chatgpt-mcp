import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { spawnBounded } from '../src/execution/bounded-process.js';

async function spoolEntries(): Promise<Set<string>> {
  return new Set((await readdir(tmpdir())).filter(name => name.startsWith('chatgpt-mcp-spool-')));
}

test('bounded process spools multi-megabyte output and cleans temporary files', async () => {
  const before = await spoolEntries();
  const bytes = 2 * 1024 * 1024;
  const result = await spawnBounded(process.execPath, ['-e', `process.stdout.write('x'.repeat(${bytes}))`], {
    timeoutMs: 10_000,
    maxOutputBytes: bytes + 1024,
    operation: 'test.spool',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.byteLength(result.stdout), bytes);
  assert.equal(result.stderr, '');
  const after = await spoolEntries();
  assert.deepEqual(after, before);
});

test('bounded process cleans spool files after output overflow', async () => {
  const before = await spoolEntries();
  await assert.rejects(
    () => spawnBounded(process.execPath, ['-e', `process.stdout.write('x'.repeat(1048576))`], {
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      operation: 'test.spool.limit',
    }),
    (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'OUTPUT_LIMIT',
  );
  const after = await spoolEntries();
  assert.deepEqual(after, before);
});

test('bounded process cleans spool files after cancellation', async () => {
  const before = await spoolEntries();
  const abort = new AbortController();
  const running = spawnBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    operation: 'test.spool.cancel',
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 30).unref();
  await assert.rejects(
    () => running,
    (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'CANCELLED',
  );
  const after = await spoolEntries();
  assert.deepEqual(after, before);
});


test('bounded process handles an early stdin close without an unhandled EPIPE', async () => {
  await assert.rejects(
    () => spawnBounded(process.execPath, ['-e', 'process.stdin.destroy(); setTimeout(()=>process.exit(0),50)'], {
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      operation: 'test.stdin.epipe',
      stdin: Buffer.alloc(8 * 1024 * 1024, 'x'),
    }),
    (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'OS_ERROR',
  );
});


test('bounded process invokes termination hooks before killing its wrapper', async () => {
  const signals: NodeJS.Signals[] = [];
  const result = await spawnBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    timeoutMs: 30,
    maxOutputBytes: 4096,
    operation: 'test.terminate.hook',
    onTerminate: signal => signals.push(signal),
  });
  assert.equal(result.timedOut, true);
  assert.equal(signals[0], 'SIGTERM');
});
