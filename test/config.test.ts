import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig, parseConfig } from '../src/config.js';

test('safe defaults expose no action capability authority', () => {
  const config = parseConfig({});
  assert.equal(config.concurrency.maxConcurrent, 48);
  assert.equal(config.concurrency.reservedControlSlots, 8);
  assert.equal(config.concurrency.shellMaxConcurrent, 8);
  assert.equal(config.concurrency.maxQueue, 64);
  assert.equal(config.concurrency.queueTimeoutMs, 30_000);
  assert.equal(config.http.host, '127.0.0.1');
  assert.equal(config.http.port, 3210);
  assert.deepEqual(config.http.allowedHosts, []);
  assert.deepEqual(config.http.allowedOrigins, []);
  assert.equal(config.filesystem.read, false);
  assert.equal(config.filesystem.write, false);
  assert.deepEqual(config.filesystem.roots, []);
  assert.deepEqual(config.filesystem.blocklist, []);
  assert.equal(config.shell.enabled, false);
  assert.deepEqual(config.shell.allowedCommands, []);
  assert.equal(config.process.list, false);
  assert.equal(config.process.kill, false);
  assert.equal(config.service.enabled, false);
  assert.deepEqual(config.service.allowedServices, []);
  assert.equal(config.application.enabled, false);
  assert.deepEqual(config.application.applications, {});
  assert.equal(config.browser.enabled, false);
  assert.deepEqual(config.browser.allowedSchemes, ['http', 'https']);
  assert.equal(config.desktop.hostDisplayAccess, false);
  assert.equal(config.desktop.screenRecording, false);
  assert.equal(config.desktop.screenCapture, false);
  assert.equal(config.desktop.input, false);
});

test('parsed configuration is deeply frozen', () => {
  const config = parseConfig({
    filesystem: { roots: ['/tmp'], blocklist: [{ path: '/tmp', message: 'blocked' }] },
    shell: { allowedCommands: ['node'] },
    service: { allowedServices: ['nginx'] },
    application: { applications: { editor: { command: 'editor', args: ['--new-window'] } } },
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.http), true);
  assert.equal(Object.isFrozen(config.filesystem), true);
  assert.equal(Object.isFrozen(config.filesystem.roots), true);
  assert.equal(Object.isFrozen(config.filesystem.blocklist), true);
  assert.equal(Object.isFrozen(config.filesystem.blocklist[0]), true);
  assert.equal(Object.isFrozen(config.shell.allowedCommands), true);
  assert.equal(Object.isFrozen(config.service.allowedServices), true);
  assert.equal(Object.isFrozen(config.application.applications), true);
  assert.equal(Object.isFrozen(config.application.applications.editor), true);
  assert.equal(Object.isFrozen(config.application.applications.editor?.args), true);
  assert.equal(Object.isFrozen(config.browser.allowedSchemes), true);
});


test('filesystem blocklist normalizes paths and defaults to freeze-children mode', () => {
  const config = parseConfig({ filesystem: { blocklist: [{ path: './relative-policy', message: 'Use the project .worktrees directory.' }] } });
  assert.equal(config.filesystem.blocklist.length, 1);
  assert.equal(config.filesystem.blocklist[0]?.mode, 'freeze-children');
  assert.equal(config.filesystem.blocklist[0]?.path.endsWith('/relative-policy'), true);
  assert.equal(config.filesystem.blocklist[0]?.message, 'Use the project .worktrees directory.');
});

test('environment overrides file transport settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-config-'));
  try {
    const file = join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ http: { host: '127.0.0.2', port: 3000 } }), 'utf8');
    const config = await loadConfig({
      CHATGPT_MCP_CONFIG: file,
      CHATGPT_MCP_HOST: '127.0.0.3',
      CHATGPT_MCP_PORT: '3333',
      CHATGPT_MCP_ALLOWED_HOSTS: 'localhost, mcp.internal',
      CHATGPT_MCP_ALLOWED_ORIGINS: 'localhost',
    });
    assert.equal(config.http.host, '127.0.0.3');
    assert.equal(config.http.port, 3333);
    assert.deepEqual(config.http.allowedHosts, ['localhost', 'mcp.internal']);
    assert.deepEqual(config.http.allowedOrigins, ['localhost']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('normalization lowercases browser schemes', () => {
  const config = parseConfig({ browser: { allowedSchemes: ['HTTPS', 'Custom+Thing'] } });
  assert.deepEqual(config.browser.allowedSchemes, ['https', 'custom+thing']);
});

test('malformed configuration fails closed', () => {
  assert.throws(() => parseConfig({ shell: { enabled: true, maxRuntimeMs: -1 } }));
  assert.throws(() => parseConfig({ http: { port: 70000 } }));
  assert.throws(() => parseConfig({ browser: { allowedSchemes: ['not a scheme'] } }));
  assert.throws(() => parseConfig({ application: { maxTracked: 0 } }));
  assert.throws(() => parseConfig({ concurrency: { maxConcurrent: 8, reservedControlSlots: 8 } }));
  assert.throws(() => parseConfig({ concurrency: { maxConcurrent: 8, reservedControlSlots: 2, shellMaxConcurrent: 7 } }));
});


test('Kubernetes execution is strictly opt-in and local-only by default', () => {
  const config = parseConfig({});
  assert.equal(config.execution.defaultBackend, 'local');
  assert.equal(config.execution.lightweightTimeoutMs, 30_000);
  assert.equal(config.execution.lightweightOutputBytes, 1024 * 1024);
  assert.equal(config.execution.localIsolation.enabled, false);
  assert.equal(config.execution.localIsolation.tasksMax, 512);
  assert.equal(config.execution.localIsolation.memoryMaxBytes, 4 * 1024 * 1024 * 1024);
  assert.equal(config.execution.localIsolation.cpuWeight, 10);
  assert.equal(config.execution.kubernetes.enabled, false);
  assert.equal(config.execution.kubernetes.client.command, 'kubectl');
  assert.equal(config.execution.kubernetes.remoteCommands.length, 0);
  assert.equal(config.execution.kubernetes.localOnlyCommands.length, 0);
});

test('Kubernetes execution requires an image only when explicitly enabled', () => {
  assert.doesNotThrow(() => parseConfig({ execution: { kubernetes: { enabled: false } } }));
  assert.throws(
    () => parseConfig({ execution: { kubernetes: { enabled: true } } }),
    /image is required when Kubernetes execution is enabled/,
  );
});

test('Kubernetes execution accepts cluster-specific values only through configuration', () => {
  const config = parseConfig({
    execution: {
      lightweightTimeoutMs: 12_345,
      kubernetes: {
        enabled: true,
        client: { command: 'clusterctl-wrapper', args: ['--profile', 'example'], kubeconfig: '/tmp/example-kubeconfig', context: 'example-context' },
        namespace: 'example-namespace',
        image: 'registry.example/executor:1',
        imagePullPolicy: 'Never',
        imagePullSecrets: ['registry-creds'],
        serviceAccount: 'executor-sa',
        remoteCommands: ['pnpm'],
        localOnlyCommands: ['systemctl'],
        heavyCommandPatterns: ['^npm test'],
        maxConcurrent: 17,
        workspace: { containerPath: '/custom-workspace', exclude: ['node_modules'], maxArchiveBytes: 123456 },
        resources: { requests: { cpu: '250m' }, limits: { memory: '2Gi' } },
        nodeSelector: { 'example.invalid/pool': 'build' },
        tolerations: [{ key: 'workload', operator: 'Equal', value: 'build', effect: 'NoSchedule' }],
        podLabels: { 'example.invalid/owner': 'tests' },
        podAnnotations: { 'example.invalid/note': 'configured' },
        volumes: [{ name: 'cache', emptyDir: {} }],
        volumeMounts: [{ name: 'cache', mountPath: '/cache' }],
        requiredCommands: ['node', 'pnpm'],
        requiredEnvironment: { CI: '1' },
        versionChecks: { node: { args: ['--version'], pattern: '^v24\\.' } },
      },
    },
  });
  assert.equal(config.execution.kubernetes.client.command, 'clusterctl-wrapper');
  assert.equal(config.execution.kubernetes.client.context, 'example-context');
  assert.equal(config.execution.kubernetes.namespace, 'example-namespace');
  assert.equal(config.execution.kubernetes.maxConcurrent, 17);
  assert.equal(config.execution.kubernetes.nodeSelector['example.invalid/pool'], 'build');
  assert.equal(config.execution.kubernetes.workspace.containerPath, '/custom-workspace');
});

test('invalid Kubernetes heavy routing regular expressions fail closed', () => {
  assert.throws(
    () => parseConfig({ execution: { kubernetes: { heavyCommandPatterns: ['[invalid'] } } }),
    /valid regular expression/,
  );
});


test('Kubernetes workspace volume name and mount path are reserved', () => {
  assert.throws(
    () => parseConfig({ execution: { kubernetes: { volumes: [{ name: 'chatgpt-mcp-workspace', emptyDir: {} }] } } }),
    /reserved for the isolated executor workspace/,
  );
  assert.throws(
    () => parseConfig({ execution: { kubernetes: { workspace: { containerPath: '/workspace' }, volumeMounts: [{ name: 'x', mountPath: '/workspace' }] } } }),
    /workspace path is reserved/,
  );
});


test('Kubernetes workspace preparation commands are opt-in argument arrays', () => {
  const config = parseConfig({ execution: { kubernetes: { workspace: { prepareCommands: [{ command: 'corepack', args: ['pnpm', 'install', '--frozen-lockfile'], whenFiles: ['pnpm-lock.yaml'], timeoutMs: 120000 }] } } } });
  assert.deepEqual(config.execution.kubernetes.workspace.prepareCommands, [{ command: 'corepack', args: ['pnpm', 'install', '--frozen-lockfile'], whenFiles: ['pnpm-lock.yaml'], timeoutMs: 120000 }]);
  assert.throws(() => parseConfig({ execution: { kubernetes: { workspace: { prepareCommands: [{ command: '/bin/sh', args: [] }] } } } }), /Invalid string/);
});


test('Kubernetes executor idle command is deployment-configurable without changing safe defaults', () => {
  const defaults = parseConfig({});
  assert.deepEqual(defaults.execution.kubernetes.idleCommand, ['sleep', 'infinity']);
  const configured = parseConfig({ execution: { kubernetes: { idleCommand: ['/usr/bin/tini', '--', 'sleep', 'infinity'] } } });
  assert.deepEqual(configured.execution.kubernetes.idleCommand, ['/usr/bin/tini', '--', 'sleep', 'infinity']);
});


test('Kubernetes required environment keys use portable environment-variable names', () => {
  assert.throws(
    () => parseConfig({ execution: { kubernetes: { requiredEnvironment: { 'BAD-NAME': 'value' } } } }),
    /Invalid string/,
  );
  const config = parseConfig({ execution: { kubernetes: { requiredEnvironment: { COREPACK_HOME: '/workspace/.corepack' } } } });
  assert.equal(config.execution.kubernetes.requiredEnvironment.COREPACK_HOME, '/workspace/.corepack');
});


test('Kubernetes preparation predicates reject workspace traversal', () => {
  assert.throws(
    () => parseConfig({ execution: { kubernetes: { workspace: { prepareCommands: [{ command: 'pnpm', whenFiles: ['../secret'] }] } } } }),
    /prepare predicate paths must stay inside the workspace/,
  );
});


test('local systemd isolation is explicitly opt-in and resource bounded', () => {
  const config = parseConfig({ execution: { localIsolation: { enabled: true, tasksMax: 768, memoryMaxBytes: 2147483648, cpuWeight: 20, stopTimeoutMs: 5000 } } });
  assert.equal(config.execution.localIsolation.enabled, true);
  assert.equal(config.execution.localIsolation.command, 'systemd-run');
  assert.equal(config.execution.localIsolation.managerCommand, 'systemctl');
  assert.equal(config.execution.localIsolation.tasksMax, 768);
  assert.equal(config.execution.localIsolation.memoryMaxBytes, 2147483648);
  assert.equal(config.execution.localIsolation.cpuWeight, 20);
  assert.equal(config.execution.localIsolation.stopTimeoutMs, 5000);
  assert.throws(() => parseConfig({ execution: { localIsolation: { tasksMax: 1 } } }));
  assert.throws(() => parseConfig({ execution: { localIsolation: { cpuWeight: 0 } } }));
});
