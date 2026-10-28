import { createHash } from 'node:crypto';
import { fromJsonSchema, type CallToolResult, type StandardSchemaWithJSON, type Tool, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { Client, Transport } from '@modelcontextprotocol/client';
import type { ProxyConfig, UpstreamConfig } from './config.js';
import { createUpstreamClient } from './transport.js';

export interface ProxyTool {
  name: string;
  upstream: string;
  original: Tool;
  inputSchema: StandardSchemaWithJSON<Record<string, unknown>>;
  outputSchema?: StandardSchemaWithJSON;
}
interface UpstreamState {
  name: string;
  config: UpstreamConfig;
  client?: Client;
  transport?: Transport;
  pending?: Promise<void>;
  tools: ProxyTool[];
  expiresAt: number;
  active: number;
  status: 'idle' | 'ready' | 'unavailable' | 'disabled' | 'closed';
  error?: string;
}

export function proxyFailure(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }] };
}

/** Stable, legal names, including when prefixing a maximum-length upstream name. */
export function exposedToolName(namespace: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) throw new Error('Invalid upstream tool name.');
  const full = `${namespace}.${name}`;
  if (full.length <= 128) return full;
  return `${full.slice(0, 111)}_${createHash('sha256').update(full).digest('hex').slice(0, 16)}`;
}

/** Includes transport.start(), which some transports do not bind to connect's signal. */
async function connectBounded(client: Client, transport: Transport, signal: AbortSignal, timeout: number): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    void client.connect(transport, { signal, timeout }).then(() => {
      signal.removeEventListener('abort', abort); resolve();
    }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

/** Runtime-owned upstream sessions, never owned by an individual HTTP request. */
export class McpProxy {
  private readonly upstreams: Map<string, UpstreamState>;
  private readonly lifetime = new AbortController();
  private closePromise?: Promise<void>;

  constructor(private readonly config: ProxyConfig) {
    this.upstreams = new Map(Object.entries(config.upstreams).map(([name, upstream]) => [name, {
      name, config: upstream, tools: [], expiresAt: 0, active: 0,
      status: upstream.enabled ? 'idle' : 'disabled',
    }]));
  }

  get configured(): boolean { return this.upstreams.size > 0; }

  status(): Record<string, unknown> {
    return { upstreams: [...this.upstreams.values()].map(state => ({
      name: state.name, transport: state.config.transport, status: state.status,
      toolCount: state.tools.length, activeCalls: state.active,
      ...(state.error === undefined ? {} : { error: state.error }),
    })) };
  }

  async tools(force = false, namespace?: string): Promise<ProxyTool[]> {
    if (namespace !== undefined && !this.upstreams.has(namespace)) throw new Error('Unknown upstream namespace.');
    await Promise.all([...this.upstreams.values()]
      .filter(state => namespace === undefined || state.name === namespace)
      .map(state => this.discover(state, force)));
    return [...this.upstreams.values()].flatMap(state => state.tools);
  }

  private discover(state: UpstreamState, force: boolean): Promise<void> {
    if (!state.config.enabled || this.lifetime.signal.aborted) return Promise.resolve();
    if (state.pending) return state.pending;
    if (!force && Date.now() < state.expiresAt) return Promise.resolve();
    const pending = this.discoverOnce(state).finally(() => { delete state.pending; });
    state.pending = pending;
    return pending;
  }

  private async discoverOnce(state: UpstreamState): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(state.config.connectTimeoutMs)]);
    try {
      if (!state.client) {
        await state.transport?.close();
        const { client, transport } = createUpstreamClient(state.config);
        state.client = client;
        state.transport = transport;
        client.onclose = () => {
          if (state.client === client) {
            delete state.client;
            state.expiresAt = 0;
            state.status = this.lifetime.signal.aborted ? 'closed' : 'unavailable';
          }
        };
        // Notifications invalidate, but never launch unsolicited network work.
        client.setNotificationHandler('notifications/tools/list_changed', () => { state.expiresAt = 0; });
        await connectBounded(client, transport, signal, state.config.connectTimeoutMs);
      }
      const client = state.client;
      if (!client) throw new Error('Upstream disconnected.');
      // Explicit per-page requests avoid the SDK cache hiding a refreshed catalogue.
      const tools: Tool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= 64) throw new Error('Discovery page limit exceeded.');
        const result = await client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
          { signal, timeout: state.config.connectTimeoutMs });
        tools.push(...result.tools);
        if (tools.length > state.config.maxTools || Buffer.byteLength(JSON.stringify(tools)) > this.config.maxResultBytes) {
          throw new Error('Discovery size limit exceeded.');
        }
        cursor = result.nextCursor;
        if (cursor === undefined) break;
        if (cursors.has(cursor)) throw new Error('Discovery cursor cycle.');
        cursors.add(cursor);
      }
      const names = new Set<string>();
      const exposed: ProxyTool[] = [];
      for (const tool of tools) {
        if (state.config.allowTools !== undefined && !state.config.allowTools.includes(tool.name)) continue;
        // Tasks, sampling, elicitation and resource routing are not advertised by this tool proxy.
        if (tool.execution?.taskSupport === 'required') continue;
        const name = exposedToolName(state.name, tool.name);
        if (names.has(name)) throw new Error('Duplicate upstream tool name.');
        names.add(name);
        exposed.push({
          name, upstream: state.name, original: tool,
          inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType),
          ...(tool.outputSchema === undefined ? {} : { outputSchema: fromJsonSchema(tool.outputSchema as JsonSchemaType) }),
        });
      }
      signal.throwIfAborted();
      state.tools = exposed;
      state.status = 'ready';
      delete state.error;
      state.expiresAt = Date.now() + this.config.discoveryTtlMs;
    } catch {
      // Exceptions from SDKs and HTTP auth frequently contain URLs or tokens.
      // Keep only a stable category; never serialize their messages or causes.
      const client = state.client;
      delete state.client;
      if (client) await client.close().catch(() => undefined);
      await state.transport?.close().catch(() => undefined);
      delete state.transport;
      state.status = this.lifetime.signal.aborted ? 'closed' : 'unavailable';
      state.error = 'UPSTREAM_DISCOVERY_FAILED';
      state.expiresAt = Date.now() + this.config.retryDelayMs;
      // Retain the last-good catalogue, so callers get an explicit unavailable error.
    }
  }

  async call(tool: ProxyTool, args: Record<string, unknown>, callerSignal: AbortSignal): Promise<CallToolResult> {
    if (callerSignal.aborted || this.lifetime.signal.aborted) return proxyFailure('CANCELLED', 'Proxy call cancelled before execution.');
    const state = this.upstreams.get(tool.upstream);
    if (!state?.config.enabled) return proxyFailure('UPSTREAM_UNAVAILABLE', 'The upstream is not enabled.');
    await this.discover(state, false);
    if (callerSignal.aborted || this.lifetime.signal.aborted) return proxyFailure('CANCELLED', 'Proxy call cancelled before execution.');
    if (!state.tools.some(current => current.name === tool.name)) return proxyFailure('UNKNOWN_UPSTREAM_TOOL', 'Refresh the tool catalogue before calling this tool.');
    const client = state.client;
    if (!client || state.status !== 'ready') return proxyFailure('UPSTREAM_UNAVAILABLE', 'The configured upstream is unavailable. Use proxy.status and proxy.refresh.');
    if (state.active >= state.config.maxConcurrent) return proxyFailure('UPSTREAM_BUSY', 'The upstream concurrency limit is reached; no call was sent.');
    const deadline = AbortSignal.timeout(state.config.callTimeoutMs);
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal, deadline]);
    state.active += 1;
    try {
      const result = await client.callTool({ name: tool.original.name, arguments: args }, {
        signal, timeout: state.config.callTimeoutMs, resetTimeoutOnProgress: false,
      });
      if (Buffer.byteLength(JSON.stringify(result)) > this.config.maxResultBytes) {
        return proxyFailure('UPSTREAM_OUTPUT_LIMIT', 'The upstream result exceeded the configured byte limit. The call ran and was not retried.');
      }
      return result;
    } catch {
      const code = callerSignal.aborted || this.lifetime.signal.aborted ? 'CANCELLED'
        : deadline.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_CALL_FAILED';
      return proxyFailure(code, 'The upstream call did not complete successfully. It may have executed; it was not retried.');
    } finally { state.active -= 1; }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.upstreams.values()].map(async state => {
      await state.client?.close();
      await state.transport?.close();
      await state.pending;
      state.status = 'closed';
    }));
  }
}
