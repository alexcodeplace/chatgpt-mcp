import { isAbsolute } from 'node:path';
import * as z from 'zod/v4';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const absolutePath = z.string().min(1).refine(isAbsolute, 'Use an absolute path.');
const noNewlines = z.string().max(16_384).refine(value => !/[\r\n\0]/.test(value), 'Invalid header value.');
const credential = z.union([
  z.object({ env: envName, prefix: noNewlines.default('') }).strict(),
  z.object({ file: absolutePath, jsonField: z.string().min(1).max(128).optional(), prefix: noNewlines.default('') }).strict(),
]);
const headers = z.record(z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/).refine(name =>
  !/^(host|connection|content-length|transfer-encoding|cookie|mcp-.*)$/i.test(name), 'Reserved HTTP header.'),
  z.union([noNewlines, credential])).default({}).refine(value => {
    const names = Object.keys(value).map(name => name.toLowerCase());
    return new Set(names).size === names.length && names.length <= 32;
  }, 'Header names must be unique ignoring case (maximum 32).');
const common = {
  enabled: z.boolean().default(true),
  allowTools: z.array(z.string().min(1).max(128)).max(4096).optional(),
  connectTimeoutMs: z.number().int().min(50).max(120_000).default(10_000),
  callTimeoutMs: z.number().int().min(50).max(3_600_000).default(120_000),
  maxConcurrent: z.number().int().min(1).max(64).default(4),
  maxTools: z.number().int().min(1).max(4096).default(512),
};
const remote = {
  url: z.url().refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
  }, 'Use an HTTP(S) URL without embedded credentials or a fragment.'),
  headers,
  allowInsecureHttp: z.boolean().default(false),
};
const upstream = z.discriminatedUnion('transport', [
  z.object({ ...common, transport: z.literal('stdio'), command: z.string().min(1),
    args: z.array(z.string()).max(256).default([]), cwd: absolutePath.optional(),
    env: z.record(envName, z.string()).default({}), envFrom: z.array(envName).max(64).default([]),
  }).strict(),
  z.object({ ...common, ...remote, transport: z.literal('http') }).strict(),
  z.object({ ...common, ...remote, transport: z.literal('sse') }).strict(),
]).superRefine((value, ctx) => {
  if (value.transport === 'stdio') return;
  const url = new URL(value.url);
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !value.allowInsecureHttp) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'Non-loopback HTTP requires explicit allowInsecureHttp; prefer HTTPS.' });
  }
});
const reserved = new Set(['system', 'fs', 'shell', 'exec', 'process', 'service', 'app', 'browser', 'screen', 'input', 'kmgr', 'proxy', 'constructor', 'prototype', '__proto__']);
export const proxySchema = z.object({
  upstreams: z.unknown().superRefine((value, ctx) => {
    if (value && typeof value === 'object' && Object.keys(value).some(name => reserved.has(name))) {
      ctx.addIssue({ code: 'custom', message: 'Reserved upstream namespace.' });
    }
  }).pipe(z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).refine(name => !reserved.has(name), 'Reserved namespace.'), upstream)
    .default({}).refine(value => Object.keys(value).length <= 32, 'At most 32 upstreams.')).prefault({}),
  discoveryTtlMs: z.number().int().min(100).max(3_600_000).default(60_000),
  retryDelayMs: z.number().int().min(100).max(300_000).default(10_000),
  maxResultBytes: z.number().int().min(1024).max(6 * 1024 * 1024).default(6 * 1024 * 1024),
}).strict().prefault({});
export type ProxyConfig = z.infer<typeof proxySchema>;
export type UpstreamConfig = z.infer<typeof upstream>;
export type HeaderConfig = z.infer<typeof headers>;
