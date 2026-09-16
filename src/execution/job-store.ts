import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecRequest } from '../adapter/computer-adapter.js';
import type { ChatGptMcpConfig } from '../config.js';
import { adapterError } from '../errors.js';
import { authorizePath, authorizeShellFilesystemMutation, authorizeShellFilesystemRead } from '../policy/filesystem.js';
import { authorizeCommand, authorizeHostDisplaySafeInvocation, effectiveShellRuntime, validateShellEnvironment } from '../policy/shell.js';
import { compileCommandPolicies, enforceCommandPolicy, evaluateCommandPolicy } from '../policy/command-policy.js';
import { spawnBounded } from './bounded-process.js';

export type JobState = 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface JobRecord {
  jobId: string;
  requestHash: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  timeoutMs: number;
  workerPid?: number;
  workerIdentity?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  errorCode?: string;
  resultBytes?: number;
  outputExpired?: boolean;
  cancellationRequested?: boolean;
}
export interface JobRequest {
  request: Omit<ExecRequest, 'signal'>;
  config: Readonly<ChatGptMcpConfig>;
}
export type JobLauncher = (directory: string, jobId: string, timeoutMs: number) => Promise<void>;
const TERMINAL = new Set<JobState>(['succeeded', 'failed', 'cancelled']);
const validId = /^[a-f0-9]{64}$/;

export async function atomicJobJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const parent = await open(dirname(path), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally { await rm(temporary, { force: true }); }
}

export async function processIdentity(pid: number): Promise<string | undefined> {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const [boot, info] = await Promise.all([readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8')]);
      const fields = info.slice(info.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') return undefined;
      return `${boot.trim()}:${fields[19]}`;
    }
    return `pid:${pid}`;
  } catch { return undefined; }
}

function fingerprint(request: Omit<ExecRequest, 'signal'>): string {
  return createHash('sha256').update(JSON.stringify({ command: request.command, args: [...request.args], cwd: request.cwd ?? null,
    timeoutMs: request.timeoutMs ?? null, env: Object.entries(request.env ?? {}).sort(([a], [b]) => a.localeCompare(b)) })).digest('hex');
}

export class JobStore {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly commandPolicies: ReturnType<typeof compileCommandPolicies>;
  constructor(private readonly config: Readonly<ChatGptMcpConfig>, private readonly launcher?: JobLauncher) {
    this.commandPolicies = compileCommandPolicies(config.execution.commandPolicies);
  }
  get directory(): string { return this.config.jobs.directory; }

  private path(jobId: string): string {
    if (!validId.test(jobId)) throw adapterError('INVALID_INPUT', 'exec.status', 'Invalid job identifier.');
    return join(this.directory, jobId);
  }

  async status(jobId: string): Promise<JobRecord> {
    let record: JobRecord;
    try { record = JSON.parse(await readFile(join(this.path(jobId), 'status.json'), 'utf8')) as JobRecord; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw adapterError('NOT_FOUND', 'exec.status', 'Job is not present in the retained ledger.');
      throw error;
    }
    if (!TERMINAL.has(record.state)) {
      const elapsed = Date.now() - Date.parse(record.updatedAt);
      if (record.workerPid !== undefined) {
        const identity = await processIdentity(record.workerPid);
        if (identity === undefined || identity !== record.workerIdentity) {
          record = { ...record, state: 'unknown', errorCode: 'OUTCOME_UNKNOWN' };
        }
      } else if (elapsed > 30_000) record = { ...record, state: 'unknown', errorCode: 'OUTCOME_UNKNOWN' };
    }
    try { await stat(join(this.path(jobId), 'cancel.json')); record.cancellationRequested = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return record;
  }

  async list(limit = 50): Promise<JobRecord[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = (await readdir(this.directory)).filter(id => validId.test(id));
    const records: JobRecord[] = [];
    for (const id of entries) {
      try { records.push(await this.status(id)); }
      catch (error) { if ((error as { code?: string }).code !== 'NOT_FOUND') throw error; }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async start(operationId: string, supplied: Omit<ExecRequest, 'signal'>): Promise<JobRecord> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(operationId)) throw adapterError('INVALID_INPUT', 'exec.start', 'Use a unique operation identifier of 8 to 128 letters, digits, underscores or hyphens.');
    const perform = async (): Promise<JobRecord> => {
      if (!this.config.jobs.enabled || !this.config.shell.enabled) throw adapterError('CAPABILITY_DISABLED', 'exec.start', 'Durable execution is disabled.');
      authorizeCommand(supplied.command, supplied.args, this.config.shell);
      authorizeHostDisplaySafeInvocation(supplied.command, supplied.args, this.config.desktop.hostDisplayAccess);
      const cwd = await authorizePath(supplied.cwd ?? process.cwd(), this.config.filesystem.roots, 'exec.start');
      const policy = evaluateCommandPolicy(this.commandPolicies, { command: supplied.command, args: supplied.args, cwd });
      enforceCommandPolicy(policy, 'exec.start');
      if (policy?.action.type === 'route' && policy.action.backend === 'kubernetes' && (!this.config.execution.kubernetes.enabled || this.config.execution.kubernetes.image === undefined)) {
        throw adapterError('CAPABILITY_DISABLED', 'exec.start', 'Command policy requires the Kubernetes execution backend, but it is not configured.', { ruleId: policy.ruleId, backend: 'kubernetes' });
      }
      await authorizeShellFilesystemRead(supplied.command, supplied.args, cwd, this.config.filesystem.blocklist, 'exec.start');
      await authorizeShellFilesystemMutation(supplied.command, supplied.args, cwd, this.config.filesystem.blocklist, 'exec.start');
      validateShellEnvironment(supplied.env, this.config.shell.allowEnvironment, this.config.desktop.hostDisplayAccess);
      const timeoutMs = effectiveShellRuntime(supplied.timeoutMs, this.config.shell.defaultRuntimeMs ?? 30_000, this.config.shell.maxRuntimeMs);
      const request = { ...supplied, cwd, timeoutMs };
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 256 * 1024) throw adapterError('OUTPUT_LIMIT', 'exec.start', 'Job request exceeds the 256 KiB durable input limit.');
      const jobId = createHash('sha256').update(operationId).digest('hex');
      const requestHash = fingerprint(request);
      const directory = this.path(jobId);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        const existing = await this.status(jobId);
        if (existing.requestHash !== requestHash) throw adapterError('CONFLICT', 'exec.start', 'This operation identifier was already used for a different request.');
        return existing;
      } catch (error) { if ((error as { code?: string }).code !== 'NOT_FOUND') throw error; }
      let records = await this.list(this.config.jobs.maxStoredJobs + 1);
      for (const record of records) {
        if (!TERMINAL.has(record.state)) continue;
        const age = Date.now() - Date.parse(record.updatedAt);
        if (age > this.config.jobs.retentionSeconds * 1000) {
          await rm(this.path(record.jobId), { recursive: true, force: true });
        } else if (age > this.config.jobs.outputRetentionSeconds * 1000 && !record.outputExpired) {
          for (const name of ['stdout.txt', 'stderr.txt']) await rm(join(this.path(record.jobId), name), { force: true });
          await atomicJobJson(join(this.path(record.jobId), 'status.json'), { ...record, outputExpired: true, resultBytes: 0 });
        }
      }
      records = await this.list(this.config.jobs.maxStoredJobs + 1);
      // Unknown outcomes are retained and never executed again automatically.
      const active = records.filter(r => r.state === 'running' || r.state === 'starting');
      if (active.length >= this.config.jobs.maxConcurrent) throw adapterError('OVERLOADED', 'exec.start', 'Durable execution capacity is full; retrieve an existing job instead of queueing more work.');
      if (records.length >= this.config.jobs.maxStoredJobs) throw adapterError('OUTPUT_LIMIT', 'exec.start', 'The retained job ledger is full.');
      const reservedBytes = records.reduce((sum, r) => sum + (r.resultBytes ?? (TERMINAL.has(r.state) ? 0 : this.config.shell.maxOutputBytes)), 0);
      if (reservedBytes + this.config.shell.maxOutputBytes > this.config.jobs.maxStoredOutputBytes) throw adapterError('OUTPUT_LIMIT', 'exec.start', 'Retained job output budget is full.');
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw adapterError('OUTCOME_UNKNOWN', 'exec.start', 'This operation already has a durable reservation. Inspect its status; do not submit a new identifier.');
        throw error;
      }
      const now = new Date().toISOString();
      const record: JobRecord = { jobId, requestHash, state: 'starting', createdAt: now, updatedAt: now, timeoutMs };
      await atomicJobJson(join(directory, 'status.json'), record);
      // Only the worker needs arguments/environment. Remove the request before execution.
      const { token: _token, ...http } = this.config.http;
      await atomicJobJson(join(directory, 'request.json'), { request, config: { ...this.config, http } });
      try {
        await (this.launcher ?? this.launch.bind(this))(directory, jobId, timeoutMs);
      } catch {
        // A launch response can be lost after the worker was accepted. Never replay it.
        return { ...record, state: 'unknown', errorCode: 'OUTCOME_UNKNOWN' };
      }
      return this.status(jobId);
    };
    const task = this.pending.catch(() => {}).then(perform);
    this.pending = task;
    return task;
  }

  async output(jobId: string, stream: 'stdout' | 'stderr', offset = 0, maxCharacters = 16_384): Promise<Record<string, unknown>> {
    const record = await this.status(jobId);
    if (record.outputExpired) throw adapterError('NOT_FOUND', 'exec.output', 'Job output expired; the operation identifier remains reserved until ledger retention expires.');
    if (!TERMINAL.has(record.state)) return { jobId, state: record.state, stream, offset, nextOffset: offset, text: '', complete: false };
    const stored = await readFile(join(this.path(jobId), `${stream}.txt`), 'utf8');
    const text = stored;
    const chunk = text.slice(offset, offset + maxCharacters);
    return { jobId, state: record.state, stream, offset, nextOffset: offset + chunk.length, text: chunk, complete: offset + chunk.length >= text.length };
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const record = await this.status(jobId);
    if (!TERMINAL.has(record.state)) await atomicJobJson(join(this.path(jobId), 'cancel.json'), { requestedAt: new Date().toISOString() });
    return { ...record, cancellationRequested: !TERMINAL.has(record.state) };
  }

  private async launch(directory: string, jobId: string, timeoutMs: number): Promise<void> {
    const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './job-worker.ts' : './job-worker.js', import.meta.url));
    // Use the actual server runtime, not a PATH shim that may offload the orchestrator.
    const node = process.platform === 'linux' ? await readlink('/proc/self/exe') : process.execPath;
    const nodeArgs = [...(worker.endsWith('.ts') ? ['--import', 'tsx'] : []), worker, directory];
    if (this.config.jobs.launcher === 'systemd') {
      const args = ['--user', '--quiet', '--collect', `--unit=chatgpt-mcp-job-${jobId.slice(0, 32)}`,
        '--property=KillMode=control-group', '--property=TimeoutStopSec=3s', '--property=SendSIGKILL=yes',
        `--property=RuntimeMaxSec=${Math.ceil(timeoutMs / 1000) + 30}s`, '--property=TasksMax=128',
        `--property=MemoryMax=${this.config.jobs.workerMemoryBytes}`, '--property=CPUWeight=20', '--property=UMask=0077'];
      for (const key of ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK']) {
        if (process.env[key] !== undefined) args.push(`--setenv=${key}`);
      }
      args.push('--', node, ...nodeArgs);
      const result = await spawnBounded('systemd-run', args, { timeoutMs: 5_000, maxOutputBytes: 4096, operation: 'exec.start.launch' });
      if (result.exitCode !== 0 || result.timedOut) throw adapterError('OS_ERROR', 'exec.start', 'Job supervisor did not confirm launch.');
    } else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(node, nodeArgs, { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
    }
  }
}

const stores = new WeakMap<object, JobStore>();
export function jobStore(config: Readonly<ChatGptMcpConfig>): JobStore {
  let store = stores.get(config);
  if (store === undefined) { store = new JobStore(config); stores.set(config, store); }
  return store;
}
