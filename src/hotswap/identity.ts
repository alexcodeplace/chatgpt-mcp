import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChatGptMcpConfig } from '../config.js';

/** An incarnation changes even when the same release restarts on the same port. */
export const instanceId = randomUUID().replaceAll('-', '');
export const routingAbi = 1;
export const jobsAbi = 1;
const fingerprints = new WeakMap<object, string>();

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}
export function policyFingerprint(config: Readonly<ChatGptMcpConfig>): string {
  let value = fingerprints.get(config);
  if (value === undefined) {
    // Port is transport placement. Object ordering is not policy, but array
    // ordering is: ordered command/blocklist rules must never be sorted away.
    value = createHash('sha256').update(JSON.stringify(canonical({ ...config, http: { ...config.http, port: 0 } }))).digest('hex');
    fingerprints.set(config, value);
  }
  return value;
}

export function equalSecret(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
