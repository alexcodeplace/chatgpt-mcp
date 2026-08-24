import assert from 'node:assert/strict';
import test from 'node:test';
import { ConcurrencyController } from '../src/concurrency.js';
import { parseConfig } from '../src/config.js';

function controller(overrides: Record<string, number>): ConcurrencyController {
  return new ConcurrencyController(parseConfig({ concurrency: overrides }).concurrency);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function codeIs(code: string): (error: unknown) => boolean {
  return error => typeof error === 'object' && error !== null && (error as { code?: string }).code === code;
}

async function tick(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test('normal work leaves reserved slots available for control operations', async () => {
  const c = controller({ maxConcurrent: 4, reservedControlSlots: 1, shellMaxConcurrent: 2, maxQueue: 8, queueTimeoutMs: 1_000 });
  const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
  const normal = gates.slice(0, 3).map((gate, index) => c.run(`fs.read.${index}`, async () => gate.promise));
  await tick();
  assert.equal(c.snapshot().active.total, 3);

  const queuedNormal = c.run('fs.read.queued', async () => gates[3]!.promise);
  await tick();
  assert.equal(c.snapshot().queued.regular, 1);

  let controlStarted = false;
  const control = c.run('system.info', async () => {
    controlStarted = true;
    await gates[4]!.promise;
  });
  await tick();
  assert.equal(controlStarted, true);
  assert.equal(c.snapshot().active.total, 4);
  assert.equal(c.snapshot().queued.regular, 1);

  gates[0]!.resolve();
  await tick();
  assert.equal(c.snapshot().active.total, 4);
  assert.equal(c.snapshot().queued.total, 0);

  for (const gate of gates.slice(1)) gate.resolve();
  await Promise.all([...normal, queuedNormal, control]);
  assert.ok(c.snapshot().peaks.active <= 4);
});

test('shell limit does not head-of-line block startable non-shell work', async () => {
  const c = controller({ maxConcurrent: 4, reservedControlSlots: 1, shellMaxConcurrent: 1, maxQueue: 8, queueTimeoutMs: 1_000 });
  const shellA = deferred();
  const shellB = deferred();
  const normal = deferred();
  const first = c.run('shell.exec', async () => shellA.promise);
  const second = c.run('shell.exec', async () => shellB.promise);
  let normalStarted = false;
  const third = c.run('fs.read', async () => {
    normalStarted = true;
    await normal.promise;
  });
  await tick();

  const snapshot = c.snapshot();
  assert.equal(snapshot.active.shell, 1);
  assert.equal(snapshot.active.total, 2);
  assert.equal(snapshot.queued.regular, 1);
  assert.equal(normalStarted, true);

  normal.resolve();
  shellA.resolve();
  await tick();
  shellB.resolve();
  await Promise.all([first, second, third]);
  assert.equal(c.snapshot().peaks.shell, 1);
});

test('full queue rejects immediately with OVERLOADED and never exceeds bounds', async () => {
  const c = controller({ maxConcurrent: 2, reservedControlSlots: 1, shellMaxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 1_000 });
  const running = deferred();
  const queuedA = deferred();
  const queuedB = deferred();
  const a = c.run('fs.read.a', async () => running.promise);
  const b = c.run('fs.read.b', async () => queuedA.promise);
  const d = c.run('fs.read.c', async () => queuedB.promise);
  await tick();
  assert.equal(c.snapshot().queued.total, 2);
  await assert.rejects(() => c.run('fs.read.d', async () => undefined), codeIs('OVERLOADED'));
  assert.equal(c.snapshot().queued.total, 2);
  assert.equal(c.snapshot().counters.rejected, 1);

  running.resolve();
  await tick();
  queuedA.resolve();
  await tick();
  queuedB.resolve();
  await Promise.all([a, b, d]);
});

test('queue timeout returns OVERLOADED and removes the queued request', async () => {
  const c = controller({ maxConcurrent: 2, reservedControlSlots: 1, shellMaxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 25 });
  const running = deferred();
  const active = c.run('fs.read.active', async () => running.promise);
  await assert.rejects(() => c.run('fs.read.waiting', async () => undefined), codeIs('OVERLOADED'));
  assert.equal(c.snapshot().queued.total, 0);
  assert.equal(c.snapshot().counters.timedOut, 1);
  running.resolve();
  await active;
});

test('queued cancellation removes work without consuming an execution slot', async () => {
  const c = controller({ maxConcurrent: 2, reservedControlSlots: 1, shellMaxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 1_000 });
  const running = deferred();
  const active = c.run('fs.read.active', async () => running.promise);
  const abort = new AbortController();
  const waiting = c.run('fs.read.waiting', async () => undefined, abort.signal);
  await tick();
  assert.equal(c.snapshot().queued.total, 1);
  abort.abort();
  await assert.rejects(() => waiting, codeIs('CANCELLED'));
  assert.equal(c.snapshot().queued.total, 0);
  assert.equal(c.snapshot().counters.cancelled, 1);
  assert.equal(c.snapshot().active.total, 1);
  running.resolve();
  await active;
});


test('default policy reaches 40 non-control plus 8 reserved control slots but never exceeds 48 total', async () => {
  const c = new ConcurrencyController(parseConfig({}).concurrency);
  const normalGates = Array.from({ length: 41 }, () => deferred());
  const controlGates = Array.from({ length: 9 }, () => deferred());
  const normal = normalGates.slice(0, 40).map((gate, index) => c.run(`fs.read.default.${index}`, async () => gate.promise));
  await tick();
  assert.equal(c.snapshot().active.nonControl, 40);
  assert.equal(c.snapshot().active.total, 40);

  const queuedNormal = c.run('fs.read.default.queued', async () => normalGates[40]!.promise);
  const controls = controlGates.slice(0, 8).map(gate => c.run('system.info', async () => gate.promise));
  await tick();
  assert.equal(c.snapshot().active.nonControl, 40);
  assert.equal(c.snapshot().active.control, 8);
  assert.equal(c.snapshot().active.total, 48);
  assert.equal(c.snapshot().queued.regular, 1);

  const queuedControl = c.run('system.info', async () => controlGates[8]!.promise);
  await tick();
  assert.equal(c.snapshot().active.total, 48);
  assert.equal(c.snapshot().queued.control, 1);
  assert.equal(c.snapshot().peaks.active, 48);

  for (const gate of normalGates) gate.resolve();
  for (const gate of controlGates) gate.resolve();
  await Promise.all([...normal, queuedNormal, ...controls, queuedControl]);
  assert.equal(c.snapshot().active.total, 0);
});

test('running cancellation is reflected in controller metrics', async () => {
  const c = controller({ maxConcurrent: 2, reservedControlSlots: 1, shellMaxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 1_000 });
  const abort = new AbortController();
  const gate = deferred();
  const running = c.run('shell.exec', async () => gate.promise, abort.signal);
  await tick();
  abort.abort();
  await tick();
  assert.equal(c.snapshot().counters.cancelled, 1);
  gate.resolve();
  await running;
});
