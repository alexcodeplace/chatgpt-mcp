import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/config.js';
import { buildSystemdRunArgs } from '../src/execution/systemd-isolated-process.js';

test('systemd isolation builds bounded argument-array execution without exposing environment values', () => {
  const isolation = parseConfig({ execution: { localIsolation: { enabled: true, tasksMax: 384, memoryMaxBytes: 1073741824, cpuWeight: 15 } } }).execution.localIsolation;
  const args = buildSystemdRunArgs(
    'chatgpt-mcp-exec-test',
    'git',
    ['status', '--short'],
    { cwd: '/tmp/project with spaces', env: { PATH: '/bin', SECRET_TOKEN: 'do-not-leak' } },
    isolation,
  );
  assert.ok(args.includes('--property=TasksMax=384'));
  assert.ok(args.includes('--property=MemoryMax=1073741824'));
  assert.ok(args.includes('--property=CPUWeight=15'));
  assert.ok(args.includes('--property=KillMode=control-group'));
  assert.ok(args.includes('--working-directory=/tmp/project with spaces'));
  assert.ok(args.includes('--setenv=PATH'));
  assert.ok(args.includes('--setenv=SECRET_TOKEN'));
  assert.equal(args.some(value => value.includes('do-not-leak')), false);
  assert.deepEqual(args.slice(-4), ['--', 'git', 'status', '--short']);
});
