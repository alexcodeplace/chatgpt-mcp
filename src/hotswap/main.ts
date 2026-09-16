import { readFile, lstat } from 'node:fs/promises';
import { parseConfig } from '../config.js';
import { startRouter } from './router.js';
import { object, RouteError } from './wire.js';

const path = process.argv[2];
if (!path) throw new RouteError('ROUTER_CONFIGURATION_REQUIRED');
async function privateJson(file: string): Promise<Record<string, unknown>> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new RouteError('PRIVATE_CONFIGURATION_REQUIRED');
  }
  return object(JSON.parse(await readFile(file, 'utf8')));
}
const settings = await privateJson(path);
for (const field of ['controlSocket', 'statePath', 'keyFile', 'configPath']) {
  if (typeof settings[field] !== 'string' || !String(settings[field]).startsWith('/')) throw new RouteError('ABSOLUTE_PRIVATE_PATH_REQUIRED');
}
const keyInfo = await lstat(settings.keyFile as string);
if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || keyInfo.uid !== process.getuid?.() || (keyInfo.mode & 0o077) !== 0) {
  throw new RouteError('PRIVATE_ROUTER_KEY_REQUIRED');
}
const config = parseConfig(await privateJson(settings.configPath as string));
const running = await startRouter({ config, port: settings.port as number,
  controlSocket: settings.controlSocket as string, statePath: settings.statePath as string,
  key: (await readFile(settings.keyFile as string, 'utf8')).trim() });
console.error(JSON.stringify({ event: 'router_listening', pid: process.pid, endpoint: running.endpoint }));
let closing = false;
const shutdown = () => { if (closing) return; closing = true; void running.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
