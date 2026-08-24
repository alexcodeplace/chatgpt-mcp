import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChatGptMcpConfig } from '../config.js';
import type { ExecRequest, ExecResult } from '../adapter/computer-adapter.js';
import { adapterError, isComputerAdapterError } from '../errors.js';
import { spawnBounded } from './bounded-process.js';
import { ExecutionMetrics } from './metrics.js';

const INTERNAL_OUTPUT_LIMIT = 1024 * 1024;
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
    const container: Record<string, unknown> = {
      name: 'executor',
      image: this.config.image,
      imagePullPolicy: this.config.imagePullPolicy,
      command: ['sleep', 'infinity'],
      resources: this.config.resources,
      ...(this.config.volumeMounts.length > 0 ? { volumeMounts: this.config.volumeMounts } : {}),
    };
    const spec: Record<string, unknown> = {
      restartPolicy: 'Never',
      activeDeadlineSeconds: Math.max(this.config.ttlSeconds, Math.ceil(shellMaxRuntimeMs / 1000) + 60),
      containers: [container],
      ...(this.config.serviceAccount === undefined ? {} : { serviceAccountName: this.config.serviceAccount }),
      ...(Object.keys(this.config.nodeSelector).length === 0 ? {} : { nodeSelector: this.config.nodeSelector }),
      ...(this.config.tolerations.length === 0 ? {} : { tolerations: this.config.tolerations }),
      ...(this.config.volumes.length === 0 ? {} : { volumes: this.config.volumes }),
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
    const mkdirResult = await this.runClient(
      this.podArgs(name, ['exec', 'pod/{pod}', '--', 'mkdir', '-p', this.config.workspace.containerPath]),
      'shell.exec.remote.workspace',
      this.config.startupTimeoutMs,
      undefined,
      signal,
    );
    requiredResult(mkdirResult, 'shell.exec.remote.workspace', 'Remote workspace creation');
    await this.streamWorkspace(name, cwd, signal);
  }

  private async streamWorkspace(name: string, cwd: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw adapterError('CANCELLED', 'shell.exec.remote.workspace', 'Request was cancelled before workspace transfer.');
    const tarArgs = ['-C', cwd, ...this.config.workspace.exclude.flatMap(value => ['--exclude', value]), '-cf', '-', '.'];
    const tar = spawn('tar', tarArgs, { shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const remote = spawn(this.config.client.command, this.clientArgs(this.podArgs(name, [
      'exec', '-i', 'pod/{pod}', '--', 'tar', '-xf', '-', '-C', this.config.workspace.containerPath,
    ])), { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'pipe'] });
    let archiveBytes = 0;
    let stderr = '';
    let exceeded = false;
    const kill = (child: ChildProcess): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGTERM'); return; } catch {}
      }
      child.kill('SIGTERM');
    };
    const abort = (): void => { kill(tar); kill(remote); };
    signal?.addEventListener('abort', abort, { once: true });
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
    const timeout = setTimeout(abort, this.config.startupTimeoutMs);
    timeout.unref();
    const [tarCode, remoteCode] = await Promise.all([
      new Promise<number | null>(resolve => tar.once('close', resolve)),
      new Promise<number | null>(resolve => remote.once('close', resolve)),
    ]);
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) throw adapterError('CANCELLED', 'shell.exec.remote.workspace', 'Request was cancelled during workspace transfer.');
    if (exceeded) {
      throw adapterError('OUTPUT_LIMIT', 'shell.exec.remote.workspace', 'Workspace snapshot exceeded the configured archive byte limit.', {
        maximum: this.config.workspace.maxArchiveBytes,
      });
    }
    if (tarCode !== 0 || remoteCode !== 0) {
      throw adapterError('OS_ERROR', 'shell.exec.remote.workspace', 'Workspace snapshot transfer failed.', { tarCode, remoteCode, stderr });
    }
  }

  private async verifyParity(name: string, signal?: AbortSignal): Promise<void> {
    for (const command of this.config.requiredCommands) {
      if (!COMMAND_NAME.test(command)) throw adapterError('INVALID_INPUT', 'shell.exec.remote.parity', 'Invalid required command name.', { command });
      const result = await this.runClient(
        this.podArgs(name, ['exec', 'pod/{pod}', '--', 'sh', '-c', `command -v -- ${command}`]),
        'shell.exec.remote.parity',
        this.config.startupTimeoutMs,
        undefined,
        signal,
      );
      requiredResult(result, 'shell.exec.remote.parity', `Required command ${command}`);
    }
    for (const [command, check] of Object.entries(this.config.versionChecks)) {
      if (!COMMAND_NAME.test(command)) throw adapterError('INVALID_INPUT', 'shell.exec.remote.parity', 'Invalid version-check command name.', { command });
      const result = requiredResult(
        await this.runClient(
          this.podArgs(name, ['exec', 'pod/{pod}', '--', command, ...check.args]),
          'shell.exec.remote.parity',
          this.config.startupTimeoutMs,
          undefined,
          signal,
        ),
        'shell.exec.remote.parity',
        `Version check for ${command}`,
      );
      const output = `${result.stdout}\n${result.stderr}`;
      if (!new RegExp(check.pattern).test(output)) {
        throw adapterError('OS_ERROR', 'shell.exec.remote.parity', 'Remote executable version did not match configured parity pattern.', {
          command, pattern: check.pattern, output: output.slice(0, 2048),
        });
      }
    }
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
      await this.createPod(name, shellMaxRuntimeMs, request.signal);
      await this.prepareWorkspace(name, request.cwd, request.signal);
      await this.verifyParity(name, request.signal);
      const remoteEnv = { ...this.config.requiredEnvironment, ...(request.env ?? {}) };
      const envArgs = Object.entries(remoteEnv).map(([key, value]) => `${key}=${value}`);
      const command = envArgs.length > 0 ? ['env', ...envArgs, request.command, ...request.args] : [request.command, ...request.args];
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
