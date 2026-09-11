import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/config.js';
import { buildSystemdRunArgs, serializeSystemdEnvironmentFile } from '../src/execution/systemd-isolated-process.js';

test('user-scope systemd isolation builds bounded argument-array execution without exposing environment values', () => {
  const isolation = parseConfig({ execution: { localIsolation: { enabled: true, tasksMax: 384, memoryMaxBytes: 1073741824, cpuWeight: 15 } } }).execution.localIsolation;
  const args = buildSystemdRunArgs(
    'chatgpt-mcp-exec-test',
    'git',
    ['status', '--short'],
    { cwd: '/tmp/project with spaces', env: { PATH: '/bin', SECRET_TOKEN: 'do-not-leak' } },
    isolation,
  );
  assert.ok(args.includes('--user'));
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



test('system-scope isolation stays explicit and does not use the user manager', () => {
  const isolation = parseConfig({ execution: { localIsolation: { enabled: true, scope: 'system' } } }).execution.localIsolation;
  const args = buildSystemdRunArgs(
    'chatgpt-mcp-exec-system-test',
    'git',
    ['status', '--short'],
    { cwd: '/tmp', env: { PATH: '/bin' } },
    isolation,
    '/run/chatgpt-mcp-shell-env/example.env',
  );
  assert.equal(args.includes('--user'), false);
  assert.ok(args.some(value => value.startsWith('--uid=')));
  assert.ok(args.some(value => value.startsWith('--gid=')));
  assert.ok(args.includes('--property=EnvironmentFile=/run/chatgpt-mcp-shell-env/example.env'));
});

test('systemd environment file serialization preserves shell-significant text without exposing it as syntax', () => {
  const serialized = serializeSystemdEnvironmentFile({
    SIMPLE: 'value',
    COMPLEX: 'space "quote" $dollar `tick` \\ slash\nnext line',
  });
  assert.match(serialized, /^COMPLEX=/m);
  assert.match(serialized, /^SIMPLE="value"$/m);
  assert.ok(serialized.includes('\\"quote\\"'));
  assert.ok(serialized.includes('\\$dollar'));
  assert.ok(serialized.includes('\\`tick\\`'));
  assert.ok(serialized.includes('\\\\ slash'));
  assert.ok(serialized.includes('next line'));
});
