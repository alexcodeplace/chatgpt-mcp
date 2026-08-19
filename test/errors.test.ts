import assert from 'node:assert/strict';
import test from 'node:test';
import { adapterError, isComputerAdapterError } from '../src/errors.js';

test('structural adapter errors are recognized without instanceof', () => {
  const error = adapterError('PATH_NOT_ALLOWED', 'fs.read', 'denied', { path: '/tmp/nope' });
  assert.equal(isComputerAdapterError(error), true);
  assert.equal(isComputerAdapterError({ code: 'UNKNOWN', operation: 'x', message: 'x' }), false);
});
