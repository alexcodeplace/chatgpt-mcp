import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeCommand, clampOutput, clampRuntime } from '../src/policy/shell.js';

const policy = {
  enabled: true,
  allowedCommands: ['git', 'node'],
  maxRuntimeMs: 10_000,
  maxOutputBytes: 4096,
} as const;

test('allowed executable passes', () => {
  assert.doesNotThrow(() => authorizeCommand('git', policy));
});

test('disabled shell rejects before command inspection', () => {
  assert.throws(() => authorizeCommand('git', { ...policy, enabled: false }), (error: unknown) => {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'CAPABILITY_DISABLED';
  });
});

test('unlisted executable rejects', () => {
  assert.throws(() => authorizeCommand('rm', policy), (error: unknown) => {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'COMMAND_NOT_ALLOWED';
  });
});

test('paths are not accepted as executable names', () => {
  assert.throws(() => authorizeCommand('/bin/git', { ...policy, allowedCommands: ['*'] }));
});

test('explicit wildcard allows executable names', () => {
  assert.doesNotThrow(() => authorizeCommand('printf', { ...policy, allowedCommands: ['*'] }));
});

test('runtime and output values clamp to configured maxima', () => {
  assert.equal(clampRuntime(undefined, 100), 100);
  assert.equal(clampRuntime(1000, 100), 100);
  assert.equal(clampRuntime(0, 100), 1);
  assert.equal(clampOutput(undefined, 200), 200);
  assert.equal(clampOutput(1000, 200), 200);
  assert.equal(clampOutput(0, 200), 1);
});
