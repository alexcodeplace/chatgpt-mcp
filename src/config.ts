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

const serviceSchema = z.object({
  enabled: z.boolean().default(false),
  allowedServices: z.array(z.string().min(1)).default([]),
  command: z.string().min(1).default('systemctl'),
  maxRuntimeMs: z.number().int().positive().max(10 * 60 * 1000).default(30_000),
});

const applicationDefinitionSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  allowArguments: z.boolean().default(false),
});

const applicationSchema = z.object({
  enabled: z.boolean().default(false),
  applications: z.record(z.string().min(1), applicationDefinitionSchema).default({}),
  maxTracked: z.number().int().positive().max(1024).default(64),
});

const browserSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string().min(1).default('xdg-open'),
  allowedSchemes: z.array(z.string().regex(/^[a-z][a-z0-9+.-]*$/i)).default(['http', 'https']),
  maxRuntimeMs: z.number().int().positive().max(5 * 60 * 1000).default(30_000),
});

const desktopSchema = z.object({
  screenCapture: z.boolean().default(false),
  input: z.boolean().default(false),
  screenBackend: z.enum(['auto', 'grim', 'gnome-screenshot', 'scrot', 'imagemagick-import']).default('auto'),
  inputBackend: z.literal('xdotool').default('xdotool'),
  maxImageBytes: z.number().int().positive().max(64 * 1024 * 1024).default(10 * 1024 * 1024),
  maxTextBytes: z.number().int().positive().max(1024 * 1024).default(64 * 1024),
});

const httpSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(3210),
  token: z.string().min(1).optional(),
  allowedHosts: z.array(z.string().min(1)).default([]),
  allowedOrigins: z.array(z.string().min(1)).default([]),
});

const configSchema = z.object({
  http: httpSchema.default({ host: '127.0.0.1', port: 3210, allowedHosts: [], allowedOrigins: [] }),
  filesystem: filesystemSchema.default({ read: false, write: false, roots: [], maxReadBytes: 1024 * 1024, maxWriteBytes: 4 * 1024 * 1024 }),
  shell: shellSchema.default({ enabled: false, allowedCommands: [], maxRuntimeMs: 120_000, maxOutputBytes: 4 * 1024 * 1024, allowEnvironment: false }),
  process: processSchema.default({ list: false, kill: false }),
  service: serviceSchema.default({ enabled: false, allowedServices: [], command: 'systemctl', maxRuntimeMs: 30_000 }),
  application: applicationSchema.default({ enabled: false, applications: {}, maxTracked: 64 }),
  browser: browserSchema.default({ enabled: false, command: 'xdg-open', allowedSchemes: ['http', 'https'], maxRuntimeMs: 30_000 }),
  desktop: desktopSchema.default({
    screenCapture: false,
    input: false,
    screenBackend: 'auto',
    inputBackend: 'xdotool',
    maxImageBytes: 10 * 1024 * 1024,
    maxTextBytes: 64 * 1024,
  }),
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
    browser: {
      ...config.browser,
      allowedSchemes: config.browser.allowedSchemes.map(value => value.toLowerCase()),
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
