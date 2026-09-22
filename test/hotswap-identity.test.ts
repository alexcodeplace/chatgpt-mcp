import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/config.js';
import { equalSecret, policyFingerprint } from '../src/hotswap/identity.js';

test('policy identity is stable across serialization and transport relocation, not grant changes', () => {
  const config = parseConfig({ shell: { enabled: true, allowedCommands: ['node'] } });
  const roundTrip = parseConfig(JSON.parse(JSON.stringify(config)));
  assert.equal(policyFingerprint(config), policyFingerprint(roundTrip));
  assert.equal(policyFingerprint(config), policyFingerprint(parseConfig({ ...roundTrip, http: { ...roundTrip.http, port: 3289 } })));
  assert.notEqual(policyFingerprint(config), policyFingerprint(parseConfig({ ...roundTrip, shell: { ...roundTrip.shell, enabled: false } })));
  assert.notEqual(policyFingerprint(config), policyFingerprint(parseConfig({ ...roundTrip, jobs: { ...roundTrip.jobs, directory: '/a-different-ledger' } })));
});

test('control authentication requires exact bytes', () => {
  assert.equal(equalSecret('one', 'one'), true);
  for (const value of ['on', 'one-extra', 'two', undefined, ['one']]) assert.equal(equalSecret(value, 'one'), false);
});
