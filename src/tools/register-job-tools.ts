import { requestSignal } from '../diagnostics.js';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { diagnosticId, errorCategory, trace } from '../diagnostics.js';
import type { ConcurrencyController } from '../concurrency.js';
import * as z from 'zod/v4';
import type { ChatGptMcpConfig } from '../config.js';
import { isComputerAdapterError } from '../errors.js';
import { jobStore } from '../execution/job-store.js';

export function registerJobTools(server: Pick<McpServer, 'registerTool'>, config: Readonly<ChatGptMcpConfig>, concurrency: ConcurrencyController): void {
  if (!config.jobs.enabled || !config.shell.enabled) return;
  const store = jobStore(config);
  const invoke = async (operation: string, signal: AbortSignal, fn: () => Promise<unknown>): Promise<CallToolResult> => {
    const id = diagnosticId();
    trace('tool_received', { requestId: id, operation });
    try {
      const result = await concurrency.run(operation, fn, signal);
      trace('tool_completed', { requestId: id, operation });
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: result as Record<string, unknown> };
    } catch (error) {
      const body = isComputerAdapterError(error) ? error : { code: 'OS_ERROR', operation: 'exec.job', message: 'Job storage operation failed; inspect the operation identifier before submitting new work.' };
      trace('tool_failed', { requestId: id, operation, code: body.code });
      return { content: [{ type: 'text', text: JSON.stringify({ error: { ...body, category: errorCategory(body.code), diagnosticId: id, retryable: body.code === 'OVERLOADED' } }) }], isError: true };
    }
  };
  const jobId = z.string().regex(/^[a-f0-9]{64}$/);
  server.registerTool('exec.start', {
    title: 'Start Durable Command',
    description: 'Preferred for builds and other long commands. Completed stdout and stderr are stored and returned unchanged, subject to configured output and retention limits. Supply a unique operationId ONCE, retain the returned jobId, then use exec.status/output. Repeating the SAME operationId and arguments retrieves the existing job and never replays it within retention. An unknown outcome must be reconciled, not retried with a new ID. Survives tunnel reconnects; systemd workers also survive backend restarts. No implicit shell.',
    inputSchema: z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/), command: z.string().min(1), args: z.array(z.string()).default([]), cwd: z.string().min(1).optional(), env: z.record(z.string(), z.string()).optional(), timeoutMs: z.number().int().positive().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async ({ operationId, command, args, cwd, env, timeoutMs }, ctx) => invoke('exec.start', requestSignal(ctx.mcpReq.signal), () => store.start(operationId, {
    command, args, ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env }), ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })));
  server.registerTool('exec.status', {
    title: 'Durable Command Status', description: 'Retrieve a durable job without repeating its command. unknown means the outcome needs reconciliation, not that permissions changed.',
    inputSchema: z.object({ jobId }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ jobId }, ctx) => invoke('exec.status', requestSignal(ctx.mcpReq.signal), () => store.status(jobId)));
  server.registerTool('exec.output', {
    title: 'Durable Command Output', description: 'Retrieve bounded stdout or stderr after command completion. Stored output is returned unchanged. Use nextOffset to read the next UTF-16 character slice. Output survives tunnel reconnects until output retention expires.',
    inputSchema: z.object({ jobId, stream: z.enum(['stdout', 'stderr']).default('stdout'), offset: z.number().int().min(0).default(0), maxCharacters: z.number().int().min(1).max(65_536).default(16_384) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ jobId, stream, offset, maxCharacters }, ctx) => invoke('exec.output', requestSignal(ctx.mcpReq.signal), () => store.output(jobId, stream, offset, maxCharacters)));
  server.registerTool('exec.cancel', {
    title: 'Cancel Durable Command', description: 'Request cooperative cancellation of an existing job. Poll exec.status to confirm; cancellation cannot undo effects already performed.',
    inputSchema: z.object({ jobId }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ jobId }, ctx) => invoke('exec.cancel', requestSignal(ctx.mcpReq.signal), () => store.cancel(jobId)));
  server.registerTool('exec.list', {
    title: 'List Durable Commands', description: 'Recover job identifiers and states after a connection interruption. Does not expose command arguments or environment values.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(50) }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ limit }, ctx) => invoke('exec.list', requestSignal(ctx.mcpReq.signal), async () => ({ jobs: await store.list(limit) })));
}
