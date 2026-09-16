import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { atomicJobJson } from '../src/execution/job-store.js';
import { policyFingerprint } from '../src/hotswap/identity.js';
import { readBytes } from '../src/hotswap/wire.js';
import { decodeRpc } from '../src/hotswap/sse.js';
import { call, control, fixture, heldCommand, rpc, waitFile, type Json } from './helpers/hotswap-fixture.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function eventually(probe: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await probe()) return; await nextTurn(); }
  assert.fail(message);
}

// This is deliberately real kernel I/O and real child processes, not a mocked
// proxy. Explicit file barriers hold commands across the activation boundary.
test('continuous reads, unique writes and commands survive A -> B -> A with old handles and durable jobs', { timeout: 90_000 }, async () => {
  const f = await fixture();
  let stop = false;
  let pump: Promise<void> | undefined;
  const pending: Promise<unknown>[] = [];
  try {
    const a = await f.spawn('a'); const b = await f.spawn('b');
    await f.register(a.generation); await f.register(b.generation); await f.activate(a.generation);
    const routerPid = (await f.status()).routerPid;
    const endpoint = f.router.endpoint;
    const appA = await call(endpoint, 'app.launch', { name: 'worker', display: ':99' });
    assert.match(appA.handle, /^hs1\./);
    const heldA = call(endpoint, 'shell.exec', heldCommand(f.root, 'held-a')).catch(error => error);
    pending.push(heldA); await waitFile(join(f.root, 'held-a.started'));
    const durableArgs = { operationId: 'hot-swap-durable-once', ...heldCommand(f.root, 'durable') };
    const job = await call(endpoint, 'exec.start', durableArgs);
    await waitFile(join(f.root, 'durable.started'));
    await call(endpoint, 'fs.write', { path: join(f.root, 'writes.log'), content: '', mode: 'create' });
    await call(endpoint, 'fs.write', { path: join(f.root, 'commands.log'), content: '', mode: 'create' });
    const started = deferred(); const sawB = deferred(); const sawRollback = deferred();
    const markers = new Set<string>(); let phase = 'before';
    pump = Promise.all([0, 1].map(async lane => {
      for (let n = 0; n < 300 && !stop; n++) {
        const marker = `${lane}:${n}`;
        await call(endpoint, 'fs.write', { path: join(f.root, 'writes.log'), content: marker + '\n', mode: 'append' });
        const read = await call(endpoint, 'fs.read', { path: join(f.root, 'writes.log') });
        assert.ok(read.content.includes(marker + '\n'));
        const executed = await rpc(endpoint, 'shell.exec', { command: process.execPath, cwd: f.root, args: ['-e',
          `require('node:fs').appendFileSync(${JSON.stringify(join(f.root, 'commands.log'))},${JSON.stringify(marker + '\n')})`] });
        assert.equal(executed.status, 200, JSON.stringify(executed.body));
        assert.equal(executed.body.result.structuredContent.exitCode, 0, JSON.stringify(executed.body));
        markers.add(marker);
        if (markers.size >= 2) started.resolve();
        if (executed.generation === b.generation.id) sawB.resolve();
        if (phase === 'rollback' && executed.generation === a.generation.id) sawRollback.resolve();
      }
    })).then(() => {});
    await Promise.race([started.promise, pump]);
    await f.activate(b.generation);
    assert.equal((await call(endpoint, 'system.info')).runtime.release, b.generation.revision);
    const switched = await f.status();
    assert.ok(switched.generations.find((g: Json) => g.id === a.generation.id).inFlight >= 1, 'old call must still be active when B answers');
    await Promise.race([sawB.promise, pump]);
    const duplicate = await call(endpoint, 'exec.start', durableArgs);
    assert.equal(duplicate.jobId, job.jobId, 'operation ID must retain the same durable reservation across versions');
    const cancelled = await call(endpoint, 'exec.cancel', { jobId: job.jobId });
    assert.equal(cancelled.cancellationRequested, true);
    await eventually(async () => (await call(endpoint, 'exec.status', { jobId: job.jobId })).state === 'cancelled', 'old job cancellation was lost');
    const appB = await call(endpoint, 'app.launch', { name: 'worker', display: ':99' });
    const oldHandle = await rpc(endpoint, 'app.close', { handle: appA.handle });
    assert.equal(oldHandle.generation, a.generation.id);
    assert.equal(oldHandle.body.result.isError, undefined);
    const heldB = call(endpoint, 'shell.exec', heldCommand(f.root, 'held-b')).catch(error => error);
    pending.push(heldB); await waitFile(join(f.root, 'held-b.started'));
    const rolled = await control(f.socket, '/rollback', { expectedEpoch: (await f.status()).epoch });
    assert.equal(rolled.status, 200, JSON.stringify(rolled.body)); phase = 'rollback';
    assert.equal((await call(endpoint, 'system.info')).runtime.release, a.generation.revision);
    await Promise.race([sawRollback.promise, pump]);
    const newHandle = await rpc(endpoint, 'app.close', { handle: appB.handle });
    assert.equal(newHandle.generation, b.generation.id, 'rollback must not steal B handles');
    assert.equal(newHandle.body.result.isError, undefined);
    for (const name of ['held-a', 'held-b']) await call(endpoint, 'fs.write', { path: join(f.root, name + '.release'), content: 'go', mode: 'create' });
    const completedA = await heldA; const completedB = await heldB;
    assert.equal(completedA.stdout, 'held-a'); assert.equal(completedB.stdout, 'held-b');
    stop = true; await pump;
    const writes = (await f.read('writes.log')).trim().split('\n');
    const commands = (await f.read('commands.log')).trim().split('\n');
    assert.equal(writes.length, markers.size); assert.equal(commands.length, markers.size);
    assert.deepEqual(new Set(writes), markers); assert.deepEqual(new Set(commands), markers);
    assert.ok(markers.size >= 4);
    assert.equal((await f.status()).routerPid, routerPid);
    assert.equal(a.child.exitCode, null); assert.equal(b.child.exitCode, null);
    console.log(JSON.stringify({ acceptance: 'continuous-upgrade-rollback', writes: writes.length, commands: commands.length,
      duplicateCommands: commands.length - new Set(commands).size, oldCallsCompleted: 2, handlesPreserved: 2, durableJobPreserved: true }));
  } finally {
    stop = true;
    await f.cleanup();
    await pump?.catch(() => {});
    await Promise.allSettled(pending);
  }
});

test('stale control, failed candidates, durable epochs and restart-safe handle ownership fail closed', { timeout: 90_000 }, async () => {
  let fault: 'none' | 'before' | 'after' = 'none';
  const f = await fixture({}, async (path, value) => {
    if (fault === 'before') throw new Error('injected before persistence');
    await atomicJobJson(path, value);
    if (fault === 'after') throw new Error('injected after rename');
  });
  try {
    const a = await f.spawn('a'); const b = await f.spawn('b'); const c = await f.spawn('c');
    await f.register(a.generation); await f.register(b.generation); await f.register(c.generation); await f.activate(a.generation);
    const epoch = (await f.status()).epoch;
    const loop = await control(f.socket, '/register', { expectedEpoch: epoch, generation: { ...a.generation, url: f.router.endpoint } });
    assert.equal(loop.body.error, 'ROUTING_LOOP_REFUSED');
    assert.equal((await control(f.socket, '/activate', { expectedEpoch: epoch - 1, id: b.generation.id })).status, 409);
    assert.equal((await control(f.socket, '/register', { expectedEpoch: epoch, generation: { ...b.generation, policyFingerprint: '0'.repeat(64) } })).status, 409);
    b.child.kill('SIGTERM'); await once(b.child, 'exit');
    assert.notEqual((await control(f.socket, '/activate', { expectedEpoch: epoch, id: b.generation.id })).status, 200);
    assert.equal((await f.status()).active, a.generation.id);
    const app = await call(f.router.endpoint, 'app.launch', { name: 'worker', display: ':99' });
    assert.equal((await rpc(f.router.endpoint, 'app.close', { handle: app.handle + 'x' })).status, 400);
    fault = 'before';
    assert.equal((await control(f.socket, '/activate', { expectedEpoch: epoch, id: c.generation.id })).status, 503);
    assert.equal((await f.status()).active, a.generation.id);
    fault = 'after';
    assert.equal((await control(f.socket, '/activate', { expectedEpoch: epoch, id: c.generation.id })).status, 503);
    assert.equal((await f.status()).active, c.generation.id, 'visible persisted epoch must be reconciled even if acknowledgement failed');
    fault = 'none';
    await f.reopen();
    assert.equal((await f.status()).active, c.generation.id);
    const close = await rpc(f.router.endpoint, 'app.close', { handle: app.handle });
    assert.equal(close.generation, a.generation.id);
    assert.equal(close.body.result.isError, undefined);
    assert.equal((await control(f.socket, '/retire', { id: a.generation.id, expectedEpoch: (await f.status()).epoch })).status, 409, 'rollback target is retained');
    const d = await f.spawn('d'); await f.register(d.generation); await f.activate(d.generation);
    await eventually(async () => {
      const inventory = await control(f.socket, '/inventory', { id: a.generation.id });
      return inventory.body.resources?.applications === 0;
    }, 'accepted termination still owns a live child');
    const retired = await control(f.socket, '/retire', { id: a.generation.id, expectedEpoch: (await f.status()).epoch });
    assert.equal(retired.status, 200, JSON.stringify(retired.body));
    const direct = await rpc(a.generation.url, 'system.info');
    assert.equal(direct.status, 503, 'retirement must fence direct admissions, not just erase a registry record');
    const deniedControl = await fetch(f.router.endpoint + '/activate', { method: 'POST', body: '{}' });
    assert.equal(deniedControl.status, 404);
    const batch = await fetch(f.router.endpoint + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' });
    assert.equal(batch.status, 400);
    const spoof = await fetch(f.router.endpoint + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'x-mcp-route-key': 'forged', 'x-mcp-route-instance': a.generation.id },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'system.info', arguments: {} } }) });
    assert.equal((decodeRpc(new Uint8Array(await spoof.arrayBuffer()), spoof.headers.get('content-type') ?? undefined) as Json).result.structuredContent.runtime.release, d.generation.revision);
  } finally { await f.cleanup(); }
});

test('a dispatched mutation is never replayed after losing its response during an upgrade', { timeout: 60_000 }, async () => {
  const f = await fixture();
  const began = deferred(); const finish = deferred(); let executions = 0;
  const id = randomBytes(16).toString('hex');
  const fake = createServer((req, res) => {
    if (req.url === '/__hotswap') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ instanceId: id, routingAbi: 1, jobsAbi: 1,
        policyFingerprint: policyFingerprint(f.config), fenced: false, resources: { applications: 0, recordings: 0 }, runtime: { release: 'f'.repeat(40) } })); return;
    }
    void readBytes(req).then(async () => {
      executions++; await writeFile(join(f.root, 'mutation-audit'), 'once\n', { flag: 'a' }); began.resolve();
      await finish.promise; res.destroy();
    });
  });
  fake.listen(0, '127.0.0.1'); await once(fake, 'listening');
  const address = fake.address(); assert.ok(address && typeof address !== 'string');
  try {
    const a = { id, url: `http://127.0.0.1:${address.port}`, unit: 'fault.service', revision: 'f'.repeat(40), policyFingerprint: policyFingerprint(f.config) };
    const b = await f.spawn('b'); await f.register(a); await f.register(b.generation); await f.activate(a);
    const pending = rpc(f.router.endpoint, 'shell.exec', { command: 'a-mutating-command' });
    await began.promise;
    await f.activate(b.generation);
    assert.equal((await call(f.router.endpoint, 'system.info')).runtime.release, b.generation.revision);
    finish.resolve();
    const response = await pending;
    assert.equal(response.status, 502); assert.equal(response.body.error.data.code, 'OUTCOME_UNKNOWN');
    assert.equal(executions, 1); assert.equal(await f.read('mutation-audit'), 'once\n');
  } finally { finish.resolve(); fake.closeAllConnections(); await new Promise<void>(resolve => fake.close(() => resolve())); await f.cleanup(); }
});

test('cancellation stays with the original exchange and never fans out across repeated agent IDs', { timeout: 90_000 }, async () => {
  const f = await fixture();
  const pending: Promise<unknown>[] = [];
  try {
    const a = await f.spawn('a'); const b = await f.spawn('b');
    await f.register(a.generation); await f.register(b.generation); await f.activate(a.generation);
    const endpoint = f.router.endpoint;
    const first = rpc(endpoint, 'shell.exec', heldCommand(f.root, 'cancel-one'), { id: 7, session: 'agent-one' });
    const second = rpc(endpoint, 'shell.exec', heldCommand(f.root, 'keep-two'), { id: 7, session: 'agent-two' });
    pending.push(first, second);
    await Promise.all(['cancel-one', 'keep-two'].map(name => waitFile(join(f.root, name + '.started'))));
    await f.activate(b.generation);
    const cancel = async (session?: string) => fetch(endpoint + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json',
      ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }) });
    assert.equal((await cancel()).status, 202, 'an unscoped notification must not guess its owner');
    assert.equal((await cancel('agent-one')).status, 202);
    assert.equal((await first).body.error.data.code, 'CANCELLED');
    assert.ok((await f.status()).generations.find((g: Json) => g.id === a.generation.id).inFlight >= 1);
    await f.release('keep-two');
    assert.equal((await second).body.result.structuredContent.stdout, 'keep-two');
    const duplicate1 = rpc(endpoint, 'shell.exec', heldCommand(f.root, 'dup-one'), { id: 7, session: 'shared-scope' });
    const duplicate2 = rpc(endpoint, 'shell.exec', heldCommand(f.root, 'dup-two'), { id: 7, session: 'shared-scope' });
    pending.push(duplicate1, duplicate2);
    await Promise.all(['dup-one', 'dup-two'].map(name => waitFile(join(f.root, name + '.started'))));
    assert.equal((await cancel('shared-scope')).status, 409);
    await Promise.all(['dup-one', 'dup-two'].map(name => f.release(name)));
    assert.equal((await duplicate1).body.result.structuredContent.stdout, 'dup-one');
    assert.equal((await duplicate2).body.result.structuredContent.stdout, 'dup-two');
    const abort = new AbortController();
    const disconnected = rpc(endpoint, 'shell.exec', heldCommand(f.root, 'disconnect'), { signal: abort.signal }).catch(error => error);
    pending.push(disconnected); await waitFile(join(f.root, 'disconnect.started'));
    await f.activate(a.generation); abort.abort();
    assert.ok(await disconnected instanceof Error);
    await eventually(async () => (await control(f.socket, '/inventory', { id: b.generation.id })).body.activeCalls === 0, 'socket cancellation did not reach the old backend');
    assert.equal((await call(endpoint, 'system.info')).runtime.release, a.generation.revision);
  } finally { await f.cleanup(); await Promise.allSettled(pending); }
});
