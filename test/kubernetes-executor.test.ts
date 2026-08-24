import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseConfig } from '../src/config.js';
import { KubernetesExecutor } from '../src/execution/kubernetes-executor.js';
import { ExecutionMetrics } from '../src/execution/metrics.js';

async function fakeClientFixture(mode = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-fake-kube-'));
  const client = join(root, 'client.mjs');
  const log = join(root, 'calls.jsonl');
  const workspace = join(root, 'workspace');
  await writeFile(join(root, 'source.txt'), 'snapshot-content');
  await writeFile(client, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const [log, mode, ...args] = process.argv.slice(2);
const workspaceTransfer = args.includes('exec') && args.includes('-i') && args.includes('tar');
if (mode === 'workspace-close' && workspaceTransfer) {
  appendFileSync(log, JSON.stringify({ args, stdinBytes: 0, earlyClose: true }) + '\\n');
  process.stdin.destroy();
  process.exit(7);
}
let stdin = Buffer.alloc(0);
for await (const chunk of process.stdin) stdin = Buffer.concat([stdin, Buffer.from(chunk)]);
const record = { args, stdinBytes: stdin.length };
if (args.includes('create') && stdin.length) { try { record.manifest = JSON.parse(stdin.toString('utf8')); } catch {} }
appendFileSync(log, JSON.stringify(record) + '\\n');
if (args.includes('get') && args.includes('pods') && args.includes('-o') && args.includes('json')) { process.stdout.write(JSON.stringify({ items: mode === 'orphan' ? [{ metadata: { name: 'expired-pod', annotations: { 'chatgpt-mcp.openai.com/created-at': '2000-01-01T00:00:00.000Z' } } }] : [] })); process.exit(0); }
if (args.includes('wait')) process.exit(mode === 'wait-fail' ? 1 : 0);
if (args.includes('delete')) process.exit(0);
const separator = args.lastIndexOf('--');
const command = separator >= 0 ? args.slice(separator + 1) : [];
if (command[0] === 'sh' && command[1] === '-c') { process.stdout.write('\\x1eCHATGPT_MCP_VERSION_0\\x1e\\nv24.18.0\\n'); process.exit(0); }
if (command[0] === 'node' && command[1] === '--version') { process.stdout.write('v24.18.0\\n'); process.exit(0); }
if (command[0] === 'mkdir' || command[0] === 'tar') process.exit(0);
if (mode === 'command-fail' && command.length) { process.stderr.write('remote failed'); process.exit(7); }
if (mode === 'command-sleep' && command.length) setTimeout(() => process.exit(0), 60000);
else if (command.length) process.stdout.write('remote-ok');
`, 'utf8');
  await chmod(client, 0o755);
  return { root, client, log, workspace };
}

async function calls(path: string): Promise<Array<{ args: string[]; stdinBytes: number; manifest?: Record<string, any> }>> {
  const text = await readFile(path, 'utf8');
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function configFor(client: string, log: string, mode: string) {
  return parseConfig({
    shell: { enabled: true, allowedCommands: ['node'], maxRuntimeMs: 5_000, maxOutputBytes: 4096, allowEnvironment: true },
    execution: {
      kubernetes: {
        enabled: true,
        client: { command: process.execPath, args: [client, log, mode], kubeconfig: '/configured/kubeconfig', context: 'configured-context' },
        namespace: 'configured-namespace',
        image: 'registry.example/executor:24',
        imagePullPolicy: 'Never',
        imagePullSecrets: ['pull-secret'],
        serviceAccount: 'configured-sa',
        workspace: { containerPath: '/configured-workspace', maxArchiveBytes: 1024 * 1024, prepareCommands: [{ command: 'node', args: ['--version'], whenFiles: ['source.txt'], timeoutMs: 300_000 }] },
        resources: { requests: { cpu: '250m' }, limits: { memory: '2Gi' } },
        nodeSelector: { 'example.invalid/pool': 'build' },
        tolerations: [{ key: 'workload', operator: 'Equal', value: 'build', effect: 'NoSchedule' }],
        podLabels: { 'example.invalid/test': 'true' },
        podAnnotations: { 'example.invalid/annotation': 'configured' },
        requiredCommands: ['node'],
        requiredEnvironment: { COREPACK_HOME: '/configured-workspace/.corepack' },
        versionChecks: { node: { args: ['--version'], pattern: '^v24\\.' } },
      },
    },
  });
}

test('generic Kubernetes executor uses only configured cluster/image/policy values and cleans its pod', async () => {
  const fixture = await fakeClientFixture();
  try {
    const config = configFor(fixture.client, fixture.log, 'ok');
    const metrics = new ExecutionMetrics();
    const executor = new KubernetesExecutor(config, metrics);
    const result = await executor.exec({ command: 'node', args: ['-e', 'ignored'], cwd: fixture.root, env: { TEST: '1', COREPACK_HOME: '/caller-override' } }, 5_000, 4096);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'remote-ok');
    const records = await calls(fixture.log);
    const create = records.find(record => record.args.includes('create'));
    assert.ok(create?.manifest);
    assert.equal(create.manifest!.metadata.namespace, 'configured-namespace');
    assert.equal(create.manifest!.spec.serviceAccountName, 'configured-sa');
    assert.deepEqual(create.manifest!.spec.nodeSelector, { 'example.invalid/pool': 'build' });
    assert.equal(create.manifest!.spec.containers[0].image, 'registry.example/executor:24');
    assert.equal(create.manifest!.spec.containers[0].imagePullPolicy, 'Never');
    assert.equal(create.manifest!.spec.containers[0].workingDir, '/configured-workspace');
    assert.equal(create.manifest!.spec.activeDeadlineSeconds, 425);
    assert.ok(create.manifest!.spec.containers[0].volumeMounts.some((mount: { name: string; mountPath: string }) => mount.name === 'chatgpt-mcp-workspace' && mount.mountPath === '/configured-workspace'));
    assert.ok(create.manifest!.spec.volumes.some((volume: { name: string; emptyDir?: object }) => volume.name === 'chatgpt-mcp-workspace' && volume.emptyDir !== undefined));
    assert.ok(records.some(record => record.args.includes('--kubeconfig') && record.args.includes('/configured/kubeconfig')));
    assert.ok(records.some(record => record.args.includes('--context') && record.args.includes('configured-context')));
    assert.ok(records.some(record => record.args.includes('delete')));
    assert.equal(records.filter(record => record.args.includes('exec') && record.args.includes('sh') && record.args.includes('-c')).length, 1);
    const prepared = records.find(record => record.args.includes('node') && record.args.includes('--version') && record.args.includes('COREPACK_HOME=/configured-workspace/.corepack'));
    assert.ok(prepared?.args.includes('env'));
    assert.ok(prepared?.args.includes('--'));
    const executed = records.find(record => record.args.includes('-e') && record.args.includes('ignored'));
    assert.ok(executed?.args.includes('env'));
    assert.ok(executed?.args.includes('--'));
    assert.ok(executed?.args.includes('TEST=1'));
    assert.ok(executed?.args.includes('COREPACK_HOME=/configured-workspace/.corepack'));
    assert.ok(!executed?.args.includes('COREPACK_HOME=/caller-override'));
    assert.ok(records.some(record => record.stdinBytes > 0 && record.args.includes('-i')));
    const transfer = records.find(record => record.stdinBytes > 0 && record.args.includes('-i'));
    assert.ok(transfer?.args.includes('--no-same-owner'));
    assert.ok(transfer?.args.includes('--no-same-permissions'));
    assert.ok(transfer?.args.includes('--touch'));
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.kubernetes.podsCreated, 1);
    assert.equal(snapshot.kubernetes.podsStarted, 1);
    assert.equal(snapshot.kubernetes.commandsCompleted, 1);
    assert.equal(snapshot.kubernetes.cleanupSucceeded, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Kubernetes startup failure is bounded and still runs cleanup', async () => {
  const fixture = await fakeClientFixture('wait-fail');
  try {
    const config = configFor(fixture.client, fixture.log, 'wait-fail');
    const executor = new KubernetesExecutor(config, new ExecutionMetrics());
    await assert.rejects(
      () => executor.exec({ command: 'node', args: [], cwd: fixture.root }, 5_000, 4096),
      (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'OS_ERROR',
    );
    assert.ok((await calls(fixture.log)).some(record => record.args.includes('delete')));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Kubernetes command cancellation kills the client execution and cleans the pod', async () => {
  const fixture = await fakeClientFixture('command-sleep');
  try {
    const config = configFor(fixture.client, fixture.log, 'command-sleep');
    const executor = new KubernetesExecutor(config, new ExecutionMetrics());
    const abort = new AbortController();
    const running = executor.exec({ command: 'node', args: ['-e', 'ignored'], cwd: fixture.root, signal: abort.signal }, 5_000, 4096);
    setTimeout(() => abort.abort(), 200).unref();
    await assert.rejects(
      () => running,
      (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'CANCELLED',
    );
    assert.ok((await calls(fixture.log)).some(record => record.args.includes('delete')));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});


test('expired owned Kubernetes pods are reaped before new remote work', async () => {
  const fixture = await fakeClientFixture('orphan');
  try {
    const config = configFor(fixture.client, fixture.log, 'orphan');
    const metrics = new ExecutionMetrics();
    const executor = new KubernetesExecutor(config, metrics);
    const result = await executor.exec({ command: 'node', args: ['-e', 'ignored'], cwd: fixture.root }, 5_000, 4096);
    assert.equal(result.exitCode, 0);
    const records = await calls(fixture.log);
    assert.ok(records.some(record => record.args.includes('delete') && record.args.includes('expired-pod')));
    assert.equal(metrics.snapshot().kubernetes.orphansReaped, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});


test('Kubernetes preparation commands skip when workspace predicates do not match', async () => {
  const fixture = await fakeClientFixture();
  try {
    const base = configFor(fixture.client, fixture.log, 'ok');
    const config = parseConfig({
      ...base,
      execution: {
        ...base.execution,
        kubernetes: {
          ...base.execution.kubernetes,
          workspace: {
            ...base.execution.kubernetes.workspace,
            prepareCommands: [{ command: 'node', args: ['--version'], whenFiles: ['missing.lock'], timeoutMs: 300_000 }],
          },
        },
      },
    });
    const executor = new KubernetesExecutor(config, new ExecutionMetrics());
    const result = await executor.exec({ command: 'node', args: ['-e', 'ignored'], cwd: fixture.root }, 5_000, 4096);
    assert.equal(result.exitCode, 0);
    const records = await calls(fixture.log);
    const prepRuns = records.filter(record => record.args.includes('node') && record.args.includes('--version') && record.args.includes('exec'));
    assert.equal(prepRuns.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});


test('Kubernetes workspace pipe closure is contained and cleanup still runs', async () => {
  const fixture = await fakeClientFixture('workspace-close');
  try {
    await writeFile(join(fixture.root, 'large.bin'), Buffer.alloc(8 * 1024 * 1024, 'x'));
    const config = configFor(fixture.client, fixture.log, 'workspace-close');
    const executor = new KubernetesExecutor(config, new ExecutionMetrics());
    await assert.rejects(
      () => executor.exec({ command: 'node', args: ['-e', 'ignored'], cwd: fixture.root }, 5_000, 4096),
      (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'OS_ERROR',
    );
    const records = await calls(fixture.log);
    assert.ok(records.some(record => record.args.includes('-i') && (record as { earlyClose?: boolean }).earlyClose === true));
    assert.ok(records.some(record => record.args.includes('delete')));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
