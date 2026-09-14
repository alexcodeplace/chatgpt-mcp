import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { KeyManagerClient, brokerUrl } from '../src/key-manager/client.js';

const CREDENTIAL = 'synthetic-client-credential';
async function fixture(t: import('node:test').TestContext, reply: (url: URL, init: RequestInit) => Promise<Response>) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-kmgr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = join(root, 'client'); await writeFile(tokenFile, CREDENTIAL, { mode: 0o600 });
  const seen: Array<{ url: URL; init: RequestInit }> = [];
  const mock = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(url instanceof Request ? url.url : String(url));
    seen.push({ url: parsed, init });
    return reply(parsed, init);
  }) as typeof fetch;
  return { root, tokenFile, seen, client: new KeyManagerClient({ url: 'https://broker.example', tokenFile, timeoutMs: 1000 }, mock) };
}

test('name discovery strips every field except the exact key name', async t => {
  const f = await fixture(t, async () => Response.json({ keys: [{ name: 'cloudflare.project.api', secret: 'must-never-be-forwarded', secretFile: '/private/value', version: 1 }] }));
  assert.deepEqual(await f.client.list('project'), { keys: [{ name: 'cloudflare.project.api' }] });
  assert.equal(f.seen[0]?.url.searchParams.get('project'), 'project');
  assert.equal(new Headers(f.seen[0]?.init.headers).get('authorization'), `Bearer ${CREDENTIAL}`);
  assert.equal(f.seen[0]?.init.redirect, 'error');
});
test('profiles project only the available non-secret operation contract', async t => {
  const f = await fixture(t, async () => Response.json({ profiles: [{ id: 'deploy', version: 1, label: 'Deploy app', provider: 'synthetic', secret: 'hidden' }] }));
  assert.deepEqual(await f.client.profiles('synthetic.app.api'), { profiles: [{ id: 'deploy', version: 1, label: 'Deploy app', provider: 'synthetic' }] });
});
test('pending operation preserves its durable handle without granting owner authority', async t => {
  const f = await fixture(t, async () => Response.json({ status: 'pending', secret: 'hidden', request: { id: 'KMGR-0123456789', revision: 1, state: 'pending', secretFile: 'hidden' } }, { status: 202 }));
  const input = { project: 'project', keyName: 'synthetic.api', profileId: 'use', input: { resource: 'demo' }, idempotencyKey: 'one-operation' };
  assert.deepEqual(await f.client.run(input), { status: 'pending', request: { id: 'KMGR-0123456789', revision: 1, state: 'pending' } });
  assert.deepEqual(JSON.parse(String(f.seen[0]?.init.body)), input);
  assert.equal(f.seen[0]?.url.pathname, '/v1/operations');
});
test('a standing denial is data, not a lost operation or a prompt to retry', async t => {
  const f = await fixture(t, async () => Response.json({ status: 'denied', reason: 'standing-denial', rule: { id: 'rule', effect: 'deny', scope: { account: 'acct', resource: 'app' }, secret: 'hidden' } }, { status: 403 }));
  assert.deepEqual(await f.client.run({ project: 'p', keyName: 'k', profileId: 'use', input: {}, idempotencyKey: 'i' }), {
    status: 'denied', reason: 'standing-denial', rule: { id: 'rule', effect: 'deny', scope: { account: 'acct', resource: 'app' } },
  });
});
test('status addresses only the named request rather than fetching every request', async t => {
  const f = await fixture(t, async () => Response.json({ request: { id: 'KMGR-0123456789', state: 'pending', privateField: 'hidden' } }));
  assert.deepEqual(await f.client.status('KMGR-0123456789'), { request: { id: 'KMGR-0123456789', state: 'pending' } });
  assert.equal(f.seen[0]?.url.pathname, '/v1/requests/KMGR-0123456789');
  await assert.rejects(f.client.status('../owner/keys'), /valid KMGR or JOB/);
});
test('network and server diagnostics cannot disclose the client credential', async t => {
  const failed = await fixture(t, async () => { throw new Error(`network ${CREDENTIAL}`); });
  await assert.rejects(failed.client.list(), error => String(error).includes('unavailable') && !String(error).includes(CREDENTIAL));
  const server = await fixture(t, async () => Response.json({ error: CREDENTIAL }, { status: 500 }));
  await assert.rejects(server.client.list(), error => String(error).includes('HTTP 500') && !String(error).includes(CREDENTIAL));
});
test('an oversized streaming response is stopped at the byte limit', async t => {
  const f = await fixture(t, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(f.client.list(), /exceeded client limit/);
});
test('credential files must be private and may not be symbolic links', async t => {
  const f = await fixture(t, async () => Response.json({ keys: [] }));
  await chmod(f.tokenFile, 0o644);
  await assert.rejects(f.client.list(), /not private/);
  await rm(f.tokenFile); const target = join(f.root, 'elsewhere'); await writeFile(target, CREDENTIAL, { mode: 0o600 }); await symlink(target, f.tokenFile);
  await assert.rejects(f.client.list(), /not private/);
  assert.equal(f.seen.length, 0);
});
test('unparseable server data is rejected without echoing it', async t => {
  const f = await fixture(t, async () => new Response(`not-json ${CREDENTIAL}`));
  await assert.rejects(f.client.list(), error => String(error).includes('could not be read') && !String(error).includes(CREDENTIAL));
});
test('caller cancellation reaches the transport without introducing a second credential path', async t => {
  const controller = new AbortController(); controller.abort();
  const f = await fixture(t, async (_url, init) => { assert.equal(init.signal?.aborted, true); throw new DOMException('aborted', 'AbortError'); });
  await assert.rejects(f.client.list(undefined, controller.signal), /cancelled/);
});
test('broker URLs reject credential URLs, remote plaintext and non-HTTP protocols', () => {
  for (const url of ['http://remote.example', 'ftp://localhost', 'https://owner:password@broker.example', 'https://broker.example/?token=value']) assert.throws(() => brokerUrl(url));
  for (const url of ['https://broker.example', 'http://127.0.0.1:4987', 'http://[::1]:4987']) assert.equal(brokerUrl(url).href, `${url}/`);
});
