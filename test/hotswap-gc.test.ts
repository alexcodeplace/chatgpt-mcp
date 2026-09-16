import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { processIdentity } from '../src/execution/job-store.js';
import { fixture, heldCommand, rpc, waitFile } from './helpers/hotswap-fixture.js';

test('HTTP disconnect cancels an original command even after the request object is collected', { timeout: 30_000 }, async () => {
  const f = await fixture();
  let pending: Promise<unknown> | undefined;
  try {
    const a = await f.spawn('a');
    const abort = new AbortController();
    pending = rpc(a.generation.url, 'shell.exec', heldCommand(f.root, 'gc-command'), { signal: abort.signal }).catch(error => error);
    await waitFile(join(f.root, 'gc-command.started'));
    for (let i = 0; i < 3; i++) {
      const collected = once(a.child, 'message'); a.child.send('collect-garbage');
      assert.equal((await collected)[0].event, 'garbage-collected');
    }
    abort.abort();
    assert.ok(await pending instanceof Error);
    const pid = Number(await f.read('gc-command.started'));
    const deadline = Date.now() + 5000;
    while (await processIdentity(pid) && Date.now() < deadline) await delay(20);
    assert.equal(await processIdentity(pid), undefined, 'disconnect did not reach the process owner after garbage collection');
  } finally { await f.cleanup(); await pending; }
});
