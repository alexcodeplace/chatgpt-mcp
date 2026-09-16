import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { processIdentity } from '../execution/job-store.js';
import { loadBridgeSettings, readPrivateFile, type BridgeConfiguration } from './bridge.js';
import { object, RouteError } from './wire.js';

interface Listener { port: number; loopback: boolean; inode: string }
export async function listeningSockets(pid: number): Promise<Listener[]> {
  const descriptors = await readdir(`/proc/${pid}/fd`);
  const inodes = new Set<string>();
  await Promise.all(descriptors.map(async name => {
    try { const match = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${name}`)); if (match?.[1]) inodes.add(match[1]); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }));
  const result: Listener[] = [];
  for (const family of ['tcp', 'tcp6']) {
    const rows = (await readFile(`/proc/${pid}/net/${family}`, 'utf8')).trim().split('\n').slice(1);
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      if (fields[3] !== '0A' || !fields[9] || !inodes.has(fields[9])) continue;
      const [address, port] = (fields[1] ?? '').split(':');
      if (!port) throw new RouteError('UNSUPPORTED_SOCKET_TABLE');
      result.push({ port: Number.parseInt(port, 16), inode: fields[9],
        loopback: address === '0100007F' || address === '00000000000000000000000001000000' });
    }
  }
  return result;
}
async function nodeOptions(pid: number): Promise<string> {
  // Inspect only NODE_OPTIONS. No other environment value is decoded, returned
  // or logged; the temporary kernel buffer is wiped immediately afterwards.
  const bytes = await readFile(`/proc/${pid}/environ`);
  try {
    const prefix = Buffer.from('NODE_OPTIONS=');
    for (let begin = 0; begin < bytes.length;) {
      let end = bytes.indexOf(0, begin); if (end < 0) end = bytes.length;
      if (bytes.subarray(begin, begin + prefix.length).equals(prefix)) return bytes.subarray(begin + prefix.length, end).toString();
      begin = end + 1;
    }
    return '';
  } finally { bytes.fill(0); }
}
async function verifyTarget(settings: BridgeConfiguration): Promise<void> {
  if (process.platform !== 'linux' || (await lstat(`/proc/${settings.expectedPid}`)).uid !== process.getuid?.()) throw new RouteError('UNOWNED_ADOPTION_TARGET');
  if (await processIdentity(settings.expectedPid) !== settings.expectedIdentity) throw new RouteError('LEGACY_PROCESS_IDENTITY_CHANGED');
  if (await readlink(`/proc/${settings.expectedPid}/exe`) !== settings.expectedExecutable) throw new RouteError('LEGACY_EXECUTABLE_CHANGED');
  const command = await readFile(`/proc/${settings.expectedPid}/cmdline`);
  if (createHash('sha256').update(command).digest('hex') !== settings.expectedCommandSha256) throw new RouteError('LEGACY_COMMAND_CHANGED');
  const flags = command.toString().split('\0').slice(1).join(' ') + ' ' + await nodeOptions(settings.expectedPid);
  if (/--(?:inspect|disable-sigusr1|permission|experimental-permission)/.test(flags)) throw new RouteError('EXISTING_DEBUGGER_OR_SIGNAL_POLICY_REFUSED');
  const version = await promisify(execFile)(`/proc/${settings.expectedPid}/exe`, ['--version'], { env: { PATH: '/usr/bin:/bin' }, timeout: 3000 });
  const major = Number(/^v(\d+)\./.exec(version.stdout)?.[1]);
  const minor = Number(/^v\d+\.(\d+)\./.exec(version.stdout)?.[1]);
  if (!Number.isInteger(major) || major < 22 || major > 26 || (major === 22 && minor < 13)) throw new RouteError('UNVERIFIED_NODE_ADOPTION_VERSION');
}
class InspectorChannel {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > 64 * 1024) { this.fail(); socket.close(); return; }
      let value: Record<string, unknown>;
      try { value = object(JSON.parse(event.data)); } catch { this.fail(); return; }
      if (typeof value.id !== 'number') return; // Inspector notifications are never logged.
      const operation = this.pending.get(value.id); if (!operation) return;
      clearTimeout(operation.timer); this.pending.delete(value.id);
      try {
        const result = object(value.result);
        if (value.error || result.exceptionDetails) {
          const details = result.exceptionDetails ? object(result.exceptionDetails) : {};
          const exception = details.exception ? object(details.exception) : {};
          const code = /\bERR_[A-Z0-9_]+\b/.exec(String(exception.description ?? ''))?.[0] ?? 'REFUSED';
          operation.reject(new RouteError(`INSPECTOR_OPERATION_${value.id}_${code}`));
        } else operation.resolve(object(result.result).value);
      } catch { operation.reject(new RouteError('INVALID_INSPECTOR_RESPONSE')); }
    });
    socket.addEventListener('error', () => this.fail()); socket.addEventListener('close', () => this.fail());
  }
  private fail() {
    for (const operation of this.pending.values()) { clearTimeout(operation.timer); operation.reject(new RouteError('INSPECTOR_DISCONNECTED')); }
    this.pending.clear();
  }
  async evaluate(expression: string): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new RouteError('INSPECTOR_DISCONNECTED');
    const id = ++this.sequence;
    return new Promise((resolveValue, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RouteError('INSPECTOR_OPERATION_UNCERTAIN')); }, 10_000);
      this.pending.set(id, { resolve: resolveValue, reject, timer });
      this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, silent: true } }));
    });
  }
  close() { this.socket.close(); }
}
async function openOwnedInspector(settings: BridgeConfiguration, inspector: Listener): Promise<InspectorChannel> {
  if (await processIdentity(settings.expectedPid) !== settings.expectedIdentity
    || !(await listeningSockets(settings.expectedPid)).some(item => item.inode === inspector.inode && item.loopback)) {
    throw new RouteError('INSPECTOR_OWNERSHIP_CHANGED');
  }
  const response = await fetch(`http://127.0.0.1:${inspector.port}/json/list`, { signal: AbortSignal.timeout(1500) });
  const targets: unknown = await response.json();
  if (!Array.isArray(targets) || targets.length !== 1) throw new RouteError('UNEXPECTED_INSPECTOR_TARGETS');
  const rawUrl = object(targets[0]).webSocketDebuggerUrl;
  if (typeof rawUrl !== 'string') throw new RouteError('INSPECTOR_ENDPOINT_MISSING');
  const url = new URL(rawUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== inspector.port || url.username || url.password) throw new RouteError('UNTRUSTED_INSPECTOR_ENDPOINT');
  const socket = new WebSocket(url);
  await new Promise<void>((resolveOpen, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new RouteError('INSPECTOR_CONNECT_TIMEOUT')); }, 3000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new RouteError('INSPECTOR_CONNECT_FAILED')); }, { once: true });
  });
  const channel = new InspectorChannel(socket);
  try {
    if (await channel.evaluate('process.pid') !== settings.expectedPid) throw new RouteError('INSPECTOR_PID_MISMATCH');
    return channel;
  } catch (error) { channel.close(); throw error; }
}

async function bridgeStatus(settings: BridgeConfiguration, key: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${settings.port}/__hotswap/bridge`, {
      headers: { 'x-mcp-route-key': key }, signal: AbortSignal.timeout(1500),
    });
    if (response.status !== 200) return undefined;
    const body = object(await response.json());
    if (body.bridgeAbi === 1 && body.generation === settings.id && body.pid === settings.expectedPid && body.legacyAvailable === true) return body;
  } catch { /* An absent marker is not permission to change another listener. */ }
  return undefined;
}

/** Not a general debugger tool. The only loadable code is this release's bridge,
 * and the only argument is the validated private enrollment configuration. */
export async function attachLegacy(path: string): Promise<Record<string, unknown>> {
  const settings = await loadBridgeSettings(path);
  await verifyTarget(settings);
  const key = (await readPrivateFile(settings.keyFile)).trim();
  const existing = await bridgeStatus(settings, key);
  const before = await listeningSockets(settings.expectedPid);
  if (before.length !== 1 || before[0]?.port !== settings.port || !before[0]?.loopback) throw new RouteError('EXISTING_DEBUGGER_OR_UNKNOWN_LISTENER_REFUSED');
  if (existing && existing.inspectorOpen === false) return { ...existing, unchanged: true, inspectorClosed: true };
  await verifyTarget(settings);
  process.kill(settings.expectedPid, 'SIGUSR1');
  let channel: InspectorChannel | undefined;
  let inspector: Listener | undefined;
  let closed = false;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const added = (await listeningSockets(settings.expectedPid)).filter(item => !before.some(old => old.inode === item.inode));
      if (added.length === 1 && added[0]?.loopback) { inspector = added[0]; break; }
      if (added.length > 1 || added.some(item => !item.loopback)) throw new RouteError('UNSAFE_INSPECTOR_LISTENER');
      await delay(10);
    }
    if (!inspector) throw new RouteError('EXCLUSIVE_INSPECTOR_UNAVAILABLE');
    channel = await openOwnedInspector(settings, inspector);
    // A bounded cleanup guard is armed before importing any replacement code.
    // It also closes the inspector if this controller itself is interrupted.
    await channel.evaluate("(() => { const inspector = process.getBuiltinModule('inspector'); setTimeout(() => inspector.close(), 12000).unref(); return true; })()");
    const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const modulePath = fileURLToPath(new URL('./bridge' + extension, import.meta.url));
    // Inspector evaluations have no dynamic-import callback. Use the normal
    // synchronous module loader for this verified, TLA-free bridge module.
    const expression = `process.getBuiltinModule('module').createRequire(${JSON.stringify(modulePath)})(${JSON.stringify(modulePath)}).adopt(${JSON.stringify(resolve(path))}).catch(error => ({ adoptionError: /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'BRIDGE_LOAD_REFUSED' }))`;
    const adopted = object(await channel.evaluate(expression));
    if (typeof adopted.adoptionError === 'string') throw new RouteError(adopted.adoptionError);
  } finally {
    // A failed initial connection may happen before the in-process close guard
    // is armed. Reconnect only to this attempt's still-owned inode to close it;
    // never replay the adoption or attach to an unrelated pre-existing debugger.
    if (!channel && inspector) {
      try { channel = await openOwnedInspector(settings, inspector); } catch { /* Closure must still be observed below. */ }
    }
    if (channel) {
      try { await channel.evaluate("(() => { const inspector = process.getBuiltinModule('inspector'); setImmediate(() => inspector.close()); return true; })()"); } catch { /* Reconcile actual listener state below. */ }
      channel.close();
    }
    if (inspector) {
      const deadline = Date.now() + 14_000;
      while (Date.now() < deadline) {
        if (!(await listeningSockets(settings.expectedPid)).some(item => item.inode === inspector!.inode)) { closed = true; break; }
        await delay(10);
      }
    }
  }
  if (!closed) throw new RouteError('INSPECTOR_CLOSURE_NOT_CONFIRMED');
  const installed = await bridgeStatus(settings, key);
  if (!installed || installed.inspectorOpen !== false) throw new RouteError('ADOPTION_NOT_CONFIRMED');
  return { ...installed, inspectorClosed: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const path = process.argv[2];
  if (!path) throw new RouteError('BRIDGE_CONFIGURATION_REQUIRED');
  try { console.log(JSON.stringify(await attachLegacy(path))); }
  catch (error) {
    // Never echo debugger expressions, raw exception details, arguments or data.
    console.error(JSON.stringify({ error: error instanceof RouteError ? error.code : 'LIVE_ADOPTION_FAILED' }));
    process.exitCode = 1;
  }
}
