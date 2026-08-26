import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChatGptMcpConfig } from '../config.js';
import type { ExecResult } from '../adapter/computer-adapter.js';
import { spawnBounded, type BoundedProcessOptions } from './bounded-process.js';

type LocalIsolationConfig = Readonly<ChatGptMcpConfig['execution']['localIsolation']>;

const UNIT_PREFIX = 'chatgpt-mcp-exec';

export function buildSystemdRunArgs(
  unit: string,
  command: string,
  args: readonly string[],
  options: Pick<BoundedProcessOptions, 'cwd' | 'env'>,
  isolation: LocalIsolationConfig,
): string[] {
  const runArgs = [
    '--user',
    '--quiet',
    '--wait',
    '--pipe',
    '--collect',
    `--unit=${unit}`,
    `--property=TasksMax=${isolation.tasksMax}`,
    `--property=MemoryMax=${isolation.memoryMaxBytes}`,
    `--property=CPUWeight=${isolation.cpuWeight}`,
    '--property=KillMode=control-group',
    '--property=SendSIGKILL=yes',
    '--property=TimeoutStopSec=1s',
  ];
  if (options.cwd !== undefined) runArgs.push(`--working-directory=${options.cwd}`);
  if (options.env !== undefined) {
    for (const key of Object.keys(options.env).sort()) runArgs.push(`--setenv=${key}`);
  }
  runArgs.push('--', command, ...args);
  return runArgs;
}

function signalTransientUnit(command: string, unit: string, signal: NodeJS.Signals): void {
  const args = signal === 'SIGKILL'
    ? ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', unit]
    : ['--user', 'stop', '--no-block', unit];
  const child = spawn(command, args, { shell: false, stdio: 'ignore' });
  child.once('error', () => {});
  child.unref();
}

async function stopTransientUnit(command: string, unit: string, timeoutMs: number): Promise<void> {
  await new Promise<void>(resolve => {
    let settled = false;
    const child = spawn(command, ['--user', 'stop', unit], { shell: false, stdio: 'ignore' });
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
): Promise<ExecResult> {
  const unit = `${UNIT_PREFIX}-${process.pid}-${randomUUID().replaceAll('-', '')}`;
  const systemdArgs = buildSystemdRunArgs(unit, command, args, options, isolation);
  try {
    return await spawnBounded(isolation.command, systemdArgs, {
      ...options,
      onTerminate: signal => signalTransientUnit(isolation.managerCommand, unit, signal),
    });
  } finally {
    await stopTransientUnit(isolation.managerCommand, unit, isolation.stopTimeoutMs);
  }
}
