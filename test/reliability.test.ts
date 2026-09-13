import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnBounded } from '../src/execution/bounded-process.js';
import { LocalComputerAdapter } from '../src/adapter/local-computer-adapter.js';
import { parseConfig } from '../src/config.js';
import { sha256 } from '../src/execution/atomic-file.js';

const errorCode = (code: string) => (error: unknown): boolean => (error as { code?: string })?.code === code;

test('deadline terminates descendants after their parent has already exited', { skip: process.platform === 'win32' }, async () => {
  const start = performance.now();
  const result = await spawnBounded('/bin/sh', ['-c', 'sleep 5 & exit 0'], { timeoutMs: 100, maxOutputBytes: 4096, operation: 'test.inherited.pipe' });
  assert.equal(result.timedOut, true);
  assert.ok(performance.now() - start < 2500, 'inherited pipes must not defeat the deadline');
});

test('completed termination clears delayed kill hooks', async () => {
  const signals: string[] = [];
  await spawnBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100, maxOutputBytes: 4096, operation: 'test.hook.cleanup', onTerminate: signal => signals.push(signal) });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(signals, ['SIGTERM']);
});

test('early spool failure is a structured error, not an unhandled process crash', { skip: process.platform !== 'linux' }, async () => {
  const moduleUrl = new URL('../src/execution/bounded-process.js', import.meta.url).href;
  const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const original = fs.createWriteStream; fs.createWriteStream = () => original('/dev/full', {flags:'w'}); syncBuiltinESMExports(); const {spawnBounded} = await import(${JSON.stringify(moduleUrl)}); try { await spawnBounded('/bin/sh',['-c','printf probe; sleep 1'],{timeoutMs:2000,maxOutputBytes:4096,operation:'test.spool.full'}); process.exitCode=2; } catch(error) { console.log(JSON.stringify(error)); process.exitCode = error.code === 'OS_ERROR' ? 0 : 3; }`;
  const result = await spawnBounded(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeoutMs: 10000, maxOutputBytes: 4096, operation: 'test.spool.isolated' });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).code, 'OS_ERROR');
  assert.equal(JSON.parse(result.stdout).details.osCode, 'ENOSPC');
});

test('atomic replacement detects concurrent edits and preserves complete content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-replace-test-'));
  try {
    const adapter = new LocalComputerAdapter(parseConfig({ filesystem: { read: true, write: true, roots: [directory] } }));
    const path = join(directory, 'file.txt');
    await adapter.replaceFile(path, 'original', null);
    const results = await Promise.allSettled([
      adapter.replaceFile(path, 'first complete replacement', sha256('original')),
      adapter.replaceFile(path, 'second complete replacement', sha256('original')),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'CONFLICT');
    assert.equal(await readFile(path, 'utf8'), 'first complete replacement');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(adapter.replaceFile(path, 'overwrite unexpectedly', null), errorCode('CONFLICT'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('atomic replacement does not bypass symlink or frozen-entry policy', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-replace-policy-'));
  try {
    const plain = new LocalComputerAdapter(parseConfig({ filesystem: { read: true, write: true, roots: [directory] } }));
    const path = join(directory, 'file');
    await plain.writeFile(path, 'original', 'create');
    await symlink(path, join(directory, 'link'));
    await assert.rejects(plain.replaceFile(join(directory, 'link'), 'replacement', sha256('original')), errorCode('INVALID_INPUT'));
    const guarded = new LocalComputerAdapter(parseConfig({ filesystem: { read: true, write: true, roots: [directory], blocklist: [{ path: directory, mode: 'freeze-children' }] } }));
    await assert.rejects(guarded.replaceFile(path, 'replacement', sha256('original')), errorCode('PATH_NOT_ALLOWED'));
    await guarded.writeFile(path, 'existing semantics retained', 'overwrite');
    assert.equal(await readFile(path, 'utf8'), 'existing semantics retained');
    if (process.getuid?.() !== 0) {
      await chmod(path, 0o400);
      await assert.rejects(plain.replaceFile(path, 'replacement', sha256('existing semantics retained')), errorCode('OS_ERROR'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('timeout kills TERM-ignoring descendants even after all output pipes close', { skip: process.platform !== 'linux' }, async () => {
  const program = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(child.pid);setInterval(()=>{},1000);`;
  let childPid: number | undefined;
  try {
    const result = await spawnBounded(process.execPath, ['-e', program], { timeoutMs: 500, maxOutputBytes: 4096, operation: 'test.terminated.descendant' });
    childPid = Number(result.stdout.trim());
    assert.ok(Number.isInteger(childPid) && childPid > 1);
    assert.equal(result.timedOut, true);
    let state = 'unknown';
    const deadline = performance.now() + 1000;
    do {
      try {
        const info = await readFile(`/proc/${childPid}/stat`, 'utf8');
        state = info.slice(info.lastIndexOf(')') + 2).split(' ')[0]!;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        state = 'gone';
      }
      if (state === 'gone' || state === 'Z') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (performance.now() < deadline);
    assert.ok(state === 'gone' || state === 'Z', `descendant remained alive: ${state}`);
  } finally {
    if (childPid !== undefined && Number.isInteger(childPid) && childPid > 1) {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already reaped */ }
    }
  }
});
