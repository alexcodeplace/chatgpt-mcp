import { Server } from 'node:http';
import { installBridge, prepareBridge } from './bridge.js';
import { RouteError } from './wire.js';

const path = process.env.CHATGPT_MCP_BRIDGE_CONFIG;
if (!path) throw new RouteError('BRIDGE_STARTUP_CONFIGURATION_REQUIRED');
const prepared = await prepareBridge(path, true);
const original = Server.prototype.listen;
// Install before main imports the original backend. The listening event occurs
// before that listener can accept an HTTP request. A new process is ingress-only:
// it cannot impersonate the old incarnation or claim its in-memory resources.
Server.prototype.listen = function(this: Server, ...args: unknown[]) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address !== 'string' && address.port === prepared.settings.port) {
      try { installBridge(this, prepared); }
      catch {
        this.close();
        console.error(JSON.stringify({ event: 'bridge_startup_refused', pid: process.pid }));
        process.exitCode = 78;
      }
    }
  });
  return Reflect.apply(original, this, args) as Server;
} as Server['listen'];
