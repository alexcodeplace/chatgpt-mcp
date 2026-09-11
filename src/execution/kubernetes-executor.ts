import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { access, readdir } from 'node:fs/promises';
import type { ChatGptMcpConfig } from '../config.js';
import type { ExecRequest, ExecResult } from '../adapter/computer-adapter.js';
import { adapterError, isComputerAdapterError } from '../errors.js';
import { spawnBounded } from './bounded-process.js';
import { ExecutionMetrics } from './metrics.js';

const INTERNAL_OUTPUT_LIMIT = 1024 * 1024;
const WORKSPACE_VOLUME_NAME = 'chatgpt-mcp-workspace';
const COMMAND_NAME = /^[A-Za-z0-9_.+-]+$/;

function requiredResult(result: ExecResult, operation: string, message: string): ExecResult {
  if (result.timedOut) throw adapterError('TIMEOUT', operation, `${message} timed out.`);
  if (result.exitCode !== 0) {
    throw adapterError('OS_ERROR', operation, `${message} failed.`, {
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 2048),
    });
  }
  return result;
}

export class KubernetesExecutor {
  private readonly config: Readonly<ChatGptMcpConfig['execution']['kubernetes']>;
  private parityVerifiedForPinnedImage = false;
  private lastReapAt = 0;
  private reapInFlight: Promise<void> | undefined;

  constructor(
    config: Readonly<ChatGptMcpConfig>,
    private readonly metrics: ExecutionMetrics,
  ) {
    this.config = config.execution.kubernetes;
  }

  private clientArgs(args: readonly string[]): string[] {
    const prefix = [...this.config.client.args];
    if (this.config.client.kubeconfig !== undefined) prefix.push('--kubeconfig', this.config.client.kubeconfig);
    if (this.config.client.context !== undefined) prefix.push('--context', this.config.client.context);
    return [...prefix, ...args];
  }

  private async runClient(args: readonly string[], operation: string, timeoutMs: number, stdin?: string | Buffer, signal?: AbortSignal): Promise<ExecResult> {
    return spawnBounded(this.config.client.command, this.clientArgs(args), {
      timeoutMs,
      maxOutputBytes: INTERNAL_OUTPUT_LIMIT,
      operation,
      ...(stdin === undefined ? {} : { stdin }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private manifest(name: string, shellMaxRuntimeMs: number): Record<string, unknown> {
    const preparationRuntimeMs = this.config.workspace.prepareCommands.reduce((total, command) => total + command.timeoutMs, 0);
    const lifecycleBudgetSeconds = Math.ceil((this.config.startupTimeoutMs + preparationRuntimeMs + shellMaxRuntimeMs) / 1000) + 60;
    const container: Record<string, unknown> = {
      name: 'executor',
      image: this.config.image,
      imagePullPolicy: this.config.imagePullPolicy,
      command: [...this.config.idleCommand],
      workingDir: this.config.workspace.containerPath,
      resources: this.config.resources,
      volumeMounts: [
        { name: WORKSPACE_VOLUME_NAME, mountPath: this.config.workspace.containerPath },
        ...this.config.volumeMounts,
      ],
    };
    const spec: Record<string, unknown> = {
      restartPolicy: 'Never',
      activeDeadlineSeconds: Math.max(this.config.ttlSeconds, lifecycleBudgetSeconds),
      containers: [container],
      ...(this.config.serviceAccount === undefined ? {} : { serviceAccountName: this.config.serviceAccount }),
      ...(Object.keys(this.config.nodeSelector).length === 0 ? {} : { nodeSelector: this.config.nodeSelector }),
      ...(this.config.tolerations.length === 0 ? {} : { tolerations: this.config.tolerations }),
      volumes: [{ name: WORKSPACE_VOLUME_NAME, emptyDir: {} }, ...this.config.volumes],
      ...(this.config.imagePullSecrets.length === 0 ? {} : { imagePullSecrets: this.config.imagePullSecrets.map(name => ({ name })) }),
    };
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: this.config.namespace,
        labels: {
          'app.kubernetes.io/name': 'chatgpt-mcp-executor',
          'app.kubernetes.io/managed-by': 'chatgpt-mcp',
          ...this.config.podLabels,
        },
        annotations: {
          'chatgpt-mcp.openai.com/created-at': new Date().toISOString(),
          ...this.config.podAnnotations,
        },
      },
      spec,
    };
  }

  private podArgs(name: string, tail: readonly string[]): string[] {
    return ['-n', this.config.namespace, ...tail.map(value => value.replaceAll('{pod}', name))];
  }

  private async createPod(name: string, shellMaxRuntimeMs: number, signal?: AbortSignal): Promise<void> {
    const manifest = JSON.stringify(this.manifest(name, shellMaxRuntimeMs));
    requiredResult(
      await this.runClient(['create', '-f', '-'], 'shell.exec.remote.create', this.config.startupTimeoutMs, manifest, signal),
      'shell.exec.remote.create',
      'Kubernetes pod creation',
    );
    this.metrics.podCreated();
    requiredResult(
      await this.runClient(
        this.podArgs(name, ['wait', '--for=condition=Ready', 'pod/{pod}', `--timeout=${this.config.startupTimeoutMs}ms`]),
        'shell.exec.remote.wait',
        this.config.startupTimeoutMs + 5_000,
        undefined,
        signal,
      ),
      'shell.exec.remote.wait',
      'Kubernetes pod readiness wait',
    );
    this.metrics.podStarted();
  }

  private async prepareWorkspace(name: string, cwd: string, signal?: AbortSignal): Promise<void> {
    await this.streamWorkspace(name, cwd, signal);
  }

  private async streamWorkspace(name: string, cwd: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw adapterError('CANCELLED', 'shell.exec.remote.workspace', 'Request was cancelled before workspace transfer.');
    const entries = await readdir(cwd);
    const tarArgs = entries.length === 0
      ? ['-C', cwd, '-cf', '-', '--files-from', '/dev/null']
      : ['-C', cwd, ...this.config.workspace.exclude.flatMap(value => ['--exclude', value]), '-cf', '-', '--', ...entries];
    const tar = spawn('tar', tarArgs, { shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const remote = spawn(this.config.client.command, this.clientArgs(this.podArgs(name, [
      'exec', '-i', 'pod/{pod}', '--', 'tar', '--no-same-owner', '--no-same-permissions', '--touch', '-xf', '-', '-C', this.config.workspace.containerPath,
    ])), { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'pipe'] });
    let archiveBytes = 0;
    let stderr = '';
    let exceeded = false;
    let transferTimedOut = false;
    let processError: unknown;
    let streamError: unknown;
    const kill = (child: ChildProcess): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGTERM'); return; } catch {}
      }
      child.kill('SIGTERM');
    };
    const abort = (): void => { kill(tar); kill(remote); };
    const recordProcessError = (error: unknown): void => { processError ??= error; abort(); };
    const recordStreamError = (error: unknown): void => { streamError ??= error; abort(); };
    signal?.addEventListener('abort', abort, { once: true });
    tar.on('error', recordProcessError);
    remote.on('error', recordProcessError);
    tar.stdout.on('error', recordStreamError);
    remote.stdin.on('error', recordStreamError);
    tar.stdout.on('data', (chunk: Buffer) => {
      archiveBytes += chunk.length;
      if (archiveBytes > this.config.workspace.maxArchiveBytes) {
        exceeded = true;
        abort();
      }
    });
    remote.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    tar.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    tar.stdout.pipe(remote.stdin);
    const timeout = setTimeout(() => { transferTimedOut = true; abort(); }, this.config.startupTimeoutMs);
    timeout.unref();
    const [tarCode, remoteCode] = await Promise.all([
      new Promise<number | null>(resolve => tar.once('close', resolve)),
      new Promise<number | null>(resolve => remote.once('close', resolve)),
    ]);
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) throw adapterError('CANCELLED', 'shell.exec.remote.workspace', 'Request was cancelled during workspace transfer.');
    if (transferTimedOut) throw adapterError('TIMEOUT', 'shell.exec.remote.workspace', 'Workspace snapshot transfer timed out.');
    if (exceeded) {
      throw adapterError('OUTPUT_LIMIT', 'shell.exec.remote.workspace', 'Workspace snapshot exceeded the configured archive byte limit.', {
        maximum: this.config.workspace.maxArchiveBytes,
      });
    }
    if (processError !== undefined || streamError !== undefined || tarCode !== 0 || remoteCode !== 0) {
      const error = (processError ?? streamError) as NodeJS.ErrnoException | undefined;
      throw adapterError('OS_ERROR', 'shell.exec.remote.workspace', 'Workspace snapshot transfer failed.', {
        tarCode,
        remoteCode,
        stderr,
        ...(typeof error?.code === 'string' ? { osCode: error.code } : {}),
      });
    }
  }

  private async prepareDependencies(name: string, cwd: string, signal?: AbortSignal): Promise<void> {
    for (const prepared of this.config.workspace.prepareCommands) {
      if (prepared.whenFiles.length > 0) {
        let matched = true;
        for (const relativePath of prepared.whenFiles) {
          try { await access(resolve(cwd, relativePath)); } catch { matched = false; break; }
        }
        if (!matched) continue;
      }
      const environment = Object.entries(this.config.requiredEnvironment).map(([key, value]) => `${key}=${value}`);
      const command = environment.length > 0 ? ['env', '--', ...environment, prepared.command, ...prepared.args] : [prepared.command, ...prepared.args];
      const result = requiredResult(
        await this.runClient(
          this.podArgs(name, ['exec', 'pod/{pod}', '--', ...command]),
          'shell.exec.remote.prepare',
          prepared.timeoutMs,
          undefined,
          signal,
        ),
        'shell.exec.remote.prepare',
        `Remote preparation command ${prepared.command}`,
      );
      this.metrics.addOutput('remote', Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8'));
    }
  }

  private async verifyParity(name: string, signal?: AbortSignal): Promise<void> {
    const pinnedImage = this.config.image?.includes('@sha256:') === true;
    if (pinnedImage && this.parityVerifiedForPinnedImage) return;

    const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
    const lines = ['set -eu'];
    for (const [key, value] of Object.entries(this.config.requiredEnvironment)) {
      lines.push(`export ${key}=${quote(value)}`);
    }
    for (const command of this.config.requiredCommands) {
      if (!COMMAND_NAME.test(command)) throw adapterError('INVALID_INPUT', 'shell.exec.remote.parity', 'Invalid required command name.', { command });
      lines.push(`command -v ${quote(command)} >/dev/null`);
    }
    const checks = Object.entries(this.config.versionChecks);
    checks.forEach(([command, check], index) => {
      if (!COMMAND_NAME.test(command)) throw adapterError('INVALID_INPUT', 'shell.exec.remote.parity', 'Invalid version-check command name.', { command });
      lines.push(`printf '${String.fromCharCode(30)}CHATGPT_MCP_VERSION_${index}${String.fromCharCode(30)}\\n'`);
      lines.push(`${quote(command)} ${check.args.map(quote).join(' ')} 2>&1`);
    });

    const result = requiredResult(
      await this.runClient(
        this.podArgs(name, ['exec', 'pod/{pod}', '--', 'sh', '-c', lines.join('\n')]),
        'shell.exec.remote.parity',
        this.config.startupTimeoutMs,
        undefined,
        signal,
      ),
      'shell.exec.remote.parity',
      'Remote tool parity check',
    );

    for (let index = 0; index < checks.length; index += 1) {
      const [command, check] = checks[index]!;
      const marker = `${String.fromCharCode(30)}CHATGPT_MCP_VERSION_${index}${String.fromCharCode(30)}\n`;
      const nextMarker = index + 1 < checks.length
        ? `${String.fromCharCode(30)}CHATGPT_MCP_VERSION_${index + 1}${String.fromCharCode(30)}\n`
        : undefined;
      const startIndex = result.stdout.indexOf(marker);
      if (startIndex < 0) {
        throw adapterError('OS_ERROR', 'shell.exec.remote.parity', 'Remote version check output was malformed.', { command });
      }
      const valueStart = startIndex + marker.length;
      const valueEnd = nextMarker === undefined ? result.stdout.length : result.stdout.indexOf(nextMarker, valueStart);
      const output = result.stdout.slice(valueStart, valueEnd < 0 ? result.stdout.length : valueEnd);
      if (!new RegExp(check.pattern).test(output)) {
        throw adapterError('OS_ERROR', 'shell.exec.remote.parity', 'Remote executable version did not match configured parity pattern.', {
          command, pattern: check.pattern, output: output.slice(0, 2048),
        });
      }
    }
    if (pinnedImage) this.parityVerifiedForPinnedImage = true;
  }

  private async reapExpiredPodsNow(): Promise<void> {
    const selector = 'app.kubernetes.io/name=chatgpt-mcp-executor,app.kubernetes.io/managed-by=chatgpt-mcp';
    const result = requiredResult(
      await this.runClient(
        ['-n', this.config.namespace, 'get', 'pods', '-l', selector, '-o', 'json'],
        'shell.exec.remote.reap',
        this.config.cleanupTimeoutMs,
      ),
      'shell.exec.remote.reap',
      'Kubernetes orphan listing',
    );
    let payload: { items?: Array<{ metadata?: { name?: string; annotations?: Record<string, string> } }> };
    try {
      payload = JSON.parse(result.stdout) as typeof payload;
    } catch {
      throw adapterError('OS_ERROR', 'shell.exec.remote.reap', 'Kubernetes orphan listing returned invalid JSON.');
    }
    const cutoff = Date.now() - this.config.ttlSeconds * 1000;
    for (const item of payload.items ?? []) {
      const name = item.metadata?.name;
      const createdAt = item.metadata?.annotations?.['chatgpt-mcp.openai.com/created-at'];
      if (name === undefined || createdAt === undefined) continue;
      const created = Date.parse(createdAt);
      if (!Number.isFinite(created) || created > cutoff) continue;
      try {
        const deleted = await this.runClient(
          ['-n', this.config.namespace, 'delete', 'pod', name, '--ignore-not-found=true', '--wait=false'],
          'shell.exec.remote.reap',
          this.config.cleanupTimeoutMs,
        );
        if (!deleted.timedOut && deleted.exitCode === 0) this.metrics.orphanReaped();
      } catch {
        // Reaping is best-effort maintenance. The upcoming job still gets a chance to run.
      }
    }
  }

  private async reapExpiredPods(): Promise<void> {
    const intervalMs = Math.max(5_000, Math.min(60_000, Math.floor(this.config.ttlSeconds * 500)));
    if (Date.now() - this.lastReapAt < intervalMs) return;
    if (this.reapInFlight !== undefined) return this.reapInFlight;
    this.reapInFlight = this.reapExpiredPodsNow()
      .catch(() => undefined)
      .finally(() => {
        this.lastReapAt = Date.now();
        this.reapInFlight = undefined;
      });
    return this.reapInFlight;
  }

  private async cleanup(name: string): Promise<void> {
    try {
      await this.runClient(
        ['-n', this.config.namespace, 'delete', 'pod', name, '--ignore-not-found=true', '--wait=false'],
        'shell.exec.remote.cleanup',
        this.config.cleanupTimeoutMs,
      );
      this.metrics.cleanup(true);
    } catch {
      this.metrics.cleanup(false);
    }
  }

  async exec(request: ExecRequest, shellMaxRuntimeMs: number, maxOutputBytes: number): Promise<ExecResult> {
    if (!this.config.enabled || this.config.image === undefined) {
      throw adapterError('CAPABILITY_DISABLED', 'shell.exec.remote', 'Kubernetes execution is disabled.');
    }
    if (request.cwd === undefined) {
      throw adapterError('INVALID_INPUT', 'shell.exec.remote', 'Remote execution requires an explicit cwd for workspace isolation.');
    }
    const name = `chatgpt-mcp-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const started = process.hrtime.bigint();
    try {
      await this.reapExpiredPods();
      await this.createPod(name, shellMaxRuntimeMs, request.signal);
      await this.prepareWorkspace(name, request.cwd, request.signal);
      await this.verifyParity(name, request.signal);
      await this.prepareDependencies(name, request.cwd, request.signal);
      const remoteEnv = { ...(request.env ?? {}), ...this.config.requiredEnvironment };
      const envArgs = Object.entries(remoteEnv).map(([key, value]) => `${key}=${value}`);
      const command = envArgs.length > 0 ? ['env', '--', ...envArgs, request.command, ...request.args] : [request.command, ...request.args];
      const result = await spawnBounded(this.config.client.command, this.clientArgs(this.podArgs(name, [
        'exec', 'pod/{pod}', '--', ...command,
      ])), {
        timeoutMs: request.timeoutMs ?? shellMaxRuntimeMs,
        maxOutputBytes,
        operation: 'shell.exec.remote',
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onOutputBytes: bytes => this.metrics.addOutput('remote', bytes),
      });
      if (result.timedOut) {
        throw adapterError('TIMEOUT', 'shell.exec', 'Remote command timed out.');
      }
      this.metrics.commandCompleted();
      this.metrics.recordDuration('remote', Number(process.hrtime.bigint() - started) / 1_000_000);
      return result;
    } catch (error) {
      this.metrics.recordRemoteError();
      if (isComputerAdapterError(error)) throw error;
      throw adapterError('OS_ERROR', 'shell.exec.remote', 'Kubernetes execution failed.');
    } finally {
      await this.cleanup(name);
    }
  }
}
