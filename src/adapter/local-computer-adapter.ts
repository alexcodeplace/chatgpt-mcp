import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { arch, hostname, platform, release, tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import type { ChatGptMcpConfig } from '../config.js';
import { adapterError, isComputerAdapterError } from '../errors.js';
import { authorizePath } from '../policy/filesystem.js';
import { spawnBounded } from '../execution/bounded-process.js';
import { spawnSystemdIsolated } from '../execution/systemd-isolated-process.js';
import { authorizeCommand, authorizeHostDisplaySafeInvocation, clampRuntime, sanitizeHostDisplayEnvironment, validateShellEnvironment } from '../policy/shell.js';
import type {
  ApplicationLaunchResult,
  ComputerAdapter,
  ExecRequest,
  ExecResult,
  FileEntry,
  FileEntryType,
  PointerButton,
  ProcessInfo,
  ScreenCapture,
  ServiceAction,
  ServiceStatus,
  SystemInfo,
} from './computer-adapter.js';

const SERVICE_NAME = /^[A-Za-z0-9_.@:-]+$/;
const MAX_APPLICATION_ARGS = 256;
const MAX_APPLICATION_ARG_BYTES = 64 * 1024;
const MAX_URL_BYTES = 16 * 1024;

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
  if (nodeError?.code === 'ENOENT' || nodeError?.code === 'ESRCH') {
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

async function requireSuccessfulCommand(
  command: string,
  args: readonly string[],
  operation: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  maxOutputBytes = 1024 * 1024,
): Promise<ExecResult> {
  const result = await spawnBounded(command, args, {
    timeoutMs,
    maxOutputBytes,
    operation,
    ...(env === undefined ? {} : { env }),
  });
  if (result.timedOut) throw adapterError('TIMEOUT', operation, 'Operating-system command timed out.', { command });
  if (result.exitCode !== 0) {
    throw adapterError('OS_ERROR', operation, 'Operating-system command failed.', {
      command,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 2048),
    });
  }
  return result;
}

function isAllowed(value: string, allowList: readonly string[]): boolean {
  return allowList.includes('*') || allowList.includes(value);
}

function validateCoordinates(x: number, y: number, operation: string): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    throw adapterError('INVALID_INPUT', operation, 'Coordinates must be non-negative integers.', { x, y });
  }
}

function validateDisplay(display: string, operation: string): string {
  if (display.length === 0 || display.length > 255 || /[\0\r\n]/.test(display)) {
    throw adapterError('INVALID_INPUT', operation, 'display must be a non-empty X11 DISPLAY value.', { display });
  }
  return display;
}

export class LocalComputerAdapter implements ComputerAdapter {
  private readonly applications = new Map<string, ChildProcess>();

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
    authorizeCommand(request.command, request.args, this.config.shell);
    authorizeHostDisplaySafeInvocation(request.command, request.args, this.config.desktop.hostDisplayAccess);
    let cwd: string | undefined;
    if (request.cwd !== undefined) {
      cwd = await authorizePath(request.cwd, this.config.filesystem.roots, operation);
    }
    const env = validateShellEnvironment(request.env, this.config.shell.allowEnvironment, this.config.desktop.hostDisplayAccess);
    const options = {
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      timeoutMs: clampRuntime(request.timeoutMs, this.config.shell.maxRuntimeMs),
      maxOutputBytes: this.config.shell.maxOutputBytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      operation,
    };
    if (this.config.execution.localIsolation.enabled) {
      return spawnSystemdIsolated(request.command, request.args, options, this.config.execution.localIsolation);
    }
    return spawnBounded(request.command, request.args, options);
  }

  async listProcesses(): Promise<readonly ProcessInfo[]> {
    const operation = 'process.list';
    requireCapability(this.config.process.list, operation, 'Process listing is disabled.');
    try {
      const result = await spawnBounded('ps', ['-eo', 'pid=,ppid=,user=,comm='], {
        timeoutMs: Math.min(10_000, this.config.execution.lightweightTimeoutMs),
        maxOutputBytes: this.config.execution.lightweightOutputBytes,
        operation,
      });
      if (result.timedOut) throw adapterError('TIMEOUT', operation, 'Process listing timed out.');
      if (result.exitCode !== 0) {
        throw adapterError('OS_ERROR', operation, 'Process listing command failed.', { exitCode: result.exitCode });
      }
      const processes: ProcessInfo[] = [];
      for (const line of result.stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (match === null) continue;
        const pid = match[1];
        const parentPid = match[2];
        const user = match[3];
        const command = match[4];
        if (pid === undefined || parentPid === undefined || user === undefined || command === undefined) continue;
        processes.push({ pid: Number(pid), parentPid: Number(parentPid), user, command });
      }
      return processes;
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

  private authorizeService(name: string, operation: string): void {
    requireCapability(this.config.service.enabled, operation, 'Service control is disabled.');
    if (!SERVICE_NAME.test(name) || !isAllowed(name, this.config.service.allowedServices)) {
      throw adapterError('COMMAND_NOT_ALLOWED', operation, 'Service is not in the configured allow-list.', { name });
    }
  }

  async serviceStatus(name: string): Promise<ServiceStatus> {
    const operation = 'service.status';
    this.authorizeService(name, operation);
    try {
      const result = await requireSuccessfulCommand(
        this.config.service.command,
        ['show', name, '--property=ActiveState,SubState,Description', '--no-pager'],
        operation,
        this.config.service.maxRuntimeMs,
        undefined,
        this.config.execution.lightweightOutputBytes,
      );
      const fields = Object.fromEntries(result.stdout.split('\n').flatMap(line => {
        const index = line.indexOf('=');
        return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : [];
      }));
      return {
        name,
        activeState: fields.ActiveState ?? 'unknown',
        subState: fields.SubState ?? 'unknown',
        description: fields.Description ?? '',
      };
    } catch (error) {
      mapOsError(error, operation, { name });
    }
  }

  async serviceControl(name: string, action: ServiceAction): Promise<void> {
    const operation = 'service.control';
    this.authorizeService(name, operation);
    try {
      await requireSuccessfulCommand(
        this.config.service.command,
        [action, name, '--no-pager'],
        operation,
        this.config.service.maxRuntimeMs,
        undefined,
        this.config.execution.lightweightOutputBytes,
      );
    } catch (error) {
      mapOsError(error, operation, { name, action });
    }
  }

  private pruneApplications(): void {
    for (const [handle, child] of this.applications) {
      if (child.exitCode !== null || child.signalCode !== null) this.applications.delete(handle);
    }
  }

  async launchApplication(name: string, args: readonly string[], display: string): Promise<ApplicationLaunchResult> {
    const operation = 'app.launch';
    requireCapability(this.config.application.enabled, operation, 'Application launching is disabled.');
    requireCapability(this.config.desktop.hostDisplayAccess, operation, 'Host display access is disabled.');
    const desktopEnv = this.desktopEnvironment(display, operation);
    const definition = this.config.application.applications[name];
    if (definition === undefined) {
      throw adapterError('COMMAND_NOT_ALLOWED', operation, 'Application is not configured.', { name });
    }
    if (args.length > 0 && !definition.allowArguments) {
      throw adapterError('COMMAND_NOT_ALLOWED', operation, 'Caller arguments are disabled for this application.', { name });
    }
    if (args.length > MAX_APPLICATION_ARGS || args.some(arg => Buffer.byteLength(arg, 'utf8') > MAX_APPLICATION_ARG_BYTES)) {
      throw adapterError('INVALID_INPUT', operation, 'Application arguments exceed configured implementation limits.', { name });
    }

    this.pruneApplications();
    if (this.applications.size >= this.config.application.maxTracked) {
      throw adapterError('OUTPUT_LIMIT', operation, 'Tracked application handle limit reached.', {
        maximum: this.config.application.maxTracked,
      });
    }

    try {
      const child = spawn(definition.command, [...definition.args, ...args], {
        detached: true,
        shell: false,
        stdio: 'ignore',
        env: desktopEnv,
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      if (child.pid === undefined) throw adapterError('OS_ERROR', operation, 'Application started without a process id.', { name });
      const pid = child.pid;
      child.unref();
      const handle = `app_${randomUUID().replaceAll('-', '')}`;
      this.applications.set(handle, child);
      return { handle, pid };
    } catch (error) {
      mapOsError(error, operation, { name });
    }
  }

  async closeApplication(handle: string): Promise<void> {
    const operation = 'app.close';
    requireCapability(this.config.application.enabled, operation, 'Application closing is disabled.');
    const child = this.applications.get(handle);
    if (child === undefined) throw adapterError('NOT_FOUND', operation, 'Application handle is unknown or expired.', { handle });
    this.applications.delete(handle);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw adapterError('NOT_FOUND', operation, 'Application has already exited.', { handle, pid: child.pid });
    }
    try {
      if (!child.kill('SIGTERM')) {
        throw adapterError('OS_ERROR', operation, 'Operating system did not accept the application termination signal.', {
          handle,
          pid: child.pid,
        });
      }
    } catch (error) {
      mapOsError(error, operation, { handle, pid: child.pid });
    }
  }

  async openBrowser(rawUrl: string, display: string): Promise<void> {
    const operation = 'browser.open';
    requireCapability(this.config.browser.enabled, operation, 'Browser opening is disabled.');
    requireCapability(this.config.desktop.hostDisplayAccess, operation, 'Host display access is disabled.');
    const desktopEnv = this.desktopEnvironment(display, operation);
    if (Buffer.byteLength(rawUrl, 'utf8') > MAX_URL_BYTES) {
      throw adapterError('INVALID_INPUT', operation, 'URL exceeds the implementation byte limit.');
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw adapterError('INVALID_INPUT', operation, 'URL is invalid.', { url: rawUrl });
    }
    const scheme = url.protocol.slice(0, -1).toLowerCase();
    if (!isAllowed(scheme, this.config.browser.allowedSchemes)) {
      throw adapterError('COMMAND_NOT_ALLOWED', operation, 'URL scheme is not allowed.', { scheme });
    }
    try {
      await requireSuccessfulCommand(
        this.config.browser.command,
        [url.toString()],
        operation,
        this.config.browser.maxRuntimeMs,
        desktopEnv,
        this.config.execution.lightweightOutputBytes,
      );
    } catch (error) {
      mapOsError(error, operation, { scheme });
    }
  }

  async captureScreen(display: string): Promise<ScreenCapture> {
    const operation = 'screen.capture';
    requireCapability(this.config.desktop.hostDisplayAccess, operation, 'Host display access is disabled.');
    requireCapability(this.config.desktop.screenCapture, operation, 'Screen capture is disabled.');
    const desktopEnv = this.desktopEnvironment(display, operation);
    const dir = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-screen-'));
    const file = join(dir, 'screen.png');
    const candidates = this.config.desktop.screenBackend === 'auto'
      ? [
          ['grim', [file]],
          ['gnome-screenshot', ['-f', file]],
          ['scrot', [file]],
          ['import', ['-window', 'root', file]],
        ] as const
      : this.config.desktop.screenBackend === 'grim'
        ? [['grim', [file]]] as const
        : this.config.desktop.screenBackend === 'gnome-screenshot'
          ? [['gnome-screenshot', ['-f', file]]] as const
          : this.config.desktop.screenBackend === 'scrot'
            ? [['scrot', [file]]] as const
            : [['import', ['-window', 'root', file]]] as const;

    const failures: string[] = [];
    try {
      for (const [command, args] of candidates) {
        try {
          const result = await spawnBounded(command, args, {
            timeoutMs: 30_000,
            maxOutputBytes: 1024 * 1024,
            operation,
            env: desktopEnv,
          });
          if (!result.timedOut && result.exitCode === 0) {
            const image = await readFile(file);
            if (image.byteLength > this.config.desktop.maxImageBytes) {
              throw adapterError('OUTPUT_LIMIT', operation, 'Screenshot exceeds the configured image byte limit.', {
                size: image.byteLength,
                maximum: this.config.desktop.maxImageBytes,
              });
            }
            return { mimeType: 'image/png', data: image.toString('base64'), bytes: image.byteLength };
          }
          failures.push(`${command}:${result.timedOut ? 'timeout' : String(result.exitCode)}`);
        } catch (error) {
          if (isComputerAdapterError(error) && error.code === 'OUTPUT_LIMIT') throw error;
          failures.push(`${command}:${isComputerAdapterError(error) ? error.code : 'error'}`);
        }
      }
      throw adapterError('OS_ERROR', operation, 'No configured screenshot backend succeeded.', { failures });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private desktopEnvironment(display: string, operation: string): NodeJS.ProcessEnv {
    const value = validateDisplay(display, operation);
    const env = sanitizeHostDisplayEnvironment({ ...process.env }, this.config.desktop.hostDisplayAccess);
    // DISPLAY is selected by each MCP invocation. Do not mutate process.env: concurrent
    // calls may intentionally target different X servers. Prefer the explicit X11 target
    // over an inherited Wayland/Mir target so application routing is deterministic.
    delete env.WAYLAND_DISPLAY;
    delete env.MIR_SOCKET;
    env.DISPLAY = value;
    return env;
  }

  private async xdotool(args: readonly string[], operation: string, display: string): Promise<void> {
    requireCapability(this.config.desktop.hostDisplayAccess, operation, 'Host display access is disabled.');
    requireCapability(this.config.desktop.input, operation, 'Desktop input is disabled.');
    try {
      await requireSuccessfulCommand('xdotool', args, operation, Math.min(30_000, this.config.execution.lightweightTimeoutMs), this.desktopEnvironment(display, operation), this.config.execution.lightweightOutputBytes);
    } catch (error) {
      mapOsError(error, operation);
    }
  }

  async movePointer(x: number, y: number, display: string): Promise<void> {
    const operation = 'input.move';
    validateCoordinates(x, y, operation);
    await this.xdotool(['mousemove', '--sync', String(x), String(y)], operation, display);
  }

  async clickPointer(button: PointerButton, display: string, x?: number, y?: number): Promise<void> {
    const operation = 'input.click';
    if ((x === undefined) !== (y === undefined)) {
      throw adapterError('INVALID_INPUT', operation, 'x and y must be supplied together.');
    }
    if (x !== undefined && y !== undefined) {
      validateCoordinates(x, y, operation);
      await this.xdotool(['mousemove', '--sync', String(x), String(y)], operation, display);
    }
    const buttonNumber = button === 'left' ? '1' : button === 'middle' ? '2' : '3';
    await this.xdotool(['click', buttonNumber], operation, display);
  }

  async typeText(text: string, display: string, delayMs = 0): Promise<void> {
    const operation = 'input.type';
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000) {
      throw adapterError('INVALID_INPUT', operation, 'delayMs must be an integer between 0 and 10000.');
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.config.desktop.maxTextBytes) {
      throw adapterError('OUTPUT_LIMIT', operation, 'Text exceeds the configured input byte limit.', {
        size: bytes,
        maximum: this.config.desktop.maxTextBytes,
      });
    }
    await this.xdotool(['type', '--clearmodifiers', '--delay', String(delayMs), '--', text], operation, display);
  }

  async pressKey(key: string, display: string): Promise<void> {
    const operation = 'input.key';
    if (key.length === 0 || key.length > 256 || key.includes('\0')) {
      throw adapterError('INVALID_INPUT', operation, 'Key sequence is invalid.');
    }
    await this.xdotool(['key', '--clearmodifiers', key], operation, display);
  }
}
