import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createComputerMcpServerFactory } from './server.js';

const config = await loadConfig();
const handle = serveStdio(createComputerMcpServerFactory(config));

if (config.logLevel !== 'silent') {
  console.error('chatgpt-mcp listening on stdio');
}

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  if (config.logLevel !== 'silent') console.error(`chatgpt-mcp shutting down (${signal})`);
  try {
    await handle.close();
    process.exitCode = 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
