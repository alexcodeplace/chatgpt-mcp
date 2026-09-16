import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../../src/config.js';
import { startRouter, type Generation, type RouterOptions, type RunningRouter } from '../../src/hotswap/router.js';
import { readBytes } from '../../src/hotswap/wire.js';
import { decodeRpc } from '../../src/hotswap/sse.js';

export type Json = Record<string, any>;
export async function control(socket: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const call = request({ socketPath: socket, path, method: data ? 'POST' : 'GET',
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, response => {
      void readBytes(response).then(bytes => resolve({ status: response.statusCode ?? 0, body: JSON.parse(bytes.toString()) })).catch(reject);
    });
    call.once('error', reject); call.end(data);
  });
}
export async function rpc(endpoint: string, name: string, args: Json = {}, options: { id?: string | number; session?: string; signal?: AbortSignal; authorization?: string } = {}): Promise<{ status: number; body: Json; generation: string | null }> {
  const response = await fetch(endpoint + '/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(options.session ? { 'mcp-session-id': options.session } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: options.id ?? randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { status: response.status, body: decodeRpc(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-type') ?? undefined), generation: response.headers.get('x-mcp-generation') };
}
export async function call(endpoint: string, name: string, args: Json = {}, options: Parameters<typeof rpc>[3] = {}): Promise<Json> {
  const result = await rpc(endpoint, name, args, options);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.result && !result.body.result.isError, JSON.stringify(result.body));
  return result.body.result.structuredContent as Json;
}
export async function waitFile(path: string, timeout = 15_000): Promise<void> {
  try { await access(path); return; } catch { /* Install watcher before the next existence check. */ }
  await new Promise<void>((resolve, reject) => {
    const observer = watch(dirname(path), () => { void access(path).then(done, () => {}); });
    const timer = setTimeout(() => { observer.close(); reject(new Error('Barrier was not reached: ' + path)); }, timeout);
    function done() { clearTimeout(timer); observer.close(); resolve(); }
    observer.once('error', error => { clearTimeout(timer); reject(error); });
    void access(path).then(done, () => {});
  });
}
export function heldCommand(root: string, name: string): Json {
  const started = join(root, name + '.started'); const release = join(root, name + '.release');
  return { command: process.execPath, cwd: root, timeoutMs: 30_000, args: ['-e',
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},String(process.pid));` +
    `const finish=()=>{if(fs.existsSync(${JSON.stringify(release)})){watcher.close();process.stdout.write(${JSON.stringify(name)});}};` +
    `const watcher=fs.watch(${JSON.stringify(root)},finish);finish();` ] };
}
export async function fixture(extra: Json = {}, persist?: RouterOptions['persist']) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-hot-'));
  const key = randomBytes(32).toString('hex');
  const config = parseConfig({
    filesystem: { roots: [root], read: true, write: true },
    shell: { enabled: true, allowedCommands: [process.execPath], maxRuntimeMs: 60_000 },
    desktop: { hostDisplayAccess: true },
    application: { enabled: true, applications: { worker: { command: process.execPath, args: ['-e', 'setInterval(()=>{},10000)'], allowArguments: false } } },
    jobs: { enabled: true, launcher: 'detached', directory: join(root, 'jobs'), maxConcurrent: 4 },
    ...extra,
  });
  const keyFile = join(root, 'router.key'); const configPath = join(root, 'backend.json');
  await writeFile(keyFile, key, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const socket = join(root, 'control.sock');
  const options: RouterOptions = { config, key, port: 0, controlSocket: socket, statePath: join(root, 'registry.json'), ...(persist ? { persist } : {}) };
  let router: RunningRouter = await startRouter(options);
  const children: ChildProcess[] = [];
  const spawn = async (letter: string, port = 0, preload?: string, bridgeConfig?: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ child: ChildProcess; generation: Generation; runtime: Json }> => {
    const source = import.meta.url.endsWith('.ts');
    const child = fork(fileURLToPath(new URL('./hotswap-backend' + (source ? '.ts' : '.js'), import.meta.url)), [configPath, String(port)], {
      execArgv: ['--expose-gc', ...(source ? ['--import', 'tsx'] : []), ...(preload ? ['--import', preload] : [])], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, CHATGPT_MCP_CONFIG: configPath, CHATGPT_MCP_RELEASE: letter.repeat(40), CHATGPT_MCP_ROUTER_KEY_FILE: keyFile,
        ...(bridgeConfig ? { CHATGPT_MCP_BRIDGE_CONFIG: bridgeConfig } : {}), ...extraEnv },
    });
    children.push(child);
    let errors = ''; child.stderr?.on('data', chunk => { errors += String(chunk); });
    const ready = await new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Backend did not start: ' + errors)), 20_000);
      child.once('message', message => { clearTimeout(timer); resolve(message as Json); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Backend exited ' + code + ': ' + errors)); });
      child.once('error', reject);
    });
    const generation: Generation = { id: ready.runtime.hotSwap.instanceId, url: ready.endpoint, revision: letter.repeat(40),
      unit: 'test-' + letter + '.service', policyFingerprint: ready.runtime.hotSwap.policyFingerprint };
    return { child, generation, runtime: ready.runtime };
  };
  const status = async () => (await control(socket, '/status')).body;
  const register = async (generation: Generation) => {
    const result = await control(socket, '/register', { generation, expectedEpoch: (await status()).epoch });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  };
  const activate = async (generation: Generation) => {
    const result = await control(socket, '/activate', { id: generation.id, expectedEpoch: (await status()).epoch });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  };
  const release = (name: string) => writeFile(join(root, name + '.release'), 'release', { flag: 'wx' });
  return { root, key, keyFile, configPath, config, socket, options, spawn, status, register, activate, release,
    get router() { return router; },
    async reopen() { const port = Number(new URL(router.endpoint).port); await router.close(); router = await startRouter({ ...options, port }); },
    async cleanup() {
      // Only test-owned fixture processes and this unique root are touched.
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => {
        const guard = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(guard); resolve(); });
      })));
      await router.close();
      await rm(root, { recursive: true, force: true });
    },
    async read(name: string) { return readFile(join(root, name), 'utf8'); },
  };
}
