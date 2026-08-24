import type { ChatGptMcpConfig } from './config.js';
import { adapterError } from './errors.js';

export type AdmissionClass = 'control' | 'normal' | 'shell';

const CONTROL_OPERATIONS = new Set([
  'system.info',
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
    maxQueue: number;
    queueTimeoutMs: number;
  };
  active: { total: number; control: number; nonControl: number; shell: number };
  queued: { total: number; control: number; regular: number };
  peaks: { active: number; shell: number; queued: number };
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
  if (operation === 'shell.exec') return 'shell';
  if (CONTROL_OPERATIONS.has(operation)) return 'control';
  return 'normal';
}

export class ConcurrencyController {
  private active = 0;
  private activeControl = 0;
  private activeNonControl = 0;
  private activeShell = 0;
  private readonly controlQueue: QueueEntry[] = [];
  private readonly regularQueue: QueueEntry[] = [];
  private peakActive = 0;
  private peakShell = 0;
  private peakQueued = 0;
  private submitted = 0;
  private accepted = 0;
  private started = 0;
  private completed = 0;
  private rejected = 0;
  private timedOut = 0;
  private cancelled = 0;

  constructor(private readonly config: Readonly<ChatGptMcpConfig['concurrency']>) {}

  async run<T>(operation: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.submitted += 1;
    if (signal?.aborted) {
      this.cancelled += 1;
      throw adapterError('CANCELLED', operation, 'Request was cancelled before execution.');
    }

    const kind = admissionClassForOperation(operation);
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
        maxQueue: this.config.maxQueue,
        queueTimeoutMs: this.config.queueTimeoutMs,
      },
      active: { total: this.active, control: this.activeControl, nonControl: this.activeNonControl, shell: this.activeShell },
      queued: { total: queued, control: this.controlQueue.length, regular: this.regularQueue.length },
      peaks: { active: this.peakActive, shell: this.peakShell, queued: this.peakQueued },
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

  private queuedTotal(): number {
    return this.controlQueue.length + this.regularQueue.length;
  }

  private canStart(kind: AdmissionClass): boolean {
    if (this.active >= this.config.maxConcurrent) return false;
    if (kind === 'control') return true;
    if (this.activeNonControl >= this.maxNonControlConcurrent()) return false;
    if (kind === 'shell' && this.activeShell >= this.config.shellMaxConcurrent) return false;
    return true;
  }

  private overloaded(operation: string, message: string) {
    const snapshot = this.snapshot();
    return adapterError('OVERLOADED', operation, message, {
      active: snapshot.active.total,
      activeShell: snapshot.active.shell,
      queued: snapshot.queued.total,
      maxConcurrent: snapshot.limits.maxConcurrent,
      shellMaxConcurrent: snapshot.limits.shellMaxConcurrent,
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
    if (kind === 'shell') this.activeShell += 1;
    this.started += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    this.peakShell = Math.max(this.peakShell, this.activeShell);

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
      if (kind === 'shell') this.activeShell -= 1;
      this.completed += 1;
      this.drain();
    }
  }
}
