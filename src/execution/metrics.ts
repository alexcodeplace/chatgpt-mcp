export interface ExecutionMetricsSnapshot {
  routing: { local: number; remote: number; forcedLocal: number; remoteErrors: number };
  outputBytes: { local: number; remote: number };
  durationMs: { localTotal: number; remoteTotal: number; localPeak: number; remotePeak: number };
  kubernetes: { podsCreated: number; podsStarted: number; commandsCompleted: number; cleanupSucceeded: number; cleanupFailed: number };
}

export class ExecutionMetrics {
  private local = 0;
  private remote = 0;
  private forcedLocal = 0;
  private remoteErrors = 0;
  private localOutputBytes = 0;
  private remoteOutputBytes = 0;
  private localDurationTotal = 0;
  private remoteDurationTotal = 0;
  private localDurationPeak = 0;
  private remoteDurationPeak = 0;
  private podsCreated = 0;
  private podsStarted = 0;
  private commandsCompleted = 0;
  private cleanupSucceeded = 0;
  private cleanupFailed = 0;

  recordRoute(route: 'local' | 'remote' | 'forced-local'): void {
    if (route === 'local') this.local += 1;
    else if (route === 'remote') this.remote += 1;
    else this.forcedLocal += 1;
  }
  recordRemoteError(): void { this.remoteErrors += 1; }
  addOutput(route: 'local' | 'remote', bytes: number): void {
    if (route === 'local') this.localOutputBytes += bytes;
    else this.remoteOutputBytes += bytes;
  }
  recordDuration(route: 'local' | 'remote', durationMs: number): void {
    if (route === 'local') {
      this.localDurationTotal += durationMs;
      this.localDurationPeak = Math.max(this.localDurationPeak, durationMs);
    } else {
      this.remoteDurationTotal += durationMs;
      this.remoteDurationPeak = Math.max(this.remoteDurationPeak, durationMs);
    }
  }
  podCreated(): void { this.podsCreated += 1; }
  podStarted(): void { this.podsStarted += 1; }
  commandCompleted(): void { this.commandsCompleted += 1; }
  cleanup(ok: boolean): void { if (ok) this.cleanupSucceeded += 1; else this.cleanupFailed += 1; }

  snapshot(): ExecutionMetricsSnapshot {
    return {
      routing: { local: this.local, remote: this.remote, forcedLocal: this.forcedLocal, remoteErrors: this.remoteErrors },
      outputBytes: { local: this.localOutputBytes, remote: this.remoteOutputBytes },
      durationMs: {
        localTotal: this.localDurationTotal, remoteTotal: this.remoteDurationTotal,
        localPeak: this.localDurationPeak, remotePeak: this.remoteDurationPeak,
      },
      kubernetes: {
        podsCreated: this.podsCreated, podsStarted: this.podsStarted, commandsCompleted: this.commandsCompleted,
        cleanupSucceeded: this.cleanupSucceeded, cleanupFailed: this.cleanupFailed,
      },
    };
  }
}
