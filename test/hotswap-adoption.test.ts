import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Agent, request } from 'node:http';
import type { Socket } from 'node:net';
import { readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { attachLegacy, listeningSockets } from '../src/hotswap/attach-legacy.js';
import type { BridgeConfiguration } from '../src/hotswap/bridge.js';
import { decodeRpc } from '../src/hotswap/sse.js';
import { readBytes } from '../src/hotswap/wire.js';
import { processIdentity } from '../src/execution/job-store.js';
import { call, control, fixture, heldCommand, waitFile, type Json } from './helpers/hotswap-fixture.js';

function warmCall(endpoint: string, agent: Agent): Promise<{ socket: Socket; body: Json }> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    let socket!: Socket;
    const exchange = request({ hostname: url.hostname, port: url.port, path: '/mcp', method: 'POST', agent,
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' } }, response => {
      void readBytes(response).then(bytes => {
        assert.equal(response.statusCode, 200);
        resolve({ socket, body: decodeRpc(bytes, response.headers['content-type']) as Json });
      }).catch(reject);
    });
    exchange.once('socket', value => { socket = value; }); exchange.once('error', reject);
    exchange.end(JSON.stringify({ jsonrpc: '2.0', id: 'existing-connection', method: 'tools/call', params: { name: 'system.info', arguments: {} } }));
  });
}

test('adopt the original listener under real traffic without replacing its PID, active calls or keep-alive sockets', { timeout: 120_000 }, async () => {
  const f = await fixture();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const pending: Promise<unknown>[] = [];
  let stop = false; let pump: Promise<void> | undefined;
  let phase = 'setup';
  let pumpFailure: unknown;
  let pumpFailurePhase = '';
  try {
    const a = await f.spawn('a'); const b = await f.spawn('b');
    const legacy = { ...a.generation, legacy: { pid: a.runtime.pid, startedAt: a.runtime.startedAt, configFingerprint: a.runtime.configFingerprint } };
    await f.register(legacy); await f.register(b.generation); await f.activate(legacy);
    const originalUrl = a.generation.url;
    const rawApp = await call(originalUrl, 'app.launch', { name: 'worker', display: ':99' });
    assert.match(rawApp.handle, /^app_/);
    const held = call(originalUrl, 'shell.exec', heldCommand(f.root, 'pre-adoption')).catch(error => error);
    const abort = new AbortController();
    const cancellable = call(originalUrl, 'shell.exec', heldCommand(f.root, 'pre-adoption-cancel'), { signal: abort.signal }).catch(error => error);
    pending.push(held, cancellable);
    await Promise.all(['pre-adoption', 'pre-adoption-cancel'].map(name => waitFile(join(f.root, name + '.started'))));
    const warm = await warmCall(originalUrl, agent);
    assert.equal(warm.body.result.structuredContent.runtime.release, a.generation.revision);
    await call(originalUrl, 'fs.write', { path: join(f.root, 'adoption-writes'), content: '', mode: 'create' });
    await call(originalUrl, 'fs.write', { path: join(f.root, 'adoption-commands'), content: '', mode: 'create' });
    let count = 0;
    phase = 'continuous-before-adoption';
    pump = (async () => {
      while (!stop && count < 200) {
        const marker = String(count++);
        await call(originalUrl, 'fs.write', { path: join(f.root, 'adoption-writes'), content: marker + '\n', mode: 'append' });
        await call(originalUrl, 'fs.read', { path: join(f.root, 'adoption-writes') });
        const command = await call(originalUrl, 'shell.exec', { command: process.execPath, cwd: f.root,
          args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(join(f.root, 'adoption-commands'))},${JSON.stringify(marker + '\n')})`] });
        assert.equal(command.exitCode, 0);
      }
    })().catch(error => { pumpFailure = error; pumpFailurePhase = phase; stop = true; });
    const identity = await processIdentity(a.child.pid!); assert.ok(identity);
    const settings: BridgeConfiguration = { schema: 1, id: a.generation.id, port: Number(new URL(originalUrl).port),
      routerUrl: f.router.endpoint, expectedPid: a.child.pid!, expectedIdentity: identity,
      expectedExecutable: await readlink(`/proc/${a.child.pid}/exe`),
      expectedCommandSha256: createHash('sha256').update(await readFile(`/proc/${a.child.pid}/cmdline`)).digest('hex'),
      keyFile: f.keyFile, configPath: f.configPath };
    const bridgePath = join(f.root, 'bridge.json');
    await writeFile(bridgePath, JSON.stringify(settings), { mode: 0o600 });
    phase = 'live-attach';
    const installed = await attachLegacy(bridgePath);
    console.log(JSON.stringify({ adoptionStage: 'attached', inspectorClosed: installed.inspectorClosed, node: process.versions.node }));
    if (pumpFailure) throw new Error('continuous calls failed during ' + pumpFailurePhase, { cause: pumpFailure });
    assert.equal(installed.inspectorClosed, true); assert.equal(installed.pid, a.child.pid);
    assert.equal((await listeningSockets(a.child.pid!)).length, 1, 'no debugger listener may remain');
    assert.equal((await attachLegacy(bridgePath)).unchanged, true);
    phase = 'activate-and-existing-connection';
    await f.activate(b.generation);
    const switched = await warmCall(originalUrl, agent);
    assert.equal(switched.socket, warm.socket, 'new requests on an existing TCP connection must switch immediately');
    assert.equal(switched.body.result.structuredContent.runtime.release, b.generation.revision);
    assert.equal(a.child.exitCode, null); assert.equal(b.child.exitCode, null);
    console.log(JSON.stringify({ adoptionStage: 'same-socket-upgraded', continuousCycles: count }));
    phase = 'pre-adoption-cancellation';
    abort.abort(); assert.ok(await cancellable instanceof Error);
    const cancelledPid = Number(await f.read('pre-adoption-cancel.started'));
    const deadline = Date.now() + 10_000;
    while (await processIdentity(cancelledPid) && Date.now() < deadline) await nextTurn();
    assert.equal(await processIdentity(cancelledPid), undefined, 'pre-adoption request cancellation must still reach its original child');
    console.log(JSON.stringify({ adoptionStage: 'original-cancellation-completed' }));
    phase = 'handles-and-rollback';
    const appB = await call(originalUrl, 'app.launch', { name: 'worker', display: ':99' });
    assert.match(appB.handle, /^hs1\./);
    await call(originalUrl, 'app.close', { handle: rawApp.handle });
    await call(originalUrl, 'fs.write', { path: join(f.root, 'pre-adoption.release'), content: 'go', mode: 'create' });
    assert.equal((await held).stdout, 'pre-adoption');
    assert.equal((await control(f.socket, '/rollback', { expectedEpoch: (await f.status()).epoch })).status, 200);
    assert.equal((await call(originalUrl, 'system.info')).runtime.release, a.generation.revision);
    await f.activate(b.generation);
    stop = true; await pump;
    if (pumpFailure) throw new Error('continuous calls failed during ' + pumpFailurePhase, { cause: pumpFailure });
    console.log(JSON.stringify({ adoptionStage: 'hot-proof-complete', continuousCycles: count }));
    for (const name of ['adoption-writes', 'adoption-commands']) {
      const rows = (await f.read(name)).trim().split('\n');
      assert.equal(rows.length, count); assert.equal(new Set(rows).size, count);
    }
    assert.ok(count > 0);
    const foreign = await fetch(originalUrl + '/healthz', { headers: { origin: 'https://foreign.invalid' } });
    assert.equal(foreign.status, 403, 'the bridge must not erase origin validation');
    // This is a separate cold-start test, after the hot-upgrade proof completed.
    // Restarted ingress must not impersonate the previous backend incarnation.
    phase = 'separate-cold-start';
    agent.destroy(); a.child.kill('SIGTERM'); await once(a.child, 'exit');
    const replacementIngress = await f.spawn('a', settings.port,
      new URL('../src/hotswap/bridge-preload' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'), import.meta.url).href, bridgePath);
    assert.notEqual(replacementIngress.generation.id, a.generation.id);
    assert.equal((await call(originalUrl, 'system.info')).runtime.release, b.generation.revision);
    await call(originalUrl, 'app.close', { handle: appB.handle });
    const oldOwner = await fetch(originalUrl + '/mcp', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-mcp-route-key': f.key, 'x-mcp-route-instance': a.generation.id }, body: '{}' });
    assert.equal(oldOwner.status, 409);
    console.log(JSON.stringify({ acceptance: 'live-listener-adoption', pidPreserved: true, tcpSocketPreserved: true,
      activeCallPreserved: true, cancellationPreserved: true, oldRawHandlePreserved: true, inspectorClosed: true, continuousCycles: count, startupPreload: true }));
  } catch (error) {
    throw new Error('adoption test failed in ' + phase, { cause: error });
  } finally {
    stop = true; agent.destroy(); await f.cleanup(); await pump?.catch(() => {}); await Promise.allSettled(pending);
  }
});
