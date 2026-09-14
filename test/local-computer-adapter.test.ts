import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalComputerAdapter } from '../src/adapter/local-computer-adapter.js';
import { parseConfig } from '../src/config.js';


async function waitForPidFile(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = Number((await readFile(path, 'utf8')).trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      // Process has not written the file yet.
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for child PID file: ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Descendant process ${pid} survived bounded command termination.`);
}

function descendantScript(): string {
  return [
    `const {spawn}=require('node:child_process');`,
    `const {writeFileSync}=require('node:fs');`,
    `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});`,
    `writeFileSync(process.argv[1],String(child.pid));`,
    `setInterval(()=>{},1000);`,
  ].join('');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-adapter-'));
  const config = parseConfig({
    filesystem: { read: true, write: true, roots: [root], maxReadBytes: 1024, maxWriteBytes: 1024 },
    shell: { enabled: true, allowedCommands: ['node'], maxRuntimeMs: 2_000, maxOutputBytes: 1024, allowEnvironment: false },
    process: { list: true, kill: true },
  });
  return { root, adapter: new LocalComputerAdapter(config) };
}

test('system info returns host-neutral fields', async () => {
  const { root, adapter } = await fixture();
  try {
    const info = await adapter.systemInfo();
    assert.ok(info.hostname.length > 0);
    assert.ok(info.platform.length > 0);
    assert.ok(info.architecture.length > 0);
    assert.ok(info.uptimeSeconds >= 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filesystem lifecycle stays inside configured root', async () => {
  const { root, adapter } = await fixture();
  try {
    const directory = join(root, 'dir');
    const first = join(directory, 'a.txt');
    const moved = join(directory, 'b.txt');
    await adapter.makeDirectory(directory, false);
    await adapter.writeFile(first, 'one', 'create');
    await adapter.writeFile(first, '+two', 'append');
    assert.equal(await adapter.readFile(first), 'one+two');
    const entries = await adapter.listDirectory(directory);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.name, 'a.txt');
    assert.equal(entries[0]?.type, 'file');
    await adapter.movePath(first, moved);
    assert.equal(await readFile(moved, 'utf8'), 'one+two');
    await adapter.deletePath(moved, false);
    await adapter.deletePath(directory, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filesystem blocklist freezes direct entries while allowing work inside existing children', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-blocklist-adapter-'));
  const existing = join(root, 'existing-project');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(existing));
  const message = 'Creating folders at ~/Projects/ is not allowed. if you need to create a worktree, create it under .worktrees/ in the project folder you are working on';
  const adapter = new LocalComputerAdapter(parseConfig({
    filesystem: {
      read: true,
      write: true,
      roots: [root],
      blocklist: [{ path: root, message }],
      maxReadBytes: 1024,
      maxWriteBytes: 1024,
    },
  }));
  try {
    await assert.rejects(
      () => adapter.makeDirectory(join(root, 'new-project'), false),
      (error: unknown) => {
        const candidate = error as { code?: string; message?: string };
        return candidate.code === 'PATH_NOT_ALLOWED' && candidate.message === message;
      },
    );
    await assert.rejects(
      () => adapter.writeFile(join(root, 'new-file.txt'), 'x', 'create'),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
    const nested = join(existing, 'nested');
    await adapter.makeDirectory(nested, false);
    await adapter.writeFile(join(nested, 'ok.txt'), 'ok', 'create');
    assert.equal(await adapter.readFile(join(nested, 'ok.txt')), 'ok');
    await assert.rejects(
      () => adapter.movePath(existing, join(root, 'renamed-project')),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
    await assert.rejects(
      () => adapter.deletePath(existing, true),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filesystem blocklist does not force local isolation and guards direct mkdir/rmdir/rm only at the protected parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-blocklist-shell-'));
  const existing = join(root, 'existing-project');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(existing));
  const adapter = new LocalComputerAdapter(parseConfig({
    filesystem: { read: true, write: true, roots: [root], blocklist: [{ path: root, message: 'frozen' }] },
    shell: { enabled: true, allowedCommands: ['node', 'mkdir', 'rmdir', 'rm'], maxRuntimeMs: 2_000, maxOutputBytes: 4096 },
    execution: { localIsolation: { enabled: false, command: '/definitely-missing-systemd-run' } },
  }));
  try {
    const ordinary = await adapter.exec({ command: 'node', args: ['-e', 'process.stdout.write("direct")'], cwd: existing });
    assert.equal(ordinary.exitCode, 0);
    assert.equal(ordinary.stdout, 'direct');

    await assert.rejects(
      () => adapter.exec({ command: 'mkdir', args: [join(root, 'new-project')], cwd: existing }),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
    const nested = join(existing, 'nested');
    const mkdirNested = await adapter.exec({ command: 'mkdir', args: [nested], cwd: existing });
    assert.equal(mkdirNested.exitCode, 0);
    const rmdirNested = await adapter.exec({ command: 'rmdir', args: [nested], cwd: existing });
    assert.equal(rmdirNested.exitCode, 0);

    await assert.rejects(
      () => adapter.exec({ command: 'rmdir', args: [existing], cwd: root }),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
    await assert.rejects(
      () => adapter.exec({ command: 'rm', args: ['-rf', existing], cwd: root }),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filesystem read and write limits fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-limits-'));
  const config = parseConfig({
    filesystem: { read: true, write: true, roots: [root], maxReadBytes: 4, maxWriteBytes: 4 },
  });
  const adapter = new LocalComputerAdapter(config);
  try {
    await assert.rejects(() => adapter.writeFile(join(root, 'large.txt'), '12345', 'create'), (error: unknown) => {
      return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'OUTPUT_LIMIT';
    });
    await adapter.writeFile(join(root, 'small.txt'), '1234', 'create');
    await assert.rejects(() => adapter.readFile(join(root, 'small.txt'), 3), (error: unknown) => {
      return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'OUTPUT_LIMIT';
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('disabled filesystem capabilities reject adapter calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-disabled-'));
  const adapter = new LocalComputerAdapter(parseConfig({ filesystem: { roots: [root] } }));
  try {
    await assert.rejects(() => adapter.listDirectory(root), (error: unknown) => {
      return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'CAPABILITY_DISABLED';
    });
    await assert.rejects(() => adapter.writeFile(join(root, 'x'), 'x', 'create'), (error: unknown) => {
      return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'CAPABILITY_DISABLED';
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell exec returns stdout and non-zero exits as normal results', async () => {
  const { root, adapter } = await fixture();
  try {
    const ok = await adapter.exec({ command: 'node', args: ['-e', 'process.stdout.write("ok")'], cwd: root });
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.stdout, 'ok');
    assert.equal(ok.timedOut, false);

    const nonzero = await adapter.exec({ command: 'node', args: ['-e', 'process.exit(7)'], cwd: root });
    assert.equal(nonzero.exitCode, 7);
    assert.equal(nonzero.timedOut, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wildcard executes an absolute binary while absolute mutation commands still respect the blocklist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-executable-path-'));
  const adapter = new LocalComputerAdapter(parseConfig({
    filesystem: { roots: [root], blocklist: [{ path: root, mode: 'freeze-children' }] },
    shell: { enabled: true, allowedCommands: ['*'] },
  }));
  try {
    const result = await adapter.exec({ command: process.execPath, args: ['-e', 'process.stdout.write("ordinary output")'], cwd: root });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'ordinary output');
    await assert.rejects(
      () => adapter.exec({ command: '/bin/mkdir', args: [join(root, 'blocked-child')], cwd: root }),
      (error: unknown) => (error as { code?: string }).code === 'PATH_NOT_ALLOWED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell timeout terminates the child and reports timedOut', async () => {
  const { root, adapter } = await fixture();
  try {
    const result = await adapter.exec({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: root,
      timeoutMs: 25,
    });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell commands without an explicit timeout use the bounded short default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-default-timeout-'));
  const adapter = new LocalComputerAdapter(parseConfig({
    filesystem: { roots: [root] },
    shell: { enabled: true, allowedCommands: ['node'], maxRuntimeMs: 1_000, defaultRuntimeMs: 50, maxOutputBytes: 4096 },
  }));
  try {
    const implicit = await adapter.exec({ command: 'node', args: ['-e', 'setTimeout(() => {}, 500)'], cwd: root });
    assert.equal(implicit.timedOut, true);

    const explicit = await adapter.exec({ command: 'node', args: ['-e', 'setTimeout(() => {}, 20)'], cwd: root, timeoutMs: 500 });
    assert.equal(explicit.timedOut, false);
    assert.equal(explicit.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell output limit terminates execution with OUTPUT_LIMIT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-output-'));
  const adapter = new LocalComputerAdapter(parseConfig({
    filesystem: { roots: [root] },
    shell: { enabled: true, allowedCommands: ['node'], maxRuntimeMs: 2_000, maxOutputBytes: 32 },
  }));
  try {
    await assert.rejects(
      () => adapter.exec({ command: 'node', args: ['-e', 'process.stdout.write("x".repeat(1000))'], cwd: root }),
      (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'OUTPUT_LIMIT',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('caller environment is rejected unless explicitly enabled', async () => {
  const { root, adapter } = await fixture();
  try {
    await assert.rejects(
      () => adapter.exec({ command: 'node', args: ['-e', ''], cwd: root, env: { TEST_VALUE: 'x' } }),
      (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'CAPABILITY_DISABLED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host display denial strips inherited desktop session environment from shell children', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-display-env-'));
  const previous = {
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    MIR_SOCKET: process.env.MIR_SOCKET,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  };
  Object.assign(process.env, {
    DISPLAY: ':99',
    WAYLAND_DISPLAY: 'wayland-test',
    XAUTHORITY: '/tmp/test-xauthority',
    MIR_SOCKET: '/tmp/test-mir',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/test-bus',
  });
  const adapter = new LocalComputerAdapter(parseConfig({
    filesystem: { roots: [root] },
    shell: { enabled: true, allowedCommands: ['node'], maxRuntimeMs: 2_000, maxOutputBytes: 4096, allowEnvironment: true },
    desktop: { hostDisplayAccess: false },
  }));
  try {
    const result = await adapter.exec({
      command: 'node',
      args: ['-e', 'process.stdout.write(JSON.stringify({DISPLAY:process.env.DISPLAY,WAYLAND_DISPLAY:process.env.WAYLAND_DISPLAY,XAUTHORITY:process.env.XAUTHORITY,MIR_SOCKET:process.env.MIR_SOCKET,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}))'],
      cwd: root,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
    await assert.rejects(
      () => adapter.exec({ command: 'node', args: ['-e', ''], cwd: root, env: { DISPLAY: ':0' } }),
      (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'CAPABILITY_DISABLED',
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('shell exec blocks obvious host capture bypasses before process spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-capture-guard-'));
  const adapter = new LocalComputerAdapter(parseConfig({
    filesystem: { roots: [root] },
    shell: { enabled: true, allowedCommands: ['*'], maxRuntimeMs: 2_000, maxOutputBytes: 4096, allowEnvironment: true },
    desktop: { hostDisplayAccess: false },
  }));
  try {
    await assert.rejects(
      () => adapter.exec({ command: 'python3', args: ['-c', 'import pyautogui; pyautogui.screenshot()'], cwd: root }),
      (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'COMMAND_NOT_ALLOWED',
    );
    await assert.rejects(
      () => adapter.exec({ command: 'bash', args: ['-lc', 'ffmpeg -f x11grab -i :0 /tmp/shot.png'], cwd: root }),
      (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'COMMAND_NOT_ALLOWED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('process listing includes the current test process', async () => {
  const { root, adapter } = await fixture();
  try {
    const processes = await adapter.listProcesses();
    assert.ok(processes.some(item => item.pid === process.pid));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('process kill terminates a disposable child', async () => {
  const { root, adapter } = await fixture();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    assert.ok(child.pid);
    await adapter.killProcess(child.pid!, 'SIGTERM');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    assert.notEqual(child.exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});


test('shell cancellation terminates the complete descendant process group', { skip: process.platform === 'win32' }, async () => {
  const { root, adapter } = await fixture();
  const pidFile = join(root, 'cancel-child.pid');
  const abort = new AbortController();
  try {
    const execution = adapter.exec({
      command: 'node',
      args: ['-e', descendantScript(), pidFile],
      cwd: root,
      timeoutMs: 2_000,
      signal: abort.signal,
    });
    const childPid = await waitForPidFile(pidFile);
    abort.abort();
    await assert.rejects(
      () => execution,
      (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'CANCELLED',
    );
    await waitForProcessExit(childPid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell timeout terminates descendants in the command process group', { skip: process.platform === 'win32' }, async () => {
  const { root, adapter } = await fixture();
  const pidFile = join(root, 'timeout-child.pid');
  try {
    const execution = adapter.exec({
      command: 'node',
      args: ['-e', descendantScript(), pidFile],
      cwd: root,
      timeoutMs: 100,
    });
    const childPid = await waitForPidFile(pidFile);
    const result = await execution;
    assert.equal(result.timedOut, true);
    await waitForProcessExit(childPid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
