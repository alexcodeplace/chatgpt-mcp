import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { call, control, fixture, rpc, waitFile } from './helpers/hotswap-fixture.js';

test('recording processes and owner handles survive upgrade and rollback; retirement refuses an unfinished recording', { timeout: 60_000 }, async () => {
  const f = await fixture({ desktop: { hostDisplayAccess: true, screenRecording: true } });
  try {
    const bin = join(f.root, 'bin'); await mkdir(bin);
    const recorder = join(bin, 'ffmpeg');
    // Real child lifecycle, stdin finalization and output file; synthetic codec
    // bytes keep this an ownership test, not a claim of actual screen capture.
    await writeFile(recorder, `#!${process.execPath}\nconst f=require('node:fs');const path=process.argv.at(-1);f.writeFileSync(path,'recording-started');f.writeFileSync(path+'.ready','ready');process.stdin.on('data',()=>{f.appendFileSync(path,'-finalized');process.exit(0);});\n`);
    await chmod(recorder, 0o700);
    const env = { PATH: bin + ':' + process.env.PATH };
    const a = await f.spawn('a', 0, undefined, undefined, env);
    const b = await f.spawn('b', 0, undefined, undefined, env);
    const c = await f.spawn('c', 0, undefined, undefined, env);
    await f.register(a.generation); await f.register(b.generation); await f.register(c.generation);
    await f.activate(a.generation);
    const recordedA = await call(f.router.endpoint, 'screen.record.start', { display: ':99', path: join(f.root, 'a.mp4') });
    await waitFile(join(f.root, 'a.mp4.ready'));
    await f.activate(b.generation);
    const recordedB = await call(f.router.endpoint, 'screen.record.start', { display: ':98', path: join(f.root, 'b.mp4') });
    await waitFile(join(f.root, 'b.mp4.ready'));
    await f.activate(c.generation); // A is no longer the protected rollback target.
    const refused = await control(f.socket, '/retire', { id: a.generation.id, expectedEpoch: (await f.status()).epoch });
    assert.equal(refused.status, 409);
    const stopA = await rpc(f.router.endpoint, 'screen.record.stop', { handle: recordedA.handle });
    assert.equal(stopA.status, 200); assert.equal(stopA.generation, a.generation.id);
    assert.equal(stopA.body.result.structuredContent.handle, recordedA.handle);
    assert.equal(await f.read('a.mp4'), 'recording-started-finalized');
    await f.activate(a.generation); // Existing B recording remains B-owned.
    const stopB = await rpc(f.router.endpoint, 'screen.record.stop', { handle: recordedB.handle });
    assert.equal(stopB.status, 200); assert.equal(stopB.generation, b.generation.id);
    assert.equal(stopB.body.result.structuredContent.handle, recordedB.handle);
    assert.equal(await f.read('b.mp4'), 'recording-started-finalized');
    assert.equal((await control(f.socket, '/inventory', { id: b.generation.id })).body.resources.recordings, 0);
  } finally { await f.cleanup(); }
});
