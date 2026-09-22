import { instanceId, routingAbi, jobsAbi, policyFingerprint } from './hotswap/identity.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { ChatGptMcpConfig } from './config.js';

const context = new AsyncLocalStorage<{ requestId: string; transportSignal?: AbortSignal; signals: WeakMap<AbortSignal, AbortSignal> }>();
const startedAt = new Date().toISOString();
const fingerprints = new WeakMap<object, string>();
export function diagnosticId(): string { return context.getStore()?.requestId ?? randomUUID(); }
export function withDiagnosticRequest<T>(fn: () => T, transportSignal?: AbortSignal): T {
  return context.run({ requestId: randomUUID(), signals: new WeakMap(), ...(transportSignal ? { transportSignal } : {}) }, fn);
}

/** Keep cancellation attached to the native HTTP exchange, even when SDK
 * transports release intermediate Request/AbortSignal objects while streaming.
 * Stdio and direct SDK users retain their original signal unchanged. */
export function requestSignal(sdkSignal: AbortSignal): AbortSignal {
  const current = context.getStore();
  if (!current?.transportSignal) return sdkSignal;
  let combined = current.signals.get(sdkSignal);
  if (!combined) {
    combined = AbortSignal.any([current.transportSignal, sdkSignal]);
    current.signals.set(sdkSignal, combined);
  }
  return combined;
}

/** Never include arguments, URLs, environment values, output, or arbitrary exception messages. */
export function trace(event: string, fields: Record<string, string | number | boolean | null>): void {
  if (process.env.CHATGPT_MCP_TRACE !== '1') return;
  console.error(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

export function runtimeIdentity(config: Readonly<ChatGptMcpConfig>): Record<string, unknown> {
  let hash = fingerprints.get(config);
  if (hash === undefined) {
    hash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    fingerprints.set(config, hash);
  }
  return { release: process.env.CHATGPT_MCP_RELEASE ?? 'development', pid: process.pid, startedAt,
    observedAt: new Date().toISOString(), configFingerprint: hash, durableJobs: config.jobs.enabled && config.shell.enabled,
    jobLauncher: config.jobs.launcher,
    hotSwap: { instanceId, routingAbi, jobsAbi, policyFingerprint: policyFingerprint(config) } };
}

export function errorCategory(code: string): string {
  if (['CAPABILITY_DISABLED', 'PATH_NOT_ALLOWED', 'COMMAND_NOT_ALLOWED'].includes(code)) return 'policy';
  if (code === 'OVERLOADED') return 'capacity';
  if (code === 'OUTCOME_UNKNOWN') return 'unknown_outcome';
  if (code === 'CONFLICT') return 'concurrent_change';
  if (code === 'CANCELLED') return 'cancellation';
  return 'execution';
}
