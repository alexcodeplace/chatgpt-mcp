import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecResult } from '../adapter/computer-adapter.js';
import { adapterError } from '../errors.js';

const FORCE_KILL_DELAY_MS = 1_000;

export interface BoundedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  operation: string;
  signal?: AbortSignal;
  stdin?: string | Buffer;
  onOutputBytes?: (bytes: number) => void;
  onTerminate?: (signal: NodeJS.Signals) => void;
}

function mapSpawnError(error: unknown, operation: string, command: string) {
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError?.code === 'ENOENT' || nodeError?.code === 'ESRCH') {
    return adapterError('NOT_FOUND', operation, 'Requested executable was not found.', { command });
  }
  if (nodeError?.code === 'EINVAL' || nodeError?.code === 'ERR_INVALID_ARG_VALUE' || nodeError?.code === 'ERR_INVALID_ARG_TYPE') {
    return adapterError('INVALID_INPUT', operation, 'The operating system rejected the supplied process input.', { command });
  }
  return adapterError('OS_ERROR', operation, 'The operating-system process operation failed.', {
    command,
    ...(typeof nodeError?.code === 'string' ? { osCode: nodeError.code } : {}),
  });
}

export async function spawnBounded(command: string, args: readonly string[], options: BoundedProcessOptions): Promise<ExecResult> {
  if (options.signal?.aborted) {
    throw adapterError('CANCELLED', options.operation, 'Request was cancelled before process spawn.');
  }

  const spoolDir = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-spool-'));
  const stdoutPath = join(spoolDir, 'stdout');
  const stderrPath = join(spoolDir, 'stderr');
  const stdoutFile = createWriteStream(stdoutPath, { flags: 'wx' });
  const stderrFile = createWriteStream(stderrPath, { flags: 'wx' });
  const useProcessGroup = platform() !== 'win32';
  const started = process.hrtime.bigint();
  let outputBytes = 0;
  let timedOut = false;
  let outputExceeded = false;
  let cancelled = false;
  let spawnError: unknown;
  let stdinError: unknown;
  let child: ReturnType<typeof spawn> | undefined;

  const endFile = (stream: typeof stdoutFile): Promise<void> => new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });

  try {
    child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: useProcessGroup,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    const signalProcess = (signal: NodeJS.Signals): void => {
      if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
      if (useProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
          return;
        }
      }
      child.kill(signal);
    };

    const signalExecution = (signal: NodeJS.Signals): void => {
      try { options.onTerminate?.(signal); } catch { /* termination hooks are best-effort */ }
      signalProcess(signal);
    };

    const terminate = (): void => {
      signalExecution('SIGTERM');
      const forceTimer = setTimeout(() => signalExecution('SIGKILL'), FORCE_KILL_DELAY_MS);
      forceTimer.unref();
    };

    const abortHandler = (): void => {
      cancelled = true;
      terminate();
    };
    options.signal?.addEventListener('abort', abortHandler, { once: true });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();

    const collect = (target: typeof stdoutFile, source: NodeJS.ReadableStream, chunk: Buffer): void => {
      if (outputExceeded) return;
      outputBytes += chunk.length;
      options.onOutputBytes?.(chunk.length);
      if (outputBytes > options.maxOutputBytes) {
        outputExceeded = true;
        terminate();
        return;
      }
      if (!target.write(chunk)) {
        source.pause();
        target.once('drain', () => source.resume());
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(stdoutFile, child!.stdout!, chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect(stderrFile, child!.stderr!, chunk));
    child.on('error', error => { spawnError ??= error; });
    child.stdin?.on('error', error => { stdinError ??= error; });
    if (options.stdin !== undefined) {
      try { child.stdin?.end(options.stdin); } catch (error) { stdinError ??= error; }
    }

    const exitCode = await new Promise<number | null>(resolve => child!.once('close', resolve));
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortHandler);
    await Promise.all([endFile(stdoutFile), endFile(stderrFile)]);
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    if (cancelled) throw adapterError('CANCELLED', options.operation, 'Request was cancelled during command execution.');
    if (outputExceeded) {
      throw adapterError('OUTPUT_LIMIT', options.operation, 'Command output exceeded the configured byte limit.', { maximum: options.maxOutputBytes });
    }
    if (spawnError !== undefined) throw mapSpawnError(spawnError, options.operation, command);
    if (stdinError !== undefined && exitCode === 0) throw mapSpawnError(stdinError, options.operation, command);

    const [stdout, stderr] = await Promise.all([readFile(stdoutPath, 'utf8'), readFile(stderrPath, 'utf8')]);
    return { exitCode, stdout, stderr, durationMs, timedOut };
  } finally {
    if (!stdoutFile.closed && !stdoutFile.destroyed) stdoutFile.destroy();
    if (!stderrFile.closed && !stderrFile.destroyed) stderrFile.destroy();
    await rm(spoolDir, { recursive: true, force: true });
  }
}
