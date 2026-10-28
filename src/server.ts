import { McpProxy } from './proxy/manager.js';
import { registerProxyTools } from './proxy/register.js';
import { McpServer } from '@modelcontextprotocol/server';
import type { ComputerAdapter } from './adapter/computer-adapter.js';
import { RoutingComputerAdapter } from './adapter/routing-computer-adapter.js';
import type { ChatGptMcpConfig } from './config.js';
import { ConcurrencyController } from './concurrency.js';
import { registerTools } from './tools/register-tools.js';

export const serverInfo = {
  name: '@platform-modules/chatgpt-mcp',
  version: '0.2.0',
} as const;

export function createComputerMcpServer(
  config: Readonly<ChatGptMcpConfig>,
  adapter: ComputerAdapter = new RoutingComputerAdapter(config),
  concurrency: ConcurrencyController = new ConcurrencyController(config.concurrency, config.execution.kubernetes.maxConcurrent),
): McpServer {
  const server = new McpServer(serverInfo);
  registerTools(server, config, adapter, concurrency);
  return server;
}

/**
 * Downstream MCP instances remain stateless. The factory owns reusable upstream
 * connections and must be closed by its serving transport at shutdown.
 */
export function createComputerMcpServerFactory(
  config: Readonly<ChatGptMcpConfig>,
  adapter: ComputerAdapter = new RoutingComputerAdapter(config),
  concurrency: ConcurrencyController = new ConcurrencyController(config.concurrency, config.execution.kubernetes.maxConcurrent),
): (() => Promise<McpServer>) & { close(): Promise<void> } {
  const proxy = new McpProxy(config.proxy);
  const factory = async (): Promise<McpServer> => {
    const server = createComputerMcpServer(config, adapter, concurrency);
    if (proxy.configured) await registerProxyTools(server, proxy, concurrency);
    return server;
  };
  factory.close = () => proxy.close();
  return factory;
}
