import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RoutingComputerAdapter } from '../src/adapter/routing-computer-adapter.js';
import { canonicalInvocation, compileCommandPolicies, evaluateCommandPolicy } from '../src/policy/command-policy.js';
import { parseConfig } from '../src/config.js';
import { JobStore } from '../src/execution/job-store.js';

async function root(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'chatgpt-mcp-command-policy-'));
}

function errorWith(code: string, message?: string, ruleId?: string) {
  return (error: unknown): boolean => {
    const candidate = error as { code?: string; message?: string; details?: { ruleId?: string } };
    return candidate.code === code
      && (message === undefined || candidate.message === message)
      && (ruleId === undefined || candidate.details?.ruleId === ruleId);
  };
}

test('canonical invocation is deterministic and preserves argument boundaries', () => {
  assert.equal(
    canonicalInvocation({ command: '/custom/node', args: ['tool.js', 'two words', '--flag=value'] }),
    '["/custom/node","tool.js","two words","--flag=value"]',
  );
});

test('command policies are ordered and first match wins', async () => {
  const cwd = await root();
  try {
    const adapter = new RoutingComputerAdapter(parseConfig({
      filesystem: { roots: [cwd] },
      shell: { enabled: true, allowedCommands: ['pnpm'] },
      execution: {
        commandPolicies: [
          { id: 'permit-fast-test', match: { invocation: 'test:unit' }, action: { type: 'allow' } },
          { id: 'deny-tests', match: { invocation: 'test' }, action: { type: 'deny', message: 'Tests are blocked here.' } },
        ],
        kubernetes: { enabled: true, image: 'example.invalid/executor:1', remoteCommands: ['pnpm'] },
      },
    }));
    assert.equal(adapter.classifyExec({ command: 'pnpm', args: ['test:unit'], cwd }), 'shell-local');
    assert.throws(
      () => adapter.classifyExec({ command: 'pnpm', args: ['test:e2e'], cwd }),
      errorWith('COMMAND_NOT_ALLOWED', 'Tests are blocked here.', 'deny-tests'),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('policy routing catches alternate absolute executables before legacy command matching', async () => {
  const cwd = await root();
  try {
    const adapter = new RoutingComputerAdapter(parseConfig({
      filesystem: { roots: [cwd] },
      shell: { enabled: true, allowedCommands: ['+'] },
      execution: {
        commandPolicies: [{
          id: 'browser-tests-remote',
          match: { invocation: 'club-nav-tools/node26.*playwright' },
          action: { type: 'route', backend: 'kubernetes' },
        }],
        kubernetes: { enabled: true, image: 'example.invalid/executor:1' },
      },
    }));
    assert.equal(adapter.classifyExec({
      command: '/home/user/.cache/club-nav-tools/node26/bin/node',
      args: ['/repo/node_modules/playwright/cli.js', 'test'],
      cwd,
    }), 'shell-remote');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('explicit Kubernetes policy routes fail closed instead of falling back locally', async () => {
  const cwd = await root();
  try {
    const disabled = new RoutingComputerAdapter(parseConfig({
      filesystem: { roots: [cwd] },
      shell: { enabled: true, allowedCommands: ['pnpm'] },
      execution: {
        commandPolicies: [{ id: 'remote-builds', match: { invocation: 'build' }, action: { type: 'route', backend: 'kubernetes' } }],
        kubernetes: { enabled: false },
      },
    }));
    assert.throws(
      () => disabled.classifyExec({ command: 'pnpm', args: ['build'], cwd }),
      errorWith('CAPABILITY_DISABLED', undefined, 'remote-builds'),
    );

    const missingCwd = new RoutingComputerAdapter(parseConfig({
      shell: { enabled: true, allowedCommands: ['pnpm'] },
      execution: {
        commandPolicies: [{ id: 'remote-builds', match: { invocation: 'build' }, action: { type: 'route', backend: 'kubernetes' } }],
        kubernetes: { enabled: true, image: 'example.invalid/executor:1' },
      },
    }));
    assert.throws(
      () => missingCwd.classifyExec({ command: 'pnpm', args: ['build'] }),
      errorWith('INVALID_INPUT', undefined, 'remote-builds'),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('durable jobs enforce deny policies before reserving or launching work', async () => {
  const directory = await root();
  let launches = 0;
  try {
    const config = parseConfig({
      jobs: { enabled: true, directory: join(directory, 'jobs'), launcher: 'detached' },
      filesystem: { roots: [directory] },
      shell: { enabled: true, allowedCommands: ['node'] },
      execution: {
        commandPolicies: [{
          id: 'no-heavy-local',
          match: { invocation: 'worker-browser' },
          action: { type: 'deny', message: 'Heavy workloads are forbidden on this host; use the configured offloader.' },
        }],
      },
    });
    const store = new JobStore(config, async () => { launches += 1; });
    await assert.rejects(
      store.start('blocked-heavy-job', { command: 'node', args: ['worker-browser'], cwd: directory }),
      errorWith('COMMAND_NOT_ALLOWED', 'Heavy workloads are forbidden on this host; use the configured offloader.', 'no-heavy-local'),
    );
    assert.equal(launches, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pure policy evaluator matches command, canonical invocation and cwd together', () => {
  const config = parseConfig({
    execution: {
      commandPolicies: [{
        id: 'specific',
        match: { command: 'node$', invocation: 'playwright', cwd: '/repo/project$' },
        action: { type: 'deny', message: 'blocked' },
      }],
    },
  });
  const policies = compileCommandPolicies(config.execution.commandPolicies);
  assert.equal(
    evaluateCommandPolicy(policies, { command: '/usr/bin/node', args: ['playwright', 'test'], cwd: '/repo/project' })?.ruleId,
    'specific',
  );
  assert.equal(
    evaluateCommandPolicy(policies, { command: '/usr/bin/node', args: ['playwright', 'test'], cwd: '/repo/other' }),
    undefined,
  );
});
