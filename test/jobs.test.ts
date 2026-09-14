import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseConfig } from '../src/config.js';
import { JobStore, atomicJobJson } from '../src/execution/job-store.js';
import { runJob } from '../src/execution/job-worker.js';
import type { ExecResult } from '../src/adapter/computer-adapter.js';

const success = (stdout = 'durable output'): ExecResult => ({ exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false });
const code = (name: string) => (error: unknown): boolean => (error as { code?: string })?.code === name;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-jobs-test-'));
  const config = parseConfig({ jobs: { enabled: true, directory: join(directory, 'jobs'), launcher: 'detached', maxConcurrent: 2 }, filesystem: { roots: [directory] }, shell: { enabled: true, allowedCommands: ['node'] } });
  return { directory, config, request: { command: 'node', args: ['-e', 'test-request'], cwd: directory } };
}

test('duplicate operation identifiers and a recreated server retrieve exactly one execution', async () => {
  const { directory, config, request } = await fixture();
  let executions = 0;
  const workers: Promise<void>[] = [];
  try {
    const store = new JobStore(config, async path => { workers.push(runJob(path, async () => { executions++; return success(); })); });
    const first = await store.start('operation-once-001', request);
    await Promise.all(workers);
    const second = await store.start('operation-once-001', request);
    const recreated = new JobStore(config, async () => { throw new Error('must not relaunch'); });
    const third = await recreated.start('operation-once-001', request);
    assert.equal(executions, 1);
    assert.equal(first.jobId, second.jobId);
    assert.equal(third.state, 'succeeded');
    assert.equal((await recreated.output(first.jobId, 'stdout', 0, 7)).text, 'durable');
    assert.equal((await recreated.output(first.jobId, 'stdout', 7, 64)).text, ' output');
    await assert.rejects(store.start('operation-once-001', { ...request, args: ['different'] }), code('CONFLICT'));
    await assert.rejects(readFile(join(config.jobs.directory, first.jobId, 'request.json')), { code: 'ENOENT' });
  } finally { await Promise.all(workers); await rm(directory, { recursive: true, force: true }); }
});

test('lost launch acknowledgement never replays work', async () => {
  const { directory, config, request } = await fixture();
  let executions = 0;
  const workers: Promise<void>[] = [];
  try {
    const store = new JobStore(config, async path => {
      workers.push(runJob(path, async () => { executions++; return success(); }));
      throw new Error('acknowledgement lost after launch');
    });
    const first = await store.start('lost-acknowledgement', request);
    assert.equal(first.state, 'unknown');
    await Promise.all(workers);
    const second = await store.start('lost-acknowledgement', request);
    assert.equal(second.state, 'succeeded');
    assert.equal(executions, 1);
    // A duplicate worker cannot claim an already claimed operation either.
    await runJob(join(config.jobs.directory, first.jobId), async () => { executions++; return success(); });
    assert.equal(executions, 1);
  } finally { await Promise.all(workers); await rm(directory, { recursive: true, force: true }); }
});

test('admission is bounded without making status/output wait behind running jobs', async () => {
  const { directory, config, request } = await fixture();
  const paths: string[] = [];
  try {
    const store = new JobStore(config, async path => { paths.push(path); });
    const first = await store.start('capacity-first-001', request);
    await store.start('capacity-second-002', request);
    await assert.rejects(store.start('capacity-third-003', request), code('OVERLOADED'));
    assert.equal((await store.status(first.jobId)).state, 'starting');
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.output(first.jobId, 'stdout')).complete, false);
    assert.equal(paths.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cancellation before launch prevents execution', async () => {
  const { directory, config, request } = await fixture();
  let executions = 0;
  try {
    const store = new JobStore(config, async () => {});
    const first = await store.start('cancel-before-launch', request);
    await store.cancel(first.jobId);
    await runJob(join(config.jobs.directory, first.jobId), async input => {
      if (input.signal?.aborted) throw { code: 'CANCELLED', operation: 'shell.exec', message: 'cancelled' };
      executions++;
      return success();
    });
    assert.equal((await store.status(first.jobId)).state, 'cancelled');
    assert.equal(executions, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dead-worker outcomes remain unknown and reserved', async () => {
  const { directory, config, request } = await fixture();
  let launches = 0;
  try {
    const store = new JobStore(config, async () => { launches++; });
    const first = await store.start('dead-worker-outcome', request);
    await atomicJobJson(join(config.jobs.directory, first.jobId, 'status.json'), { ...first, state: 'running', workerPid: 2147483647, workerIdentity: 'not-a-live-worker' });
    const second = await store.start('dead-worker-outcome', request);
    assert.equal(second.state, 'unknown');
    assert.equal(second.errorCode, 'OUTCOME_UNKNOWN');
    assert.equal(launches, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('job execution enforces existing shell and cwd policies', async () => {
  const { directory, config, request } = await fixture();
  try {
    const store = new JobStore(config, async () => { throw new Error('policy failure must happen before launch'); });
    await assert.rejects(store.start('policy-command-denial', { ...request, command: 'not-allowed' }), code('COMMAND_NOT_ALLOWED'));
    await assert.rejects(store.start('policy-path-denial', { ...request, cwd: '/' }), code('PATH_NOT_ALLOWED'));
    await assert.rejects(store.start('policy-invalid-id!', request), code('INVALID_INPUT'));
    await assert.rejects(store.start('policy-input-budget', { ...request, args: ['x'.repeat(300000)] }), code('OUTPUT_LIMIT'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('durable output preserves credential-looking text verbatim', async () => {
  const { directory, config, request } = await fixture();
  const payload = 'Authorization: Bearer sk-test-durable-passthrough-1234567890';
  const workers: Promise<void>[] = [];
  try {
    const store = new JobStore(config, async path => {
      workers.push(runJob(path, async () => ({ exitCode: 0, stdout: payload, stderr: `err:${payload}`, durationMs: 1, timedOut: false })));
    });
    const record = await store.start('durable-passthrough-001', request);
    await Promise.all(workers);
    assert.equal((await store.output(record.jobId, 'stdout', 0, 65536)).text, payload);
    assert.equal((await store.output(record.jobId, 'stderr', 0, 65536)).text, `err:${payload}`);
  } finally {
    await Promise.all(workers);
    await rm(directory, { recursive: true, force: true });
  }
});
