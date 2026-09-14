import { redactedTools } from './redacted-tools.js';
import { diagnosticId, errorCategory, runtimeIdentity, trace } from '../diagnostics.js';
import { registerJobTools } from './register-job-tools.js';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ComputerAdapter } from '../adapter/computer-adapter.js';
import type { ChatGptMcpConfig } from '../config.js';
import { ConcurrencyController, type AdmissionClass } from '../concurrency.js';
import { adapterError, isComputerAdapterError } from '../errors.js';
import { KeyManagerClient, KeyManagerClientError } from '../key-manager/client.js';

const pathInput = z.string().min(1);
const signalSchema = z.enum([
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT',
  'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV',
  'SIGSTKFLT', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG',
  'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ',
]);
const serviceActionSchema = z.enum(['start', 'stop', 'restart']);
const pointerButtonSchema = z.enum(['left', 'middle', 'right']);
const displaySchema = z.string().min(1).max(255).refine(value => !/[\0\r\n]/.test(value), {
  message: 'display must be a non-empty X11 DISPLAY value',
});
const MAX_TOOL_RESPONSE_BYTES = 6 * 1024 * 1024;

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
    // structuredContent is the canonical machine-readable result. Keep the text
    // part compact so large stdout/file results are not duplicated on the wire.
    content: [{ type: 'text', text: message ?? 'ok' }],
    structuredContent,
  };
}

function failure(error: unknown, operation: string): CallToolResult {
  const body = isComputerAdapterError(error)
    ? { code: error.code, message: error.message, operation: error.operation, ...(error.details ? { details: error.details } : {}) }
    : { code: 'OS_ERROR', message: 'Unexpected computer adapter failure.', operation };
  return { content: [{ type: 'text', text: JSON.stringify({ error: { ...body, category: errorCategory(body.code), diagnosticId: diagnosticId(), retryable: body.code === 'OVERLOADED' } }) }], isError: true };
}


function mapKeyManagerError(error: unknown, operation: string): unknown {
  if (!(error instanceof KeyManagerClientError)) return error;
  if (error.status === 404) return adapterError('NOT_FOUND', operation, error.message);
  if (error.status === 409) return adapterError('CONFLICT', operation, error.message);
  if (/timed out/i.test(error.message)) return adapterError('TIMEOUT', operation, error.message);
  return adapterError('OS_ERROR', operation, error.message);
}

function enforceTransportBudget(result: CallToolResult, operation: string): CallToolResult {
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes <= MAX_TOOL_RESPONSE_BYTES) return result;
  return failure(
    adapterError(
      'OUTPUT_LIMIT',
      operation,
      'Tool response exceeded the transport-safe byte limit.',
      { maximum: MAX_TOOL_RESPONSE_BYTES, actual: bytes },
    ),
    operation,
  );
}

async function run(
  operation: string,
  concurrency: ConcurrencyController,
  signal: AbortSignal,
  fn: () => Promise<Record<string, unknown>>,
  message?: (result: Record<string, unknown>) => string,
  admissionOverride?: AdmissionClass | (() => AdmissionClass),
): Promise<CallToolResult> {
  const id = diagnosticId();
  const started = performance.now();
  trace('tool_received', { requestId: id, operation });
  try {
    const admission = typeof admissionOverride === 'function' ? admissionOverride() : admissionOverride;
    const result = await concurrency.run(operation, async () => {
      trace('tool_started', { requestId: id, operation });
      return fn();
    }, signal, admission);
    trace('tool_completed', { requestId: id, operation, elapsedMs: Math.round(performance.now() - started) });
    return enforceTransportBudget(success(result, message?.(result)), operation);
  } catch (error) {
    trace('tool_failed', { requestId: id, operation, code: isComputerAdapterError(error) ? error.code : 'OS_ERROR', elapsedMs: Math.round(performance.now() - started) });
    return failure(error, operation);
  }
}

export function registerTools(
  server: McpServer,
  config: Readonly<ChatGptMcpConfig>,
  adapter: ComputerAdapter,
  concurrency: ConcurrencyController = new ConcurrencyController(config.concurrency),
): void {
  const tools = redactedTools(server, config);
  tools.registerTool(
    'system.info',
    {
      title: 'System Info',
      description: 'Inspect fresh runtime identity and granted capabilities. Only an explicit capability=false or a fresh policy denial establishes disabled access. Timeouts, 502, missing tools in a cached connector, upstream safety-check failures, and disconnects are not evidence of read-only access. OVERLOADED is capacity pressure. Never blindly replay a state-changing command after losing its response; retrieve its durable job instead.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        hostname: z.string(), platform: z.string(), architecture: z.string(), release: z.string(),
        uptimeSeconds: z.number(), cwd: z.string(),
        runtime: z.record(z.string(), z.unknown()),
        capabilities: z.object({
          filesystemRead: z.boolean(), filesystemWrite: z.boolean(), filesystemRoots: z.number().int(),
          shell: z.boolean(), processList: z.boolean(), processKill: z.boolean(), service: z.boolean(),
          application: z.boolean(), browser: z.boolean(), hostDisplayAccess: z.boolean(), screenCapture: z.boolean(), screenRecording: z.boolean(), input: z.boolean(), keyManager: z.boolean(),
        }),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (_args, ctx) => run('system.info', concurrency, ctx.mcpReq.signal, async () => ({
      ...(await adapter.systemInfo()),
      runtime: { ...runtimeIdentity(config), outputRedaction: { enabled: true, mode: 'output-only', placeholder: '[SECRET_REDACTED]' } },
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
        screenRecording: config.desktop.hostDisplayAccess && config.desktop.screenRecording && config.filesystem.write && config.filesystem.roots.length > 0,
        input: config.desktop.hostDisplayAccess && config.desktop.input,
        keyManager: config.keyManager.enabled,
      },
    })),
  );

  if (config.keyManager.enabled) {
    const tokenFile = config.keyManager.tokenFile;
    if (!tokenFile) throw new Error('keyManager.tokenFile is required when key manager is enabled');
    const client = new KeyManagerClient({ url: config.keyManager.url, tokenFile, timeoutMs: config.keyManager.timeoutMs });
    const kmgrRun = async (operation: string, signal: AbortSignal, fn: () => Promise<Record<string, unknown>>) =>
      run(operation, concurrency, signal, async () => {
        try { return await fn(); } catch (error) { throw mapKeyManagerError(error, operation); }
      });

    tools.registerTool(
      'kmgr.list',
      {
        title: 'List Named Keys',
        description: 'List only key names and non-secret metadata authorized for this connector. Values, paths, prefixes and fingerprints are never returned. Use kmgr tools instead of reading credential files.',
        inputSchema: z.object({ project: z.string().min(1).max(160).optional() }),
        outputSchema: z.object({ keys: z.array(z.object({ name: z.string(), project: z.string(), provider: z.string(), version: z.number().int().positive(), updatedAt: z.string() })) }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ project }, ctx) => kmgrRun('kmgr.list', ctx.mcpReq.signal, async () => client.list(project)),
    );

    tools.registerTool(
      'kmgr.profiles',
      {
        title: 'List Key Operations',
        description: 'List non-secret operation profiles available for a named key. Knowing a key name does not grant access.',
        inputSchema: z.object({ keyName: z.string().min(1).max(240) }),
        outputSchema: z.object({ profiles: z.array(z.object({ id: z.string(), label: z.string(), provider: z.string() })) }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ keyName }, ctx) => kmgrRun('kmgr.profiles', ctx.mcpReq.signal, async () => client.profiles(keyName)),
    );

    tools.registerTool(
      'kmgr.run',
      {
        title: 'Run Approved Key Operation',
        description: 'Submit one typed operation using a named key without receiving the credential. If owner approval is needed, returns a durable KMGR request id and Botmaster notification state. Reuse the same idempotencyKey when checking/retrying the same intent.',
        inputSchema: z.object({
          project: z.string().min(1).max(160),
          keyName: z.string().min(1).max(240),
          profileId: z.string().min(1).max(200),
          input: z.record(z.string(), z.unknown()),
          idempotencyKey: z.string().min(1).max(240),
        }),
        outputSchema: z.record(z.string(), z.unknown()),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async (args, ctx) => kmgrRun('kmgr.run', ctx.mcpReq.signal, async () => client.run(args)),
    );

    tools.registerTool(
      'kmgr.status',
      {
        title: 'Key Operation Status',
        description: 'Read a durable KMGR request or JOB result. This never approves, imports, reveals, rotates or deletes a key.',
        inputSchema: z.object({ id: z.string().min(1).max(128) }),
        outputSchema: z.record(z.string(), z.unknown()),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ id }, ctx) => kmgrRun('kmgr.status', ctx.mcpReq.signal, async () => client.status(id)),
    );
  }

  if (config.filesystem.read && config.filesystem.roots.length > 0) {
    tools.registerTool(
      'fs.list',
      {
        title: 'List Directory',
        description: 'Use this to inspect one directory inside the filesystem roots granted to this MCP server.',
        inputSchema: z.object({ path: pathInput }),
        outputSchema: z.object({ path: z.string(), entries: z.array(fileEntrySchema) }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ path }, ctx) => run('fs.list', concurrency, ctx.mcpReq.signal, async () => ({ path, entries: [...await adapter.listDirectory(path)] })),
    );

    tools.registerTool(
      'fs.read',
      {
        title: 'Read File',
        description: 'Read a UTF-8 file inside granted roots. Credential-file contents are returned as [SECRET_REDACTED], not denied. Use credential paths inside an authorized command instead of reading their values into chat.',
        inputSchema: z.object({ path: pathInput, maxBytes: z.number().int().positive().optional() }),
        outputSchema: z.object({ path: z.string(), content: z.string(), bytes: z.number().int().nonnegative() }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ path, maxBytes }, ctx) => run('fs.read', concurrency, ctx.mcpReq.signal, async () => {
        const content = await adapter.readFile(path, maxBytes);
        return { path, content, bytes: Buffer.byteLength(content, 'utf8') };
      }),
    );
  }

  if (config.filesystem.write && config.filesystem.roots.length > 0) {
    tools.registerTool(
      'fs.write',
      {
        title: 'Write File',
        description: 'Create, overwrite, or append UTF-8 text inside the granted roots with legacy write semantics. Prefer fs.replace for atomic conditional edits when available; never blindly repeat an append after losing its response.',
        inputSchema: z.object({
          path: pathInput,
          content: z.string(),
          mode: z.enum(['create', 'overwrite', 'append']).default('overwrite'),
        }),
        outputSchema: z.object({ path: z.string(), mode: z.enum(['create', 'overwrite', 'append']), bytes: z.number().int().nonnegative() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ path, content, mode }, ctx) => run('fs.write', concurrency, ctx.mcpReq.signal, async () => {
        await adapter.writeFile(path, content, mode);
        return { path, mode, bytes: Buffer.byteLength(content, 'utf8') };
      }),
    );

    tools.registerTool(
      'fs.mkdir',
      {
        title: 'Create Directory',
        description: 'Use this to create a directory inside the granted filesystem roots.',
        inputSchema: z.object({ path: pathInput, recursive: z.boolean().default(false) }),
        outputSchema: z.object({ path: z.string(), recursive: z.boolean() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ path, recursive }, ctx) => run('fs.mkdir', concurrency, ctx.mcpReq.signal, async () => {
        await adapter.makeDirectory(path, recursive);
        return { path, recursive };
      }),
    );

    tools.registerTool(
      'fs.move',
      {
        title: 'Move Path',
        description: 'Use this to move or rename an entry between locations inside the granted filesystem roots.',
        inputSchema: z.object({ source: pathInput, destination: pathInput }),
        outputSchema: z.object({ source: z.string(), destination: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ source, destination }, ctx) => run('fs.move', concurrency, ctx.mcpReq.signal, async () => {
        await adapter.movePath(source, destination);
        return { source, destination };
      }),
    );

    tools.registerTool(
      'fs.delete',
      {
        title: 'Delete Path',
        description: 'Use this to delete a file or directory inside the granted filesystem roots.',
        inputSchema: z.object({ path: pathInput, recursive: z.boolean().default(false) }),
        outputSchema: z.object({ path: z.string(), recursive: z.boolean() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ path, recursive }, ctx) => run('fs.delete', concurrency, ctx.mcpReq.signal, async () => {
        await adapter.deletePath(path, recursive);
        return { path, recursive };
      }),
    );
  }

  if (config.filesystem.read && config.filesystem.write && config.filesystem.roots.length > 0 && adapter.replaceFile !== undefined) {
    tools.registerTool('fs.replace', {
      title: 'Atomic Conditional File Replacement',
      description: 'Preferred for editing a regular file. Requires its current SHA-256 (or null for a new file). Stages and syncs content before atomic replacement. A changed hash returns CONFLICT without overwriting. Rejects symlinks and frozen directory entries. Serializes cooperating MCP replacements; not a kernel compare-and-swap against external writers.',
      inputSchema: z.object({ path: pathInput, content: z.string(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }),
      outputSchema: z.object({ path: z.string(), sha256: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ path, content, expectedSha256 }, ctx) => run('fs.replace', concurrency, ctx.mcpReq.signal, async () => ({ path, ...await adapter.replaceFile!(path, content, expectedSha256) })));
  }

  registerJobTools(tools, config, concurrency);

  if (config.shell.enabled) {
    tools.registerTool(
      'shell.exec',
      {
        title: 'Execute Command',
        description: 'Execute a short locally allowed command without an implicit shell. Commands may use authorized local credential files or environment variables internally; do not paste credential values into tool arguments or chat. Secret text in results is replaced with [SECRET_REDACTED] without blocking credential use. Prefer exec.start/status/output for long work when available. A lost response does not prove the command failed; inspect its effects before retrying. OVERLOADED means capacity pressure, not missing permissions.',
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
      async (args, ctx) => {
        const request = {
          command: args.command,
          args: args.args,
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(args.env === undefined ? {} : { env: args.env }),
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
          signal: ctx.mcpReq.signal,
        };
        return run(
          'shell.exec',
          concurrency,
          ctx.mcpReq.signal,
          async () => ({ ...await adapter.exec(request) }),
          undefined,
          () => adapter.classifyExec?.(request) ?? 'shell-local',
        );
      },
    );
  }

  if (config.process.list) {
    tools.registerTool(
      'process.list',
      {
        title: 'List Processes',
        description: 'Use this to inspect processes visible to the local computer adapter.',
        inputSchema: z.object({}),
        outputSchema: z.object({ processes: z.array(processSchema) }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (_args, ctx) => run('process.list', concurrency, ctx.mcpReq.signal, async () => ({ processes: [...await adapter.listProcesses()] })),
    );
  }

  if (config.process.kill) {
    tools.registerTool(
      'process.kill',
      {
        title: 'Kill Process',
        description: 'Use this to send a POSIX signal to a process ID when process termination is granted.',
        inputSchema: z.object({ pid: z.number().int().positive(), signal: signalSchema.default('SIGTERM') }),
        outputSchema: z.object({ pid: z.number().int().positive(), signal: signalSchema }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ pid, signal }, ctx) => run('process.kill', concurrency, ctx.mcpReq.signal, async () => {
        await adapter.killProcess(pid, signal as NodeJS.Signals);
        return { pid, signal };
      }),
    );
  }

  if (config.service.enabled) {
    tools.registerTool(
      'service.status',
      {
        title: 'Service Status',
        description: 'Use this to read the current state of one locally allowed operating-system service.',
        inputSchema: z.object({ name: z.string().min(1) }),
        outputSchema: z.object({ name: z.string(), activeState: z.string(), subState: z.string(), description: z.string() }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ name }, ctx) => run('service.status', concurrency, ctx.mcpReq.signal, async () => ({ ...await adapter.serviceStatus(name) })),
    );

    tools.registerTool(
      'service.control',
      {
        title: 'Control Service',
        description: 'Use this to start, stop, or restart one locally allowed operating-system service.',
        inputSchema: z.object({ name: z.string().min(1), action: serviceActionSchema }),
        outputSchema: z.object({ name: z.string(), action: serviceActionSchema }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ name, action }, ctx) => run('service.control', concurrency, ctx.mcpReq.signal, async () => {
        await adapter.serviceControl(name, action);
        return { name, action };
      }),
    );
  }

  if (config.application.enabled && config.desktop.hostDisplayAccess) {
    tools.registerTool(
      'app.launch',
      {
        title: 'Launch Application',
        description: 'Use this to launch one application by its configured name on the caller-selected X11 DISPLAY. Returns an explicit handle for later app.close.',
        inputSchema: z.object({ name: z.string().min(1), args: z.array(z.string()).default([]), display: displaySchema }),
        outputSchema: z.object({ handle: z.string().min(1), pid: z.number().int().positive(), display: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ name, args, display }, ctx) => run('app.launch', concurrency, ctx.mcpReq.signal, async () => ({ ...await adapter.launchApplication(name, args, display), display })),
    );

    tools.registerTool(
      'app.close',
      {
        title: 'Close Application',
        description: 'Use this to terminate an application previously launched through app.launch, using its explicit handle.',
        inputSchema: z.object({ handle: z.string().min(1) }),
        outputSchema: z.object({ handle: z.string().min(1) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ handle }, ctx) => run('app.close', concurrency, ctx.mcpReq.signal, async () => {
        await adapter.closeApplication(handle);
        return { handle };
      }),
    );
  }

  if (config.browser.enabled && config.desktop.hostDisplayAccess) {
    tools.registerTool(
      'browser.open',
      {
        title: 'Open Browser URL',
        description: 'Use this to open a URL with the configured local browser opener on the caller-selected X11 DISPLAY when its URL scheme is allowed.',
        inputSchema: z.object({ url: z.string().min(1), display: displaySchema }),
        outputSchema: z.object({ url: z.string(), display: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ url, display }, ctx) => run('browser.open', concurrency, ctx.mcpReq.signal, async () => {
        await adapter.openBrowser(url, display);
        return { url, display };
      }),
    );
  }

  if (config.desktop.hostDisplayAccess && config.desktop.screenCapture) {
    tools.registerTool(
      'screen.capture',
      {
        title: 'Capture Screen',
        description: 'Use this to capture the caller-selected X11 DISPLAY as a PNG image.',
        inputSchema: z.object({ display: displaySchema }),
        outputSchema: z.object({ mimeType: z.literal('image/png'), bytes: z.number().int().nonnegative(), display: z.string() }),
        annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ display }, ctx): Promise<CallToolResult> => {
        try {
          const capture = await concurrency.run('screen.capture', () => adapter.captureScreen(display), ctx.mcpReq.signal);
          return enforceTransportBudget({
            content: [
              { type: 'text', text: JSON.stringify({ mimeType: capture.mimeType, bytes: capture.bytes, display }) },
              { type: 'image', data: capture.data, mimeType: capture.mimeType },
            ],
            structuredContent: { mimeType: capture.mimeType, bytes: capture.bytes, display },
          }, 'screen.capture');
        } catch (error) {
          return failure(error, 'screen.capture');
        }
      },
    );
  }


  if (config.desktop.hostDisplayAccess && config.desktop.screenRecording && config.filesystem.write && config.filesystem.roots.length > 0) {
    tools.registerTool(
      'screen.record.start',
      {
        title: 'Start Screen Recording',
        description: 'Use this to start an asynchronous MP4 recording of the caller-selected X11 DISPLAY. Returns a handle immediately so other display/input tools can run while recording continues.',
        inputSchema: z.object({
          display: displaySchema,
          path: pathInput.refine(value => value.toLowerCase().endsWith('.mp4'), { message: 'path must end in .mp4' }),
          frameRate: z.number().int().min(1).max(60).default(30),
        }),
        outputSchema: z.object({
          handle: z.string().min(1), pid: z.number().int().positive(), path: z.string(), display: z.string(), startedAt: z.string(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ display, path, frameRate }, ctx) => run('screen.record.start', concurrency, ctx.mcpReq.signal, async () => ({
        ...await adapter.startScreenRecording(display, path, frameRate),
      })),
    );

    tools.registerTool(
      'screen.record.stop',
      {
        title: 'Stop Screen Recording',
        description: 'Use this to stop and finalize a screen recording previously started with screen.record.start.',
        inputSchema: z.object({ handle: z.string().min(1) }),
        outputSchema: z.object({
          handle: z.string().min(1), path: z.string(), display: z.string(), bytes: z.number().int().positive(), durationMs: z.number().nonnegative(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ handle }, ctx) => run('screen.record.stop', concurrency, ctx.mcpReq.signal, async () => ({
        ...await adapter.stopScreenRecording(handle),
      })),
    );
  }

  if (config.desktop.hostDisplayAccess && config.desktop.input) {
    tools.registerTool(
      'input.move',
      {
        title: 'Move Pointer',
        description: 'Use this to move the pointer on the caller-selected X11 DISPLAY to absolute screen coordinates.',
        inputSchema: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), display: displaySchema }),
        outputSchema: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), display: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ x, y, display }, ctx) => run('input.move', concurrency, ctx.mcpReq.signal, async () => {
        await adapter.movePointer(x, y, display);
        return { x, y, display };
      }),
    );

    tools.registerTool(
      'input.click',
      {
        title: 'Click Pointer',
        description: 'Use this to click the pointer on the caller-selected X11 DISPLAY, optionally moving to absolute coordinates first.',
        inputSchema: z.object({
          button: pointerButtonSchema.default('left'),
          display: displaySchema,
          x: z.number().int().nonnegative().optional(),
          y: z.number().int().nonnegative().optional(),
        }).refine(value => (value.x === undefined) === (value.y === undefined), { message: 'x and y must be supplied together' }),
        outputSchema: z.object({ button: pointerButtonSchema, display: z.string(), x: z.number().int().nonnegative().optional(), y: z.number().int().nonnegative().optional() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ button, display, x, y }, ctx) => run('input.click', concurrency, ctx.mcpReq.signal, async () => {
        await adapter.clickPointer(button, display, x, y);
        return { button, display, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) };
      }),
    );

    tools.registerTool(
      'input.type',
      {
        title: 'Type Text',
        description: 'Use this to type literal text into the focused application on the caller-selected X11 DISPLAY.',
        inputSchema: z.object({ text: z.string(), display: displaySchema, delayMs: z.number().int().min(0).max(10_000).default(0) }),
        outputSchema: z.object({ bytes: z.number().int().nonnegative(), delayMs: z.number().int().nonnegative(), display: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ text, display, delayMs }, ctx) => run('input.type', concurrency, ctx.mcpReq.signal, async () => {
        await adapter.typeText(text, display, delayMs);
        return { bytes: Buffer.byteLength(text, 'utf8'), delayMs, display };
      }),
    );

    tools.registerTool(
      'input.key',
      {
        title: 'Press Key',
        description: 'Use this to send one xdotool-compatible key sequence to the focused application on the caller-selected X11 DISPLAY.',
        inputSchema: z.object({ key: z.string().min(1).max(256), display: displaySchema }),
        outputSchema: z.object({ key: z.string(), display: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ key, display }, ctx) => run('input.key', concurrency, ctx.mcpReq.signal, async () => {
        await adapter.pressKey(key, display);
        return { key, display };
      }),
    );
  }
}
