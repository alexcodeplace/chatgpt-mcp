import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ComputerAdapter } from '../adapter/computer-adapter.js';
import type { ChatGptMcpConfig } from '../config.js';
import { isComputerAdapterError } from '../errors.js';

const pathInput = z.string().min(1);
const signalSchema = z.enum([
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT',
  'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV',
  'SIGSTKFLT', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG',
  'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ',
]);

const fileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.number().optional(),
  modifiedAt: z.string().optional(),
});

const processSchema = z.object({
  pid: z.number().int(),
  parentPid: z.number().int().optional(),
  user: z.string().optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
});

function success(structuredContent: Record<string, unknown>, message?: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message ?? JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failure(error: unknown, operation: string): CallToolResult {
  const body = isComputerAdapterError(error)
    ? { code: error.code, message: error.message, operation: error.operation, ...(error.details ? { details: error.details } : {}) }
    : { code: 'OS_ERROR', message: 'Unexpected computer adapter failure.', operation };
  return { content: [{ type: 'text', text: JSON.stringify({ error: body }) }], isError: true };
}

async function run(operation: string, fn: () => Promise<Record<string, unknown>>, message?: (result: Record<string, unknown>) => string): Promise<CallToolResult> {
  try {
    const result = await fn();
    return success(result, message?.(result));
  } catch (error) {
    return failure(error, operation);
  }
}

export function registerTools(
  server: McpServer,
  config: Readonly<ChatGptMcpConfig>,
  adapter: ComputerAdapter,
): void {
  server.registerTool(
    'system.info',
    {
      title: 'System Info',
      description: 'Read basic information about the computer and the capabilities granted to this MCP server.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        hostname: z.string(), platform: z.string(), architecture: z.string(), release: z.string(),
        uptimeSeconds: z.number(), cwd: z.string(),
        capabilities: z.object({
          filesystemRead: z.boolean(), filesystemWrite: z.boolean(), filesystemRoots: z.number().int(),
          shell: z.boolean(), processList: z.boolean(), processKill: z.boolean(),
        }),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => run('system.info', async () => ({
      ...(await adapter.systemInfo()),
      capabilities: {
        filesystemRead: config.filesystem.read,
        filesystemWrite: config.filesystem.write,
        filesystemRoots: config.filesystem.roots.length,
        shell: config.shell.enabled,
        processList: config.process.list,
        processKill: config.process.kill,
      },
    })),
  );

  if (config.filesystem.read && config.filesystem.roots.length > 0) {
    server.registerTool(
      'fs.list',
      {
        title: 'List Directory',
        description: 'List one directory inside the configured filesystem roots.',
        inputSchema: z.object({ path: pathInput }),
        outputSchema: z.object({ path: z.string(), entries: z.array(fileEntrySchema) }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ path }) => run('fs.list', async () => ({ path, entries: [...await adapter.listDirectory(path)] })),
    );

    server.registerTool(
      'fs.read',
      {
        title: 'Read File',
        description: 'Read one UTF-8 text file inside the configured filesystem roots.',
        inputSchema: z.object({ path: pathInput, maxBytes: z.number().int().positive().optional() }),
        outputSchema: z.object({ path: z.string(), content: z.string(), bytes: z.number().int().nonnegative() }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ path, maxBytes }) => run('fs.read', async () => {
        const content = await adapter.readFile(path, maxBytes);
        return { path, content, bytes: Buffer.byteLength(content, 'utf8') };
      }),
    );
  }

  if (config.filesystem.write && config.filesystem.roots.length > 0) {
    server.registerTool(
      'fs.write',
      {
        title: 'Write File',
        description: 'Create, overwrite, or append UTF-8 text inside the configured filesystem roots.',
        inputSchema: z.object({
          path: pathInput,
          content: z.string(),
          mode: z.enum(['create', 'overwrite', 'append']).default('overwrite'),
        }),
        outputSchema: z.object({ path: z.string(), mode: z.enum(['create', 'overwrite', 'append']), bytes: z.number().int().nonnegative() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ path, content, mode }) => run('fs.write', async () => {
        await adapter.writeFile(path, content, mode);
        return { path, mode, bytes: Buffer.byteLength(content, 'utf8') };
      }),
    );

    server.registerTool(
      'fs.mkdir',
      {
        title: 'Create Directory',
        description: 'Create a directory inside the configured filesystem roots.',
        inputSchema: z.object({ path: pathInput, recursive: z.boolean().default(false) }),
        outputSchema: z.object({ path: z.string(), recursive: z.boolean() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ path, recursive }) => run('fs.mkdir', async () => {
        await adapter.makeDirectory(path, recursive);
        return { path, recursive };
      }),
    );

    server.registerTool(
      'fs.move',
      {
        title: 'Move Path',
        description: 'Move or rename a filesystem entry between locations inside the configured filesystem roots.',
        inputSchema: z.object({ source: pathInput, destination: pathInput }),
        outputSchema: z.object({ source: z.string(), destination: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ source, destination }) => run('fs.move', async () => {
        await adapter.movePath(source, destination);
        return { source, destination };
      }),
    );

    server.registerTool(
      'fs.delete',
      {
        title: 'Delete Path',
        description: 'Delete a filesystem entry inside the configured filesystem roots.',
        inputSchema: z.object({ path: pathInput, recursive: z.boolean().default(false) }),
        outputSchema: z.object({ path: z.string(), recursive: z.boolean() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ path, recursive }) => run('fs.delete', async () => {
        await adapter.deletePath(path, recursive);
        return { path, recursive };
      }),
    );
  }

  if (config.shell.enabled) {
    server.registerTool(
      'shell.exec',
      {
        title: 'Execute Command',
        description: 'Execute one configured local executable directly with an argument array (no implicit shell).',
        inputSchema: z.object({
          command: z.string().min(1),
          args: z.array(z.string()).default([]),
          cwd: z.string().min(1).optional(),
          env: z.record(z.string(), z.string()).optional(),
          timeoutMs: z.number().int().positive().optional(),
        }),
        outputSchema: z.object({
          exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string(), durationMs: z.number().nonnegative(), timedOut: z.boolean(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async args => run('shell.exec', async () => ({ ...await adapter.exec({
        command: args.command,
        args: args.args,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.env === undefined ? {} : { env: args.env }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      }) })),
    );
  }

  if (config.process.list) {
    server.registerTool(
      'process.list',
      {
        title: 'List Processes',
        description: 'List processes visible to the local computer adapter.',
        inputSchema: z.object({}),
        outputSchema: z.object({ processes: z.array(processSchema) }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async () => run('process.list', async () => ({ processes: [...await adapter.listProcesses()] })),
    );
  }

  if (config.process.kill) {
    server.registerTool(
      'process.kill',
      {
        title: 'Kill Process',
        description: 'Send a configured POSIX signal to one process ID.',
        inputSchema: z.object({ pid: z.number().int().positive(), signal: signalSchema.default('SIGTERM') }),
        outputSchema: z.object({ pid: z.number().int().positive(), signal: signalSchema }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ pid, signal }) => run('process.kill', async () => {
        await adapter.killProcess(pid, signal as NodeJS.Signals);
        return { pid, signal };
      }),
    );
  }
}
