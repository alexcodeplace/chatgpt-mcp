import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { arch, hostname, platform, release, uptime } from 'node:os';
import { join } from 'node:path';
import type { ChatGptMcpConfig } from '../config.js';
import { adapterError, isComputerAdapterError } from '../errors.js';
import { authorizePath } from '../policy/filesystem.js';
import { authorizeCommand, clampRuntime } from '../policy/shell.js';
import type {
  ComputerAdapter,
  ExecRequest,
  ExecResult,
  FileEntry,
  FileEntryType,
  ProcessInfo,
  SystemInfo,
} from './computer-adapter.js';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_VALUE_BYTES = 32 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;

function requireCapability(enabled: boolean, operation: string, message: string): void {
  if (!enabled) throw adapterError('CAPABILITY_DISABLED', operation, message);
}

function fileType(stats: Awaited<ReturnType<typeof lstat>>): FileEntryType {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

function mapOsError(error: unknown, operation: string, details?: Record<string, unknown>): never {
  if (isComputerAdapterError(error)) throw error;
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError?.code === 'ENOENT') {
    throw adapterError('NOT_FOUND', operation, 'Requested operating-system resource was not found.', details);
  }
  if (nodeError?.code === 'EINVAL' || nodeError?.code === 'ERR_INVALID_ARG_VALUE' || nodeError?.code === 'ERR_INVALID_ARG_TYPE') {
    throw adapterError('INVALID_INPUT', operation, 'The operating system rejected the supplied input.', details);
  }
  throw adapterError('OS_ERROR', operation, 'The operating-system operation failed.', {
    ...details,
    ...(typeof nodeError?.code === 'string' ? { osCode: nodeError.code } : {}),
  });
}

function validateEnvironment(env: Readonly<Record<string, string>> | undefined, allowEnvironment: boolean): NodeJS.ProcessEnv | undefined {
  if (env === undefined) return undefined;
  if (!allowEnvironment) {
    throw adapterError('CAPABILITY_DISABLED', 'shell.exec', 'Caller-provided environment variables are disabled.');
  }
  const entries = Object.entries(env);
  if (entries.length > MAX_ENV_ENTRIES) {
    throw adapterError('INVALID_INPUT', 'shell.exec', 'Too many caller-provided environment variables.', {
      maximum: MAX_ENV_ENTRIES,
    });
  }
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key) || Buffer.byteLength(value, 'utf8') > MAX_ENV_VALUE_BYTES) {
      throw adapterError('INVALID_INPUT', 'shell.exec', 'Invalid caller-provided environment variable.', { key });
    }
  }
  return { ...process.env, ...env };
}

type CaptureOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  operation: string;
};

function spawnBounded(command: string, args: readonly string[], options: CaptureOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      mapOsError(error, options.operation, { command });
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let spawnError: unknown;
    let closed = false;

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, FORCE_KILL_DELAY_MS);
      forceTimer.unref();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();

    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (outputExceeded) return;
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        outputExceeded = true;
        terminate();
        return;
      }
      target.push(Buffer.from(chunk));
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', error => {
      spawnError = error;
    });
    child.on('close', exitCode => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      if (outputExceeded) {
        reject(adapterError('OUTPUT_LIMIT', options.operation, 'Command output exceeded the configured byte limit.', {
          maximum: options.maxOutputBytes,
        }));
        return;
      }
      if (spawnError !== undefined) {
        try {
          mapOsError(spawnError, options.operation, { command });
        } catch (error) {
          reject(error);
        }
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs,
        timedOut,
      });
    });
  });
}

export class LocalComputerAdapter implements ComputerAdapter {
  constructor(private readonly config: Readonly<ChatGptMcpConfig>) {}

  async systemInfo(): Promise<SystemInfo> {
    return {
      hostname: hostname(),
      platform: platform(),
      architecture: arch(),
      release: release(),
      uptimeSeconds: uptime(),
      cwd: process.cwd(),
    };
  }

  async listDirectory(requestedPath: string): Promise<readonly FileEntry[]> {
    const operation = 'fs.list';
    requireCapability(this.config.filesystem.read, operation, 'Filesystem reads are disabled.');
    try {
      const path = await authorizePath(requestedPath, this.config.filesystem.roots, operation);
      const entries = await readdir(path, { withFileTypes: true });
      return await Promise.all(entries.map(async entry => {
        const stats = await lstat(join(path, entry.name));
        return {
          name: entry.name,
          type: fileType(stats),
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        } satisfies FileEntry;
      }));
    } catch (error) {
      mapOsError(error, operation, { path: requestedPath });
    }
  }

  async readFile(requestedPath: string, maxBytes?: number): Promise<string> {
    const operation = 'fs.read';
    requireCapability(this.config.filesystem.read, operation, 'Filesystem reads are disabled.');
    if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes <= 0)) {
      throw adapterError('INVALID_INPUT', operation, 'maxBytes must be a positive integer.');
    }
    const limit = Math.min(maxBytes ?? this.config.filesystem.maxReadBytes, this.config.filesystem.maxReadBytes);
    try {
      const path = await authorizePath(requestedPath, this.config.filesystem.roots, operation);
      const metadata = await stat(path);
      if (!metadata.isFile()) throw adapterError('INVALID_INPUT', operation, 'Path is not a regular file.', { path });
      if (metadata.size > limit) {
        throw adapterError('OUTPUT_LIMIT', operation, 'File exceeds the configured read byte limit.', {
          path,
          size: metadata.size,
          maximum: limit,
        });
      }
      const content = await readFile(path);
      if (content.byteLength > limit) {
        throw adapterError('OUTPUT_LIMIT', operation, 'File exceeds the configured read byte limit.', {
          path,
          size: content.byteLength,
          maximum: limit,
        });
      }
      return content.toString('utf8');
    } catch (error) {
      mapOsError(error, operation, { path: requestedPath });
    }
  }

  async writeFile(requestedPath: string, content: string, mode: 'create' | 'overwrite' | 'append'): Promise<void> {
    const operation = 'fs.write';
    requireCapability(this.config.filesystem.write, operation, 'Filesystem writes are disabled.');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.config.filesystem.maxWriteBytes) {
      throw adapterError('OUTPUT_LIMIT', operation, 'Content exceeds the configured write byte limit.', {
        size: bytes,
        maximum: this.config.filesystem.maxWriteBytes,
      });
    }
    try {
      const path = await authorizePath(requestedPath, this.config.filesystem.roots, operation);
      const flag = mode === 'create' ? 'wx' : mode === 'append' ? 'a' : 'w';
      await writeFile(path, content, { encoding: 'utf8', flag });
    } catch (error) {
      mapOsError(error, operation, { path: requestedPath, mode });
    }
  }

  async makeDirectory(requestedPath: string, recursive: boolean): Promise<void> {
    const operation = 'fs.mkdir';
    requireCapability(this.config.filesystem.write, operation, 'Filesystem writes are disabled.');
    try {
      const path = await authorizePath(requestedPath, this.config.filesystem.roots, operation);
      await mkdir(path, { recursive });
    } catch (error) {
      mapOsError(error, operation, { path: requestedPath });
    }
  }

  async movePath(requestedSource: string, requestedDestination: string): Promise<void> {
    const operation = 'fs.move';
    requireCapability(this.config.filesystem.write, operation, 'Filesystem writes are disabled.');
    try {
      const source = await authorizePath(requestedSource, this.config.filesystem.roots, operation);
      const destination = await authorizePath(requestedDestination, this.config.filesystem.roots, operation);
      await rename(source, destination);
    } catch (error) {
      mapOsError(error, operation, { source: requestedSource, destination: requestedDestination });
    }
  }

  async deletePath(requestedPath: string, recursive: boolean): Promise<void> {
    const operation = 'fs.delete';
    requireCapability(this.config.filesystem.write, operation, 'Filesystem writes are disabled.');
    try {
      const path = await authorizePath(requestedPath, this.config.filesystem.roots, operation);
      const metadata = await lstat(path);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        if (recursive) await rm(path, { recursive: true, force: false });
        else await rmdir(path);
      } else {
        await rm(path, { force: false });
      }
    } catch (error) {
      mapOsError(error, operation, { path: requestedPath });
    }
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    const operation = 'shell.exec';
    authorizeCommand(request.command, this.config.shell);
    let cwd: string | undefined;
    if (request.cwd !== undefined) {
      cwd = await authorizePath(request.cwd, this.config.filesystem.roots, operation);
    }
    const env = validateEnvironment(request.env, this.config.shell.allowEnvironment);
    return spawnBounded(request.command, request.args, {
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      timeoutMs: clampRuntime(request.timeoutMs, this.config.shell.maxRuntimeMs),
      maxOutputBytes: this.config.shell.maxOutputBytes,
      operation,
    });
  }

  async listProcesses(): Promise<readonly ProcessInfo[]> {
    const operation = 'process.list';
    requireCapability(this.config.process.list, operation, 'Process listing is disabled.');
    try {
      const result = await spawnBounded('ps', ['-eo', 'pid=,ppid=,user=,comm='], {
        timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024 * 1024,
        operation,
      });
      if (result.timedOut) throw adapterError('TIMEOUT', operation, 'Process listing timed out.');
      if (result.exitCode !== 0) {
        throw adapterError('OS_ERROR', operation, 'Process listing command failed.', { exitCode: result.exitCode });
      }
      return result.stdout.split('\n').flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (!match) return [];
        const [, pid, parentPid, user, command] = match;
        return [{ pid: Number(pid), parentPid: Number(parentPid), user, command } satisfies ProcessInfo];
      });
    } catch (error) {
      mapOsError(error, operation);
    }
  }

  async killProcess(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const operation = 'process.kill';
    requireCapability(this.config.process.kill, operation, 'Process termination is disabled.');
    if (!Number.isInteger(pid) || pid <= 0) {
      throw adapterError('INVALID_INPUT', operation, 'pid must be a positive integer.', { pid });
    }
    try {
      process.kill(pid, signal);
    } catch (error) {
      mapOsError(error, operation, { pid, signal });
    }
  }
}
