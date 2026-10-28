import { type McpServer, type RegisteredTool } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type ConcurrencyController } from '../concurrency.js';
import { requestSignal } from '../diagnostics.js';
import { McpProxy, proxyFailure, type ProxyTool } from './manager.js';

export async function registerProxyTools(server: McpServer, proxy: McpProxy, concurrency: ConcurrencyController): Promise<void> {
  const registered = new Map<string, { handle: RegisteredTool; signature: string }>();
  function reconcile(tools: ProxyTool[]): void {
    const names = new Set(tools.map(tool => tool.name));
    for (const [name, entry] of registered) {
      if (!names.has(name)) { entry.handle.remove(); registered.delete(name); }
    }
    for (const tool of tools) {
      const signature = JSON.stringify(tool.original);
      if (registered.get(tool.name)?.signature === signature) continue;
      registered.get(tool.name)?.handle.remove();
      const original = tool.original;
      const handle = server.registerTool(tool.name, {
        description: `[${tool.upstream}] ${original.description ?? original.name}`,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        ...(original.title === undefined ? {} : { title: original.title }),
        ...(original.annotations === undefined ? {} : { annotations: original.annotations }),
        ...(original.icons === undefined ? {} : { icons: original.icons }),
        ...(original._meta === undefined ? {} : { _meta: original._meta }),
      }, async (args, ctx) => {
        const signal = requestSignal(ctx.mcpReq.signal);
        try {
          return await concurrency.run(tool.name, () => proxy.call(tool, args, signal), signal, 'normal');
        } catch {
          return proxyFailure(signal.aborted ? 'CANCELLED' : 'PROXY_BUSY', 'Proxy admission failed; no upstream call was sent.');
        }
      });
      registered.set(tool.name, { handle, signature });
    }
  }

  server.registerTool('proxy.status', {
    description: 'Show configured upstream MCP namespaces, connection state, tool counts and active calls. Never returns URLs, commands or credentials.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, () => ({ content: [{ type: 'text', text: JSON.stringify(proxy.status()) }], structuredContent: proxy.status() }));

  server.registerTool('proxy.refresh', {
    description: 'Refresh one configured upstream MCP namespace, or all upstreams. Rediscover tools afterward. This does not retry previous tool calls.',
    inputSchema: z.object({ upstream: z.string().min(1).max(32).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ upstream }, ctx) => {
    const signal = requestSignal(ctx.mcpReq.signal);
    try {
      await concurrency.run('proxy.refresh', async () => { reconcile(await proxy.tools(true, upstream)); }, signal, 'normal');
      return { content: [{ type: 'text', text: JSON.stringify(proxy.status()) }], structuredContent: proxy.status() };
    } catch {
      return proxyFailure('PROXY_REFRESH_FAILED', 'Refresh failed. Check the configured namespace and proxy.status.');
    }
  });

  reconcile(await proxy.tools());
}
