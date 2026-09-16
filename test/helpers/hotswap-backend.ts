import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { parseConfig } from '../../src/config.js';
import { createComputerHttpServer } from '../../src/http-server.js';
import { RoutingComputerAdapter } from '../../src/adapter/routing-computer-adapter.js';
import { runtimeIdentity } from '../../src/diagnostics.js';
import type { ApplicationLaunchResult } from '../../src/adapter/computer-adapter.js';

const configPath = process.argv[2];
if (!configPath) throw new Error('fixture configuration is required');
const config = parseConfig(JSON.parse(await readFile(configPath, 'utf8')));
class FixtureAdapter extends RoutingComputerAdapter {
  readonly fixtureHandles = new Set<string>();
  override async launchApplication(name: string, args: readonly string[], display: string): Promise<ApplicationLaunchResult> {
    const result = await super.launchApplication(name, args, display);
    this.fixtureHandles.add(result.handle);
    return result;
  }
  async cleanup(): Promise<void> {
    for (const handle of this.fixtureHandles) await this.closeApplication(handle).catch(() => {});
  }
}
const adapter = new FixtureAdapter(config);
const { server, closeHandler } = createComputerHttpServer(config, adapter);
server.listen(Number(process.argv[3] ?? 0), '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('fixture listener absent');
process.send?.({ endpoint: `http://127.0.0.1:${address.port}`, runtime: runtimeIdentity(config) });
let closing = false;
const stop = () => {
  if (closing) return; closing = true;
  void (async () => {
    await adapter.cleanup();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await closeHandler();
    process.disconnect?.();
  })();
};
process.once('SIGTERM', stop); process.once('disconnect', stop);

// Explicit GC makes request-lifetime regressions deterministic, not load-based.
process.on('message', message => {
  if (message === 'collect-garbage') {
    if (!global.gc) throw new Error('fixture requires --expose-gc');
    global.gc();
    setImmediate(() => { global.gc!(); process.send?.({ event: 'garbage-collected' }); });
  }
});
