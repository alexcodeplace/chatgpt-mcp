import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { parseConfig } from '../src/config.js';
import { jobsAbi, policyFingerprint, routingAbi } from '../src/hotswap/identity.js';
import { startRouter, type Generation } from '../src/hotswap/router.js';
import { control } from './helpers/hotswap-fixture.js';

test('router rebind preserves stable generation identity across an idle backend restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-hot-rebind-'));
  const key = randomBytes(32).toString('hex');
  const config = parseConfig({
    filesystem: { roots: [root], read: true, write: true },
    shell: { enabled: false },
    application: { enabled: false },
    jobs: { enabled: false },
  });
  const revision = 'a'.repeat(40);
  const stableId = '1'.repeat(32);
  let liveInstance = stableId;
  let applications = 0;
  const backend = createServer((req, res) => {
    if (req.url !== '/__hotswap' || req.method !== 'GET') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers['x-mcp-route-key'] !== key) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'router_auth_required' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      instanceId: liveInstance,
      routingAbi,
      jobsAbi,
      policyFingerprint: policyFingerprint(config),
      runtime: { release: revision },
      resources: { applications, recordings: 0 },
      exchanges: 0,
      activeCalls: 0,
      queuedCalls: 0,
      fenced: false,
    }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const address = backend.address();
  assert.ok(address && typeof address !== 'string');

  const router = await startRouter({
    config,
    key,
    port: 0,
    controlSocket: join(root, 'control.sock'),
    statePath: join(root, 'registry.json'),
  });
  const generation: Generation = {
    id: stableId,
    url: `http://127.0.0.1:${address.port}`,
    revision,
    unit: 'test-rebind.service',
    policyFingerprint: policyFingerprint(config),
  };
  try {
    let status = (await control(join(root, 'control.sock'), '/status')).body;
    assert.equal((await control(join(root, 'control.sock'), '/register', {
      expectedEpoch: status.epoch,
      generation,
    })).status, 200);
    status = (await control(join(root, 'control.sock'), '/status')).body;
    assert.equal((await control(join(root, 'control.sock'), '/activate', {
      expectedEpoch: status.epoch,
      id: stableId,
    })).status, 200);

    liveInstance = '2'.repeat(32);
    const staleInventory = await control(join(root, 'control.sock'), '/inventory', { id: stableId });
    assert.notEqual(staleInventory.status, 200, 'old runtime incarnation must remain fail-closed');

    status = (await control(join(root, 'control.sock'), '/status')).body;
    const rebound = await control(join(root, 'control.sock'), '/rebind', {
      expectedEpoch: status.epoch,
      id: stableId,
      instanceId: liveInstance,
    });
    assert.equal(rebound.status, 200, JSON.stringify(rebound.body));
    assert.equal(rebound.body.active, stableId, 'stable generation owner must not change');
    const descriptor = rebound.body.generations.find((item: Record<string, unknown>) => item.id === stableId);
    assert.equal(descriptor.instanceId, liveInstance);

    const inventory = await control(join(root, 'control.sock'), '/inventory', { id: stableId });
    assert.equal(inventory.status, 200, JSON.stringify(inventory.body));
    assert.equal(inventory.body.instanceId, liveInstance);

    liveInstance = '3'.repeat(32);
    applications = 1;
    status = (await control(join(root, 'control.sock'), '/status')).body;
    const refused = await control(join(root, 'control.sock'), '/rebind', {
      expectedEpoch: status.epoch,
      id: stableId,
      instanceId: liveInstance,
    });
    assert.notEqual(refused.status, 200);
    assert.equal(refused.body.error, 'REBIND_REQUIRES_IDLE_BACKEND');
    assert.equal((await control(join(root, 'control.sock'), '/status')).body.generations
      .find((item: Record<string, unknown>) => item.id === stableId).instanceId, '2'.repeat(32));
  } finally {
    await router.close();
    backend.closeAllConnections();
    await new Promise<void>(resolve => backend.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
