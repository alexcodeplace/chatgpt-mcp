import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import type { ExecResult } from '../adapter/computer-adapter.js';
import { adapterError } from '../errors.js';

const FORCE_KILL_DELAY_MS = 1_000;
const PIPE_CLOSE_GRACE_MS = 250;

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

/** A deadline applies to the whole process group, including inherited output pipes. */
export async function spawnBounded(command: string, args: readonly string[], options: BoundedProcessOptions): Promise<ExecResult> {
  if (options.signal?.aborted) throw adapterError('CANCELLED', options.operation, 'Request was cancelled before process spawn.');
  const started = process.hrtime.bigint();
  const spoolDir = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-spool-'));
  const stdoutPath = join(spoolDir, 'stdout');
  const stderrPath = join(spoolDir, 'stderr');
  const stdoutFile = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 });
  const stderrFile = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 });
  const useProcessGroup = platform() !== 'win32';
  let outputBytes = 0;
  let timedOut = false;
  let outputExceeded = false;
  let cancelled = false;
  let spawnError: unknown;
  let stdinError: unknown;
  let spoolError: unknown;
  let child: ChildProcess | undefined;
  let closed = false;
  let terminating = false;
  let timeout: NodeJS.Timeout | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let pipeTimer: NodeJS.Timeout | undefined;
  let settleClose: (code: number | null) => void = () => {};

  const signalProcess = (signal: NodeJS.Signals): void => {
    if (closed || child?.pid === undefined) return;
    // A process-group leader may have exited while descendants still own pipes.
    // Do not use the leader's exitCode as evidence that the group is gone.
    if (useProcessGroup) {
      try { process.kill(-child.pid, signal); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && child.exitCode === null && child.signalCode === null) child.kill(signal);
      }
    } else if (signal === 'SIGKILL') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => { child?.kill('SIGKILL'); });
      const killTimer = setTimeout(() => killer.kill(), PIPE_CLOSE_GRACE_MS);
      killTimer.unref();
      killer.once('close', () => clearTimeout(killTimer));
      killer.unref();
    } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const signalExecution = (signal: NodeJS.Signals): void => {
    if (closed) return;
    try { options.onTerminate?.(signal); } catch { /* cleanup hooks must not defeat the deadline */ }
    signalProcess(signal);
  };
  const terminate = (): void => {
    if (terminating || closed) return;
    terminating = true;
    signalExecution('SIGTERM');
    forceTimer = setTimeout(() => {
      signalExecution('SIGKILL');
      // An escaped/session-detached descendant must not hold admission forever.
      pipeTimer = setTimeout(() => {
        child?.stdin?.destroy();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        settleClose(child?.exitCode ?? null);
      }, PIPE_CLOSE_GRACE_MS);
      pipeTimer.unref();
    }, FORCE_KILL_DELAY_MS);
    forceTimer.unref();
  };
  // Register before the first asynchronous stream error, not only at finalization.
  const spoolFailure = (error: unknown): void => { spoolError ??= error; terminate(); };
  const stdoutDone = finished(stdoutFile, { cleanup: true }).catch(spoolFailure);
  const stderrDone = finished(stderrFile, { cleanup: true }).catch(spoolFailure);
  const abortHandler = (): void => { cancelled = true; terminate(); };

  try {
    if (options.signal?.aborted) throw adapterError('CANCELLED', options.operation, 'Request was cancelled while preparing execution.');
    child = spawn(command, [...args], {
      cwd: options.cwd, env: options.env ?? process.env, shell: false,
      detached: useProcessGroup, windowsHide: true,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const close = new Promise<number | null>(resolve => {
      settleClose = code => {
        if (closed) return;
        // Closing the leader's pipes does not prove that its descendants exited.
        // Finish termination while we still own the process-group identity. Do
        // not leave a SIGTERM-ignoring child alive when clearing the force timer.
        if (terminating) signalProcess('SIGKILL');
        closed = true;
        resolve(code);
      };
      child!.once('close', settleClose);
    });
    child.on('error', error => { spawnError ??= error; });
    child.stdin?.on('error', error => { stdinError ??= error; });
    options.signal?.addEventListener('abort', abortHandler, { once: true });
    if (options.signal?.aborted) abortHandler();
    timeout = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
    timeout.unref();

    const collect = (target: typeof stdoutFile, source: NodeJS.ReadableStream, chunk: Buffer): void => {
      if (outputExceeded || spoolError !== undefined) return;
      outputBytes += chunk.length;
      try { options.onOutputBytes?.(chunk.length); } catch (error) { spoolFailure(error); return; }
      if (outputBytes > options.maxOutputBytes) { outputExceeded = true; terminate(); return; }
      if (!target.write(chunk)) {
        source.pause();
        target.once('drain', () => source.resume());
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(stdoutFile, child!.stdout!, chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect(stderrFile, child!.stderr!, chunk));
    if (options.stdin !== undefined) {
      try { child.stdin?.end(options.stdin); } catch (error) { stdinError ??= error; }
    }
    const exitCode = await close;
    clearTimeout(timeout);
    clearTimeout(forceTimer);
    clearTimeout(pipeTimer);
    options.signal?.removeEventListener('abort', abortHandler);
    stdoutFile.end();
    stderrFile.end();
    await Promise.all([stdoutDone, stderrDone]);
    if (cancelled) throw adapterError('CANCELLED', options.operation, 'Request was cancelled during command execution.');
    if (outputExceeded) throw adapterError('OUTPUT_LIMIT', options.operation, 'Command output exceeded the configured byte limit.', { maximum: options.maxOutputBytes });
    if (spoolError !== undefined) throw mapSpawnError(spoolError, options.operation, command);
    if (spawnError !== undefined) throw mapSpawnError(spawnError, options.operation, command);
    if (stdinError !== undefined && exitCode === 0) throw mapSpawnError(stdinError, options.operation, command);
    const [stdout, stderr] = await Promise.all([readFile(stdoutPath, 'utf8'), readFile(stderrPath, 'utf8')]);
    return { exitCode, stdout, stderr, durationMs: Number(process.hrtime.bigint() - started) / 1_000_000, timedOut };
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceTimer);
    clearTimeout(pipeTimer);
    options.signal?.removeEventListener('abort', abortHandler);
    if (!closed && child?.pid !== undefined) signalExecution('SIGKILL');
    stdoutFile.destroy();
    stderrFile.destroy();
    await Promise.all([stdoutDone, stderrDone]);
    await rm(spoolDir, { recursive: true, force: true });
  }
}
