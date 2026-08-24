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
  hostDisplayAccess: z.boolean().default(false),
  screenCapture: z.boolean().default(false),
  input: z.boolean().default(false),
  screenBackend: z.enum(['auto', 'grim', 'gnome-screenshot', 'scrot', 'imagemagick-import']).default('auto'),
  inputBackend: z.literal('xdotool').default('xdotool'),
  maxImageBytes: z.number().int().positive().max(64 * 1024 * 1024).default(10 * 1024 * 1024),
  maxTextBytes: z.number().int().positive().max(1024 * 1024).default(64 * 1024),
});



const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const kubernetesClientSchema = z.object({
  command: z.string().min(1).default('kubectl'),
  args: z.array(z.string()).default([]),
  kubeconfig: z.string().min(1).optional(),
  context: z.string().min(1).optional(),
});

const kubernetesPreparePathSchema = z.string().min(1).refine(value => {
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  return !value.split(/[\\/]+/).some(part => part === '..');
}, 'prepare predicate paths must stay inside the workspace');

const kubernetesPrepareCommandSchema = z.object({
  command: z.string().regex(/^[A-Za-z0-9_.+-]+$/),
  args: z.array(z.string()).max(256).default([]),
  whenFiles: z.array(kubernetesPreparePathSchema).max(32).default([]),
  timeoutMs: z.number().int().positive().max(30 * 60 * 1000).default(300_000),
});

const kubernetesWorkspaceSchema = z.object({
  mode: z.literal('snapshot').default('snapshot'),
  containerPath: z.string().min(1).default('/workspace'),
  exclude: z.array(z.string()).default([]),
  prepareCommands: z.array(kubernetesPrepareCommandSchema).max(16).default([]),
  maxArchiveBytes: z.number().int().positive().max(16 * 1024 * 1024 * 1024).default(2 * 1024 * 1024 * 1024),
});

const kubernetesResourcesSchema = z.object({
  requests: z.record(z.string().min(1), z.string().min(1)).default({}),
  limits: z.record(z.string().min(1), z.string().min(1)).default({}),
});

const kubernetesSchema = z.object({
  enabled: z.boolean().default(false),
  client: kubernetesClientSchema.default({ command: 'kubectl', args: [] }),
  namespace: z.string().min(1).default('default'),
  image: z.string().min(1).optional(),
  imagePullPolicy: z.enum(['Always', 'IfNotPresent', 'Never']).default('IfNotPresent'),
  idleCommand: z.array(z.string().min(1)).min(1).max(64).default(['sleep', 'infinity']),
  imagePullSecrets: z.array(z.string().min(1)).default([]),
  serviceAccount: z.string().min(1).optional(),
  remoteCommands: z.array(z.string().min(1)).default([]),
  localOnlyCommands: z.array(z.string().min(1)).default([]),
  heavyCommandPatterns: z.array(z.string().min(1)).default([]),
  maxConcurrent: z.number().int().positive().max(1024).default(24),
  startupTimeoutMs: z.number().int().positive().max(10 * 60 * 1000).default(60_000),
  cleanupTimeoutMs: z.number().int().positive().max(5 * 60 * 1000).default(15_000),
  workspace: kubernetesWorkspaceSchema.default({ mode: 'snapshot', containerPath: '/workspace', exclude: [], prepareCommands: [], maxArchiveBytes: 2 * 1024 * 1024 * 1024 }),
  resources: kubernetesResourcesSchema.default({ requests: {}, limits: {} }),
  nodeSelector: z.record(z.string().min(1), z.string()).default({}),
  tolerations: z.array(z.record(z.string(), z.unknown())).default([]),
  podLabels: z.record(z.string().min(1), z.string()).default({}),
  podAnnotations: z.record(z.string().min(1), z.string()).default({}),
  volumes: z.array(z.record(z.string(), z.unknown())).default([]),
  volumeMounts: z.array(z.record(z.string(), z.unknown())).default([]),
  ttlSeconds: z.number().int().positive().max(7 * 24 * 60 * 60).default(300),
  requiredCommands: z.array(z.string().min(1)).default([]),
  requiredEnvironment: z.record(z.string().regex(ENVIRONMENT_NAME), z.string()).default({}),
  versionChecks: z.record(z.string().min(1), z.object({ args: z.array(z.string()).default(['--version']), pattern: z.string().min(1) })).default({}),
}).superRefine((value, ctx) => {
  if (value.enabled && value.image === undefined) {
    ctx.addIssue({ code: 'custom', path: ['image'], message: 'image is required when Kubernetes execution is enabled' });
  }
  for (const [index, pattern] of value.heavyCommandPatterns.entries()) {
    try { new RegExp(pattern); } catch {
      ctx.addIssue({ code: 'custom', path: ['heavyCommandPatterns', index], message: 'pattern must be a valid regular expression' });
    }
  }
  for (const [command, check] of Object.entries(value.versionChecks)) {
    try { new RegExp(check.pattern); } catch {
      ctx.addIssue({ code: 'custom', path: ['versionChecks', command, 'pattern'], message: 'version check pattern must be a valid regular expression' });
    }
  }
  if (value.volumes.some(volume => volume['name'] === 'chatgpt-mcp-workspace')) {
    ctx.addIssue({ code: 'custom', path: ['volumes'], message: 'volume name chatgpt-mcp-workspace is reserved for the isolated executor workspace' });
  }
  if (value.volumeMounts.some(mount => mount['mountPath'] === value.workspace.containerPath)) {
    ctx.addIssue({ code: 'custom', path: ['volumeMounts'], message: 'the configured workspace path is reserved for the isolated executor workspace' });
  }
});

const executionSchema = z.object({
  defaultBackend: z.literal('local').default('local'),
  lightweightTimeoutMs: z.number().int().positive().max(10 * 60 * 1000).default(30_000),
  lightweightOutputBytes: z.number().int().positive().max(16 * 1024 * 1024).default(1024 * 1024),
  kubernetes: kubernetesSchema.default({
    enabled: false, client: { command: 'kubectl', args: [] }, namespace: 'default', imagePullPolicy: 'IfNotPresent', idleCommand: ['sleep', 'infinity'], imagePullSecrets: [],
    remoteCommands: [], localOnlyCommands: [], heavyCommandPatterns: [], maxConcurrent: 24,
    startupTimeoutMs: 60_000, cleanupTimeoutMs: 15_000,
    workspace: { mode: 'snapshot', containerPath: '/workspace', exclude: [], prepareCommands: [], maxArchiveBytes: 2 * 1024 * 1024 * 1024 },
    resources: { requests: {}, limits: {} }, nodeSelector: {}, tolerations: [], podLabels: {}, podAnnotations: {}, volumes: [], volumeMounts: [],
    ttlSeconds: 300, requiredCommands: [], requiredEnvironment: {}, versionChecks: {},
  }),
});

const concurrencySchema = z.object({
  maxConcurrent: z.number().int().min(2).max(1024).default(48),
  reservedControlSlots: z.number().int().min(0).max(1023).default(8),
  shellMaxConcurrent: z.number().int().positive().max(1024).default(8),
  maxQueue: z.number().int().positive().max(4096).default(64),
  queueTimeoutMs: z.number().int().positive().max(10 * 60 * 1000).default(30_000),
}).superRefine((value, ctx) => {
  if (value.reservedControlSlots >= value.maxConcurrent) {
    ctx.addIssue({ code: 'custom', path: ['reservedControlSlots'], message: 'reservedControlSlots must be less than maxConcurrent' });
  }
  if (value.shellMaxConcurrent > value.maxConcurrent - value.reservedControlSlots) {
    ctx.addIssue({ code: 'custom', path: ['shellMaxConcurrent'], message: 'shellMaxConcurrent must fit inside non-control concurrency capacity' });
  }
});

const httpSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(3210),
  token: z.string().min(1).optional(),
  allowedHosts: z.array(z.string().min(1)).default([]),
  allowedOrigins: z.array(z.string().min(1)).default([]),
});

const configSchema = z.object({
  execution: executionSchema.default({ defaultBackend: 'local', lightweightTimeoutMs: 30_000, lightweightOutputBytes: 1024 * 1024, kubernetes: { enabled: false, client: { command: 'kubectl', args: [] }, namespace: 'default', imagePullPolicy: 'IfNotPresent', idleCommand: ['sleep', 'infinity'], imagePullSecrets: [], remoteCommands: [], localOnlyCommands: [], heavyCommandPatterns: [], maxConcurrent: 24, startupTimeoutMs: 60_000, cleanupTimeoutMs: 15_000, workspace: { mode: 'snapshot', containerPath: '/workspace', exclude: [], prepareCommands: [], maxArchiveBytes: 2 * 1024 * 1024 * 1024 }, resources: { requests: {}, limits: {} }, nodeSelector: {}, tolerations: [], podLabels: {}, podAnnotations: {}, volumes: [], volumeMounts: [], ttlSeconds: 300, requiredCommands: [], requiredEnvironment: {}, versionChecks: {} } }),
  concurrency: concurrencySchema.default({ maxConcurrent: 48, reservedControlSlots: 8, shellMaxConcurrent: 8, maxQueue: 64, queueTimeoutMs: 30_000 }),
  http: httpSchema.default({ host: '127.0.0.1', port: 3210, allowedHosts: [], allowedOrigins: [] }),
  filesystem: filesystemSchema.default({ read: false, write: false, roots: [], maxReadBytes: 1024 * 1024, maxWriteBytes: 4 * 1024 * 1024 }),
  shell: shellSchema.default({ enabled: false, allowedCommands: [], maxRuntimeMs: 120_000, maxOutputBytes: 4 * 1024 * 1024, allowEnvironment: false }),
  process: processSchema.default({ list: false, kill: false }),
  service: serviceSchema.default({ enabled: false, allowedServices: [], command: 'systemctl', maxRuntimeMs: 30_000 }),
  application: applicationSchema.default({ enabled: false, applications: {}, maxTracked: 64 }),
  browser: browserSchema.default({ enabled: false, command: 'xdg-open', allowedSchemes: ['http', 'https'], maxRuntimeMs: 30_000 }),
  desktop: desktopSchema.default({
    hostDisplayAccess: false,
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
