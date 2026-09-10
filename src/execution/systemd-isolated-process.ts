import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChatGptMcpConfig } from '../config.js';
import type { ExecResult } from '../adapter/computer-adapter.js';
import { adapterError } from '../errors.js';
import type { FilesystemMountPolicy } from '../policy/filesystem.js';
import { spawnBounded, type BoundedProcessOptions } from './bounded-process.js';

type LocalIsolationConfig = Readonly<ChatGptMcpConfig['execution']['localIsolation']>;

const UNIT_PREFIX = 'chatgpt-mcp-exec';
const SYSTEM_ENV_DIR = '/run/chatgpt-mcp-shell-env';
const ADMIN_TIMEOUT_MS = 10_000;
const ADMIN_OUTPUT_BYTES = 64 * 1024;

function filesystemPolicyActive(filesystem: FilesystemMountPolicy | undefined): boolean {
  return filesystem !== undefined && filesystem.readOnlyPaths.length > 0;
}

function quoteEnvironmentFileValue(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`')}"`;
}

export function serializeSystemdEnvironmentFile(env: NodeJS.ProcessEnv): string {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${quoteEnvironmentFileValue(value)}`)
    .join('\n') + '\n';
}

function systemdCommandInvocation(isolation: LocalIsolationConfig, args: readonly string[]): { command: string; args: string[] } {
  if (isolation.scope === 'user') return { command: isolation.command, args: [...args] };
  return {
    command: isolation.privilegeCommand,
    args: [...isolation.privilegeArgs, isolation.command, ...args],
  };
}

function systemctlCommandInvocation(isolation: LocalIsolationConfig, args: readonly string[]): { command: string; args: string[] } {
  if (isolation.scope === 'user') return { command: isolation.managerCommand, args: ['--user', ...args] };
  return {
    command: isolation.privilegeCommand,
    args: [...isolation.privilegeArgs, isolation.managerCommand, ...args],
  };
}

export function buildSystemdRunArgs(
  unit: string,
  command: string,
  args: readonly string[],
  options: Pick<BoundedProcessOptions, 'cwd' | 'env'>,
  isolation: LocalIsolationConfig,
  filesystem?: FilesystemMountPolicy,
  environmentFile?: string,
): string[] {
  const runArgs = [
    ...(isolation.scope === 'user' ? ['--user'] : []),
    '--quiet',
    '--wait',
    '--pipe',
    '--collect',
    '--expand-environment=no',
    `--unit=${unit}`,
    `--property=TasksMax=${isolation.tasksMax}`,
    `--property=MemoryMax=${isolation.memoryMaxBytes}`,
    `--property=CPUWeight=${isolation.cpuWeight}`,
    '--property=KillMode=control-group',
    '--property=SendSIGKILL=yes',
    '--property=TimeoutStopSec=1s',
  ];

  if (isolation.scope === 'system') {
    if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
      throw adapterError('CAPABILITY_DISABLED', 'shell.exec', 'System-scope local isolation requires POSIX uid/gid support.');
    }
    runArgs.push(`--uid=${process.getuid()}`, `--gid=${process.getgid()}`);
    if (environmentFile !== undefined) runArgs.push(`--property=EnvironmentFile=${environmentFile}`);
  }

  if (filesystemPolicyActive(filesystem)) {
    runArgs.push('--property=NoNewPrivileges=yes');
    if (isolation.scope === 'system') {
      runArgs.push(
        '--property=PrivatePIDs=yes',
        '--property=CapabilityBoundingSet=~CAP_SYS_ADMIN',
        '--property=SystemCallFilter=~@mount',
        '--property=RestrictSUIDSGID=yes',
      );
    }
    for (const path of filesystem!.readOnlyPaths) {
      runArgs.push(`--property=ReadOnlyPaths=${JSON.stringify(path)}`);
    }
    for (const path of filesystem!.readWritePaths) {
      runArgs.push(`--property=ReadWritePaths=${JSON.stringify(path)}`);
    }
    for (const path of filesystem!.inaccessiblePaths) {
      runArgs.push(`--property=InaccessiblePaths=${JSON.stringify(path)}`);
    }
  }

  if (options.cwd !== undefined) runArgs.push(`--working-directory=${options.cwd}`);
  if (isolation.scope === 'user' && options.env !== undefined) {
    for (const key of Object.keys(options.env).sort()) runArgs.push(`--setenv=${key}`);
  }
  runArgs.push('--', command, ...args);
  return runArgs;
}

async function requireAdminCommand(
  isolation: LocalIsolationConfig,
  args: readonly string[],
  operation: string,
  stdin?: string,
): Promise<void> {
  const result = await spawnBounded(isolation.privilegeCommand, [...isolation.privilegeArgs, ...args], {
    timeoutMs: ADMIN_TIMEOUT_MS,
    maxOutputBytes: ADMIN_OUTPUT_BYTES,
    operation,
    env: process.env,
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw adapterError('OS_ERROR', operation, 'Privileged isolation helper failed.', {
      command: isolation.privilegeCommand,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stderr: result.stderr.slice(0, 2048),
    });
  }
}

async function stageSystemEnvironment(
  unit: string,
  env: NodeJS.ProcessEnv | undefined,
  isolation: LocalIsolationConfig,
): Promise<string | undefined> {
  if (isolation.scope !== 'system' || env === undefined) return undefined;
  await requireAdminCommand(
    isolation,
    ['install', '-d', '-m', '0700', '-o', 'root', '-g', 'root', SYSTEM_ENV_DIR],
    'shell.exec.policy.env.prepare',
  );
  const path = `${SYSTEM_ENV_DIR}/${unit}.env`;
  await requireAdminCommand(
    isolation,
    ['sh', '-c', 'umask 077; cat > "$1"', 'chatgpt-mcp-env', path],
    'shell.exec.policy.env.write',
    serializeSystemdEnvironmentFile(env),
  );
  return path;
}

async function removeSystemEnvironment(path: string | undefined, isolation: LocalIsolationConfig): Promise<void> {
  if (path === undefined || isolation.scope !== 'system') return;
  try {
    await requireAdminCommand(isolation, ['rm', '-f', '--', path], 'shell.exec.policy.env.cleanup');
  } catch {
    // Best effort; the root-only runtime directory prevents agent access and /run
    // is ephemeral. A stale file is preferable to masking the command result.
  }
}

function signalTransientUnit(isolation: LocalIsolationConfig, unit: string, signal: NodeJS.Signals): void {
  const managerArgs = signal === 'SIGKILL'
    ? ['kill', '--kill-whom=all', '--signal=SIGKILL', unit]
    : ['stop', '--no-block', unit];
  const invocation = systemctlCommandInvocation(isolation, managerArgs);
  const child = spawn(invocation.command, invocation.args, { shell: false, stdio: 'ignore', env: process.env });
  child.once('error', () => {});
  child.unref();
}

async function stopTransientUnit(isolation: LocalIsolationConfig, unit: string, timeoutMs: number): Promise<void> {
  await new Promise<void>(resolve => {
    let settled = false;
    const invocation = systemctlCommandInvocation(isolation, ['stop', unit]);
    const child = spawn(invocation.command, invocation.args, { shell: false, stdio: 'ignore', env: process.env });
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once('error', finish);
    child.once('close', finish);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* best-effort cleanup */ }
      finish();
    }, timeoutMs);
    timer.unref();
  });
}

export async function spawnSystemdIsolated(
  command: string,
  args: readonly string[],
  options: BoundedProcessOptions,
  isolation: LocalIsolationConfig,
  filesystem?: FilesystemMountPolicy,
): Promise<ExecResult> {
  const unit = `${UNIT_PREFIX}-${process.pid}-${randomUUID().replaceAll('-', '')}`;
  if (filesystemPolicyActive(filesystem) && isolation.scope !== 'system') {
    throw adapterError(
      'CAPABILITY_DISABLED',
      options.operation,
      'Filesystem blocklist shell enforcement requires system-scope local isolation.',
    );
  }
  const environmentFile = await stageSystemEnvironment(unit, options.env, isolation);
  const systemdArgs = buildSystemdRunArgs(unit, command, args, options, isolation, filesystem, environmentFile);
  const invocation = systemdCommandInvocation(isolation, systemdArgs);
  try {
    return await spawnBounded(invocation.command, invocation.args, {
      ...options,
      // The target environment is transferred through EnvironmentFile for the
      // system manager. Do not expose caller-supplied values to sudo/systemd-run.
      ...(isolation.scope === 'system' ? { env: process.env } : {}),
      onTerminate: signal => signalTransientUnit(isolation, unit, signal),
    });
  } finally {
    await stopTransientUnit(isolation, unit, isolation.stopTimeoutMs);
    await removeSystemEnvironment(environmentFile, isolation);
  }
}
