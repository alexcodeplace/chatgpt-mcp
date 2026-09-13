import type { ChatGptMcpConfig } from './config.js';
import { adapterError } from './errors.js';

export type AdmissionClass = 'control' | 'normal' | 'shell-local' | 'shell-local-long' | 'shell-remote';

const CONTROL_OPERATIONS = new Set([
  'system.info',
  'exec.status',
  'exec.output',
  'exec.cancel',
  'exec.list',
  'process.list',
  'process.kill',
  'service.status',
  'service.control',
]);

interface QueueEntry {
  operation: string;
  kind: AdmissionClass;
  fn: () => Promise<unknown>;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer?: NodeJS.Timeout;
  abortHandler?: () => void;
}

export interface ConcurrencySnapshot {
  status: 'ready' | 'busy' | 'overloaded';
  limits: {
    maxConcurrent: number;
    maxNonControlConcurrent: number;
    reservedControlSlots: number;
    shellMaxConcurrent: number;
    reservedInteractiveShellSlots: number;
    longShellMaxConcurrent: number;
    remoteShellMaxConcurrent: number;
    maxQueue: number;
    queueTimeoutMs: number;
  };
  active: { total: number; control: number; nonControl: number; shell: number; localShell: number; localShellInteractive: number; localShellLong: number; remoteShell: number };
  queued: { total: number; control: number; regular: number; localShell: number; localShellInteractive: number; localShellLong: number; remoteShell: number };
  peaks: { active: number; shell: number; localShell: number; remoteShell: number; queued: number };
  counters: {
    submitted: number;
    accepted: number;
    started: number;
    completed: number;
    rejected: number;
    timedOut: number;
    cancelled: number;
  };
}

export function admissionClassForOperation(operation: string): AdmissionClass {
  if (operation === 'shell.exec') return 'shell-local';
  if (CONTROL_OPERATIONS.has(operation)) return 'control';
  return 'normal';
}

export class ConcurrencyController {
  private active = 0;
  private activeControl = 0;
  private activeNonControl = 0;
  private activeShellLocal = 0;
  private activeShellLocalLong = 0;
  private activeShellRemote = 0;
  private readonly controlQueue: QueueEntry[] = [];
  private readonly regularQueue: QueueEntry[] = [];
  private peakActive = 0;
  private peakShell = 0;
  private peakShellLocal = 0;
  private peakShellRemote = 0;
  private peakQueued = 0;
  private submitted = 0;
  private accepted = 0;
  private started = 0;
  private completed = 0;
  private rejected = 0;
  private timedOut = 0;
  private cancelled = 0;

  constructor(
    private readonly config: Readonly<ChatGptMcpConfig['concurrency']>,
    private readonly remoteShellMaxConcurrent = 24,
  ) {}

  async run<T>(operation: string, fn: () => Promise<T>, signal?: AbortSignal, admissionOverride?: AdmissionClass): Promise<T> {
    this.submitted += 1;
    if (signal?.aborted) {
      this.cancelled += 1;
      throw adapterError('CANCELLED', operation, 'Request was cancelled before execution.');
    }

    const kind = admissionOverride ?? admissionClassForOperation(operation);
    if (this.canStart(kind)) {
      this.accepted += 1;
      return await this.execute(operation, kind, fn, signal);
    }

    if (this.queuedTotal() >= this.config.maxQueue) {
      this.rejected += 1;
      throw this.overloaded(operation, 'Admission queue is full.');
    }

    this.accepted += 1;
    return await new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        operation,
        kind,
        fn: fn as () => Promise<unknown>,
        resolve: value => resolve(value as T),
        reject,
        ...(signal === undefined ? {} : { signal }),
      };
      const queue = kind === 'control' ? this.controlQueue : this.regularQueue;
      queue.push(entry);
      this.peakQueued = Math.max(this.peakQueued, this.queuedTotal());

      entry.timer = setTimeout(() => {
        if (!this.removeQueued(entry)) return;
        this.timedOut += 1;
        this.cleanupEntry(entry);
        reject(this.overloaded(operation, 'Admission queue wait timed out.'));
        this.drain();
      }, this.config.queueTimeoutMs);
      entry.timer.unref();

      if (signal !== undefined) {
        entry.abortHandler = () => {
          if (!this.removeQueued(entry)) return;
          this.cancelled += 1;
          this.cleanupEntry(entry);
          reject(adapterError('CANCELLED', operation, 'Request was cancelled while waiting for execution.'));
          this.drain();
        };
        signal.addEventListener('abort', entry.abortHandler, { once: true });
      }

      this.drain();
    });
  }

  snapshot(): ConcurrencySnapshot {
    const queued = this.queuedTotal();
    return {
      status: queued >= this.config.maxQueue ? 'overloaded' : (queued > 0 || this.active >= this.config.maxConcurrent || this.activeNonControl >= this.maxNonControlConcurrent() ? 'busy' : 'ready'),
      limits: {
        maxConcurrent: this.config.maxConcurrent,
        maxNonControlConcurrent: this.maxNonControlConcurrent(),
        reservedControlSlots: this.config.reservedControlSlots,
        shellMaxConcurrent: this.config.shellMaxConcurrent,
        reservedInteractiveShellSlots: this.reservedInteractiveShellSlots(),
        longShellMaxConcurrent: this.longShellMaxConcurrent(),
        remoteShellMaxConcurrent: this.remoteShellMaxConcurrent,
        maxQueue: this.config.maxQueue,
        queueTimeoutMs: this.config.queueTimeoutMs,
      },
      active: {
        total: this.active,
        control: this.activeControl,
        nonControl: this.activeNonControl,
        shell: this.activeShellLocal + this.activeShellRemote,
        localShell: this.activeShellLocal,
        localShellInteractive: this.activeShellLocal - this.activeShellLocalLong,
        localShellLong: this.activeShellLocalLong,
        remoteShell: this.activeShellRemote,
      },
      queued: {
        total: queued,
        control: this.controlQueue.length,
        regular: this.regularQueue.length,
        localShell: this.regularQueue.filter(entry => entry.kind === 'shell-local' || entry.kind === 'shell-local-long').length,
        localShellInteractive: this.regularQueue.filter(entry => entry.kind === 'shell-local').length,
        localShellLong: this.regularQueue.filter(entry => entry.kind === 'shell-local-long').length,
        remoteShell: this.regularQueue.filter(entry => entry.kind === 'shell-remote').length,
      },
      peaks: { active: this.peakActive, shell: this.peakShell, localShell: this.peakShellLocal, remoteShell: this.peakShellRemote, queued: this.peakQueued },
      counters: {
        submitted: this.submitted,
        accepted: this.accepted,
        started: this.started,
        completed: this.completed,
        rejected: this.rejected,
        timedOut: this.timedOut,
        cancelled: this.cancelled,
      },
    };
  }

  private maxNonControlConcurrent(): number {
    return this.config.maxConcurrent - this.config.reservedControlSlots;
  }

  private reservedInteractiveShellSlots(): number {
    return this.config.reservedInteractiveShellSlots ?? Math.min(2, Math.max(0, this.config.shellMaxConcurrent - 1));
  }

  private longShellMaxConcurrent(): number {
    return this.config.shellMaxConcurrent - this.reservedInteractiveShellSlots();
  }

  private queuedTotal(): number {
    return this.controlQueue.length + this.regularQueue.length;
  }

  private canStart(kind: AdmissionClass): boolean {
    if (this.active >= this.config.maxConcurrent) return false;
    if (kind === 'control') return true;
    if (this.activeNonControl >= this.maxNonControlConcurrent()) return false;
    if ((kind === 'shell-local' || kind === 'shell-local-long') && this.activeShellLocal >= this.config.shellMaxConcurrent) return false;
    if (kind === 'shell-local-long' && this.activeShellLocalLong >= this.longShellMaxConcurrent()) return false;
    if (kind === 'shell-remote' && this.activeShellRemote >= this.remoteShellMaxConcurrent) return false;
    return true;
  }

  private overloaded(operation: string, message: string) {
    const snapshot = this.snapshot();
    return adapterError('OVERLOADED', operation, message, {
      active: snapshot.active.total,
      activeShell: snapshot.active.shell,
      activeLocalShell: snapshot.active.localShell,
      activeLongLocalShell: snapshot.active.localShellLong,
      activeRemoteShell: snapshot.active.remoteShell,
      queued: snapshot.queued.total,
      maxConcurrent: snapshot.limits.maxConcurrent,
      shellMaxConcurrent: snapshot.limits.shellMaxConcurrent,
      longShellMaxConcurrent: snapshot.limits.longShellMaxConcurrent,
      remoteShellMaxConcurrent: snapshot.limits.remoteShellMaxConcurrent,
      maxQueue: snapshot.limits.maxQueue,
    });
  }

  private cleanupEntry(entry: QueueEntry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (entry.signal !== undefined && entry.abortHandler !== undefined) entry.signal.removeEventListener('abort', entry.abortHandler);
  }

  private removeQueued(entry: QueueEntry): boolean {
    for (const queue of [this.controlQueue, this.regularQueue]) {
      const index = queue.indexOf(entry);
      if (index >= 0) {
        queue.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  private takeStartable(queue: QueueEntry[]): QueueEntry | undefined {
    const index = queue.findIndex(entry => this.canStart(entry.kind));
    if (index < 0) return undefined;
    return queue.splice(index, 1)[0];
  }

  private drain(): void {
    while (true) {
      const control = this.takeStartable(this.controlQueue);
      const next = control ?? this.takeStartable(this.regularQueue);
      if (next === undefined) return;
      this.cleanupEntry(next);
      void this.execute(next.operation, next.kind, next.fn, next.signal).then(next.resolve, next.reject);
    }
  }

  private async execute<T>(_operation: string, kind: AdmissionClass, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.active += 1;
    if (kind === 'control') this.activeControl += 1;
    else this.activeNonControl += 1;
    if (kind === 'shell-local' || kind === 'shell-local-long') this.activeShellLocal += 1;
    if (kind === 'shell-local-long') this.activeShellLocalLong += 1;
    if (kind === 'shell-remote') this.activeShellRemote += 1;
    this.started += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    this.peakShell = Math.max(this.peakShell, this.activeShellLocal + this.activeShellRemote);
    this.peakShellLocal = Math.max(this.peakShellLocal, this.activeShellLocal);
    this.peakShellRemote = Math.max(this.peakShellRemote, this.activeShellRemote);

    let cancellationRecorded = false;
    const abortHandler = (): void => {
      if (cancellationRecorded) return;
      cancellationRecorded = true;
      this.cancelled += 1;
    };
    if (signal?.aborted) abortHandler();
    else signal?.addEventListener('abort', abortHandler, { once: true });

    try {
      return await fn();
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      this.active -= 1;
      if (kind === 'control') this.activeControl -= 1;
      else this.activeNonControl -= 1;
      if (kind === 'shell-local' || kind === 'shell-local-long') this.activeShellLocal -= 1;
      if (kind === 'shell-local-long') this.activeShellLocalLong -= 1;
      if (kind === 'shell-remote') this.activeShellRemote -= 1;
      this.completed += 1;
      this.drain();
    }
  }
}
