import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RoutingComputerAdapter } from '../src/adapter/routing-computer-adapter.js';
import { parseConfig } from '../src/config.js';

async function root(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'chatgpt-mcp-routing-'));
}

test('disabled Kubernetes backend never changes local execution behavior or invokes its configured client', async () => {
  const cwd = await root();
  try {
    const config = parseConfig({
      filesystem: { roots: [cwd] },
      shell: { enabled: true, allowedCommands: ['node'], maxRuntimeMs: 2_000, maxOutputBytes: 4096 },
      execution: {
        kubernetes: {
          enabled: false,
          client: { command: 'this-client-must-never-be-invoked' },
          remoteCommands: ['node'],
        },
      },
    });
    const adapter = new RoutingComputerAdapter(config);
    const request = { command: 'node', args: ['-e', 'process.stdout.write("local")'], cwd } as const;
    assert.equal(adapter.classifyExec(request), 'shell-local');
    const result = await adapter.exec(request);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'local');
    const metrics = adapter.executionMetrics() as { routing: { local: number; remote: number } };
    assert.equal(metrics.routing.local, 1);
    assert.equal(metrics.routing.remote, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('routing is explicit, cwd-aware, and local-only rules win', async () => {
  const cwd = await root();
  try {
    const adapter = new RoutingComputerAdapter(parseConfig({
      filesystem: { roots: [cwd] },
      shell: { enabled: true, allowedCommands: ['pnpm', 'node', 'systemctl'] },
      execution: {
        kubernetes: {
          enabled: true,
          image: 'example.invalid/executor:1',
          remoteCommands: ['pnpm'],
          localOnlyCommands: ['systemctl'],
          heavyCommandPatterns: ['^node .*heavy'],
        },
      },
    }));
    assert.equal(adapter.classifyExec({ command: 'pnpm', args: ['test'], cwd, timeoutMs: 120_000 }), 'shell-remote');
    assert.equal(adapter.classifyExec({ command: 'pnpm', args: ['test'] }), 'shell-local');
    assert.equal(adapter.classifyExec({ command: 'systemctl', args: ['status', 'x'], cwd }), 'shell-local');
    assert.equal(adapter.classifyExec({ command: 'systemctl', args: ['status', 'x'], cwd, timeoutMs: 120_000 }), 'shell-local-long');
    assert.equal(adapter.classifyExec({ command: 'node', args: ['heavy', 'task'], cwd, timeoutMs: 120_000 }), 'shell-remote');
    assert.equal(adapter.classifyExec({ command: 'node', args: ['-e', ''], cwd }), 'shell-local');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('unknown commands remain local even when Kubernetes is enabled', async () => {
  const cwd = await root();
  try {
    const adapter = new RoutingComputerAdapter(parseConfig({
      filesystem: { roots: [cwd] },
      shell: { enabled: true, allowedCommands: ['git'] },
      execution: { kubernetes: { enabled: true, image: 'example.invalid/executor:1', remoteCommands: ['pnpm'] } },
    }));
    assert.equal(adapter.classifyExec({ command: 'git', args: ['status'], cwd }), 'shell-local');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});


test('local shell classification reserves the long-running class for explicit runtimes above the short default', async () => {
  const cwd = await root();
  try {
    const adapter = new RoutingComputerAdapter(parseConfig({
      filesystem: { roots: [cwd] },
      shell: { enabled: true, allowedCommands: ['bash'], maxRuntimeMs: 600_000, defaultRuntimeMs: 30_000 },
    }));
    assert.equal(adapter.classifyExec({ command: 'bash', args: ['-lc', 'echo short'], cwd }), 'shell-local');
    assert.equal(adapter.classifyExec({ command: 'bash', args: ['-lc', 'echo short'], cwd, timeoutMs: 30_000 }), 'shell-local');
    assert.equal(adapter.classifyExec({ command: 'bash', args: ['-lc', 'sleep 60'], cwd, timeoutMs: 30_001 }), 'shell-local-long');
    assert.equal(adapter.classifyExec({ command: 'bash', args: ['-lc', 'sleep 60'], cwd, timeoutMs: 900_000 }), 'shell-local-long');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
