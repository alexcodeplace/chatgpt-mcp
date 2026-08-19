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

const configSchema = z.object({
  http: z.object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(3210),
    token: z.string().min(1).optional(),
  }).default({}),
  filesystem: filesystemSchema.default({}),
  shell: shellSchema.default({}),
  process: processSchema.default({}),
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
});

export type ChatGptMcpConfig = z.infer<typeof configSchema>;

function normalize(config: ChatGptMcpConfig): ChatGptMcpConfig {
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      roots: config.filesystem.roots.map(root => resolve(root)),
    },
  };
}

export function parseConfig(value: unknown): Readonly<ChatGptMcpConfig> {
  return Object.freeze(normalize(configSchema.parse(value)));
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Readonly<ChatGptMcpConfig>> {
  const configPath = env.CHATGPT_MCP_CONFIG;
  const fileValue = configPath
    ? JSON.parse(await readFile(resolve(configPath), 'utf8')) as unknown
    : {};

  const base = configSchema.parse(fileValue);
  const merged = {
    ...base,
    http: {
      ...base.http,
      ...(env.CHATGPT_MCP_HOST ? { host: env.CHATGPT_MCP_HOST } : {}),
      ...(env.CHATGPT_MCP_PORT ? { port: Number(env.CHATGPT_MCP_PORT) } : {}),
      ...(env.CHATGPT_MCP_TOKEN ? { token: env.CHATGPT_MCP_TOKEN } : {}),
    },
    ...(env.CHATGPT_MCP_LOG_LEVEL ? { logLevel: env.CHATGPT_MCP_LOG_LEVEL } : {}),
  };

  return parseConfig(merged);
}
