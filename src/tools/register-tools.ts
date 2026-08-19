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
const serviceActionSchema = z.enum(['start', 'stop', 'restart']);
const pointerButtonSchema = z.enum(['left', 'middle', 'right']);

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

async function run(
  operation: string,
  fn: () => Promise<Record<string, unknown>>,
  message?: (result: Record<string, unknown>) => string,
): Promise<CallToolResult> {
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
      description: 'Use this to inspect the computer identity/runtime and see which local capability families are currently granted.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        hostname: z.string(), platform: z.string(), architecture: z.string(), release: z.string(),
        uptimeSeconds: z.number(), cwd: z.string(),
        capabilities: z.object({
          filesystemRead: z.boolean(), filesystemWrite: z.boolean(), filesystemRoots: z.number().int(),
          shell: z.boolean(), processList: z.boolean(), processKill: z.boolean(), service: z.boolean(),
          application: z.boolean(), browser: z.boolean(), hostDisplayAccess: z.boolean(), screenCapture: z.boolean(), input: z.boolean(),
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
        service: config.service.enabled,
        application: config.application.enabled && config.desktop.hostDisplayAccess,
        browser: config.browser.enabled && config.desktop.hostDisplayAccess,
        hostDisplayAccess: config.desktop.hostDisplayAccess,
        screenCapture: config.desktop.hostDisplayAccess && config.desktop.screenCapture,
        input: config.desktop.hostDisplayAccess && config.desktop.input,
      },
    })),
  );

  if (config.filesystem.read && config.filesystem.roots.length > 0) {
    server.registerTool(
      'fs.list',
      {
        title: 'List Directory',
        description: 'Use this to inspect one directory inside the filesystem roots granted to this MCP server.',
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
        description: 'Use this to read one UTF-8 text file inside the granted filesystem roots.',
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
        description: 'Use this to create, overwrite, or append UTF-8 text inside the granted filesystem roots.',
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
        description: 'Use this to create a directory inside the granted filesystem roots.',
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
        description: 'Use this to move or rename an entry between locations inside the granted filesystem roots.',
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
        description: 'Use this to delete a file or directory inside the granted filesystem roots.',
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
        description: 'Use this to execute one locally allowed executable with an argument array. It never inserts an implicit shell.',
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
        description: 'Use this to inspect processes visible to the local computer adapter.',
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
        description: 'Use this to send a POSIX signal to a process ID when process termination is granted.',
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

  if (config.service.enabled) {
    server.registerTool(
      'service.status',
      {
        title: 'Service Status',
        description: 'Use this to read the current state of one locally allowed operating-system service.',
        inputSchema: z.object({ name: z.string().min(1) }),
        outputSchema: z.object({ name: z.string(), activeState: z.string(), subState: z.string(), description: z.string() }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ name }) => run('service.status', async () => ({ ...await adapter.serviceStatus(name) })),
    );

    server.registerTool(
      'service.control',
      {
        title: 'Control Service',
        description: 'Use this to start, stop, or restart one locally allowed operating-system service.',
        inputSchema: z.object({ name: z.string().min(1), action: serviceActionSchema }),
        outputSchema: z.object({ name: z.string(), action: serviceActionSchema }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ name, action }) => run('service.control', async () => {
        await adapter.serviceControl(name, action);
        return { name, action };
      }),
    );
  }

  if (config.application.enabled && config.desktop.hostDisplayAccess) {
    server.registerTool(
      'app.launch',
      {
        title: 'Launch Application',
        description: 'Use this to launch one application by its configured name. Returns an explicit handle for later app.close.',
        inputSchema: z.object({ name: z.string().min(1), args: z.array(z.string()).default([]) }),
        outputSchema: z.object({ handle: z.string().min(1), pid: z.number().int().positive() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ name, args }) => run('app.launch', async () => ({ ...await adapter.launchApplication(name, args) })),
    );

    server.registerTool(
      'app.close',
      {
        title: 'Close Application',
        description: 'Use this to terminate an application previously launched through app.launch, using its explicit handle.',
        inputSchema: z.object({ handle: z.string().min(1) }),
        outputSchema: z.object({ handle: z.string().min(1) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ handle }) => run('app.close', async () => {
        await adapter.closeApplication(handle);
        return { handle };
      }),
    );
  }

  if (config.browser.enabled && config.desktop.hostDisplayAccess) {
    server.registerTool(
      'browser.open',
      {
        title: 'Open Browser URL',
        description: 'Use this to open a URL with the configured local browser opener when its URL scheme is allowed.',
        inputSchema: z.object({ url: z.string().min(1) }),
        outputSchema: z.object({ url: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ url }) => run('browser.open', async () => {
        await adapter.openBrowser(url);
        return { url };
      }),
    );
  }

  if (config.desktop.hostDisplayAccess && config.desktop.screenCapture) {
    server.registerTool(
      'screen.capture',
      {
        title: 'Capture Screen',
        description: 'Use this to capture the current desktop screen as a PNG image.',
        inputSchema: z.object({}),
        outputSchema: z.object({ mimeType: z.literal('image/png'), bytes: z.number().int().nonnegative() }),
        annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
      },
      async (): Promise<CallToolResult> => {
        try {
          const capture = await adapter.captureScreen();
          return {
            content: [
              { type: 'text', text: JSON.stringify({ mimeType: capture.mimeType, bytes: capture.bytes }) },
              { type: 'image', data: capture.data, mimeType: capture.mimeType },
            ],
            structuredContent: { mimeType: capture.mimeType, bytes: capture.bytes },
          };
        } catch (error) {
          return failure(error, 'screen.capture');
        }
      },
    );
  }

  if (config.desktop.hostDisplayAccess && config.desktop.input) {
    server.registerTool(
      'input.move',
      {
        title: 'Move Pointer',
        description: 'Use this to move the local desktop pointer to absolute screen coordinates.',
        inputSchema: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
        outputSchema: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ x, y }) => run('input.move', async () => {
        await adapter.movePointer(x, y);
        return { x, y };
      }),
    );

    server.registerTool(
      'input.click',
      {
        title: 'Click Pointer',
        description: 'Use this to click the local desktop pointer, optionally moving to absolute coordinates first.',
        inputSchema: z.object({
          button: pointerButtonSchema.default('left'),
          x: z.number().int().nonnegative().optional(),
          y: z.number().int().nonnegative().optional(),
        }).refine(value => (value.x === undefined) === (value.y === undefined), { message: 'x and y must be supplied together' }),
        outputSchema: z.object({ button: pointerButtonSchema, x: z.number().int().nonnegative().optional(), y: z.number().int().nonnegative().optional() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ button, x, y }) => run('input.click', async () => {
        await adapter.clickPointer(button, x, y);
        return { button, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) };
      }),
    );

    server.registerTool(
      'input.type',
      {
        title: 'Type Text',
        description: 'Use this to type literal text into the currently focused desktop application.',
        inputSchema: z.object({ text: z.string(), delayMs: z.number().int().min(0).max(10_000).default(0) }),
        outputSchema: z.object({ bytes: z.number().int().nonnegative(), delayMs: z.number().int().nonnegative() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ text, delayMs }) => run('input.type', async () => {
        await adapter.typeText(text, delayMs);
        return { bytes: Buffer.byteLength(text, 'utf8'), delayMs };
      }),
    );

    server.registerTool(
      'input.key',
      {
        title: 'Press Key',
        description: 'Use this to send one xdotool-compatible key sequence to the focused desktop application.',
        inputSchema: z.object({ key: z.string().min(1).max(256) }),
        outputSchema: z.object({ key: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ key }) => run('input.key', async () => {
        await adapter.pressKey(key);
        return { key };
      }),
    );
  }
}
