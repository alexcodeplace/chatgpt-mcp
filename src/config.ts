import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as z from 'zod/v4';

const filesystemSchema = z.object({
  read: z.boolean().default(false),
  write: z.boolean().default(false),
  roots: z.array(z.string().min(1)).default([]),
  maxReadBytes: z.number().int().positive().max(64 * 1024 * 1024).default(1024 * 1024),
  maxWriteBytes: z.number().int().positive().max(64 * 1024 * 1024).default(4 * 1024 * 1024),
});

const shellSchema = z.object({
  enabled: z.boolean().default(false),
  allowedCommands: z.array(z.string().min(1)).default([]),
  maxRuntimeMs: z.number().int().positive().max(60 * 60 * 1000).default(120_000),
  maxOutputBytes: z.number().int().positive().max(64 * 1024 * 1024).default(4 * 1024 * 1024),
  allowEnvironment: z.boolean().default(false),
});

const processSchema = z.object({
  list: z.boolean().default(false),
  kill: z.boolean().default(false),
});

const httpSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(3210),
  token: z.string().min(1).optional(),
  allowedHosts: z.array(z.string().min(1)).default([]),
  allowedOrigins: z.array(z.string().min(1)).default([]),
});

const configSchema = z.object({
  http: httpSchema.default({}),
  filesystem: filesystemSchema.default({}),
  shell: shellSchema.default({}),
  process: processSchema.default({}),
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
});

export type ChatGptMcpConfig = z.infer<typeof configSchema>;

function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map(part => part.trim()).filter(Boolean);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function normalize(config: ChatGptMcpConfig): ChatGptMcpConfig {
  return {
    ...config,
    http: {
      ...config.http,
      allowedHosts: config.http.allowedHosts.map(value => value.trim()),
      allowedOrigins: config.http.allowedOrigins.map(value => value.trim()),
    },
    filesystem: {
      ...config.filesystem,
      roots: config.filesystem.roots.map(root => resolve(root)),
    },
  };
}

export function parseConfig(value: unknown): Readonly<ChatGptMcpConfig> {
  return deepFreeze(normalize(configSchema.parse(value)));
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Readonly<ChatGptMcpConfig>> {
  const configPath = env.CHATGPT_MCP_CONFIG;
  const fileValue = configPath
    ? JSON.parse(await readFile(resolve(configPath), 'utf8')) as unknown
    : {};

  const base = configSchema.parse(fileValue);
  const allowedHosts = csv(env.CHATGPT_MCP_ALLOWED_HOSTS);
  const allowedOrigins = csv(env.CHATGPT_MCP_ALLOWED_ORIGINS);
  const merged = {
    ...base,
    http: {
      ...base.http,
      ...(env.CHATGPT_MCP_HOST ? { host: env.CHATGPT_MCP_HOST } : {}),
      ...(env.CHATGPT_MCP_PORT ? { port: Number(env.CHATGPT_MCP_PORT) } : {}),
      ...(env.CHATGPT_MCP_TOKEN ? { token: env.CHATGPT_MCP_TOKEN } : {}),
      ...(allowedHosts ? { allowedHosts } : {}),
      ...(allowedOrigins ? { allowedOrigins } : {}),
    },
    ...(env.CHATGPT_MCP_LOG_LEVEL ? { logLevel: env.CHATGPT_MCP_LOG_LEVEL } : {}),
  };

  return parseConfig(merged);
}
