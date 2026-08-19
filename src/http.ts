import { loadConfig } from './config.js';
import { startComputerHttpServer } from './http-server.js';

const config = await loadConfig();
const running = await startComputerHttpServer(config);

if (config.logLevel !== 'silent') {
  console.error(`chatgpt-mcp listening at ${running.endpoint}`);
}

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  if (config.logLevel !== 'silent') console.error(`chatgpt-mcp shutting down (${signal})`);
  try {
    await running.close();
    process.exitCode = 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
