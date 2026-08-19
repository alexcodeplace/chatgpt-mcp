import { McpServer } from '@modelcontextprotocol/server';
import type { ComputerAdapter } from './adapter/computer-adapter.js';
import { LocalComputerAdapter } from './adapter/local-computer-adapter.js';
import type { ChatGptMcpConfig } from './config.js';
import { registerTools } from './tools/register-tools.js';

export const serverInfo = {
  name: '@platform-modules/chatgpt-mcp',
  version: '0.1.0',
} as const;

export function createComputerMcpServer(
  config: Readonly<ChatGptMcpConfig>,
  adapter: ComputerAdapter = new LocalComputerAdapter(config),
): McpServer {
  const server = new McpServer(serverInfo);
  registerTools(server, config, adapter);
  return server;
}

/**
 * Returns the cheap, stateless factory consumed by both MCP transports.
 * The adapter may be shared because the milestone-1 adapter keeps no client/session state.
 */
export function createComputerMcpServerFactory(
  config: Readonly<ChatGptMcpConfig>,
  adapter: ComputerAdapter = new LocalComputerAdapter(config),
): () => McpServer {
  return () => createComputerMcpServer(config, adapter);
}
