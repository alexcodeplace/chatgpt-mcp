import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { LocalComputerAdapter } from '../src/adapter/local-computer-adapter.js';
import { parseConfig } from '../src/config.js';
import { adapterError } from '../src/errors.js';
import { JobStore, atomicJobJson } from '../src/execution/job-store.js';
import { runJob } from '../src/execution/job-worker.js';
import { OutputRedactor, SECRET_REDACTED as MASK, isSecretName } from '../src/security/output-redaction.js';
import { registerTools } from '../src/tools/register-tools.js';

const opaque = (): string => randomBytes(24).toString('base64url');
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-redaction-'));
  const config = parseConfig({
    filesystem: { read: true, write: true, roots: [directory] },
    shell: { enabled: true, allowedCommands: ['*'], allowEnvironment: true, maxOutputBytes: 1024 * 1024 },
    jobs: { enabled: true, directory: join(directory, 'jobs'), launcher: 'detached' },
  });
  const privateDirectory = join(directory, '.secrets');
  await mkdir(privateDirectory);
  const path = join(privateDirectory, 'fixture.api');
  const token = opaque();
  await writeFile(path, token + '\n', { mode: 0o600 });
  return { directory, config, path, token, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
async function harness(config: ReturnType<typeof parseConfig>, adapter = new LocalComputerAdapter(config)) {
  const server = new McpServer({ name: 'redaction-test', version: '1' });
  registerTools(server, config, adapter);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'redaction-test-client', version: '1' });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function absent(value: unknown, token: string): void {
  assert.equal(JSON.stringify(value).includes(token), false, 'output must not contain the private fixture value');
}

test('default-on config accepts explicit source paths without changing shell grants', () => {
  const config = parseConfig({ outputRedaction: { files: ['./private.data'], directories: ['./private'] } });
  assert.equal(config.shell.enabled, false);
  assert.equal(config.outputRedaction.files[0], join(process.cwd(), 'private.data'));
  assert.ok(Object.isFrozen(config.outputRedaction.files));
  assert.deepEqual(parseConfig({}).outputRedaction, { files: [], directories: [] });
});

test('credential field detection does not mistake metrics or source-list names for keys', () => {
  for (const name of ['CLOUDFLARE_API_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'clientSecret', 'authorization', 'password']) assert.ok(isSecretName(name), name);
  for (const name of ['tokenCount', 'secretFiles', 'publicKey', 'jobId', 'requestHash', 'key', 'monkey']) assert.equal(isSecretName(name), false, name);
});

test('known values, encodings and nested errors are redacted without mutating inputs', async () => {
  const f = await fixture();
  try {
    const input = { cwd: f.directory, env: { TEST_API_TOKEN: f.token } };
    const redactor = await OutputRedactor.create(f.config, input);
    const raw = { exitCode: 17, timedOut: false, stdout: f.token, details: { nested: [f.token, Buffer.from(f.token).toString('base64'), Buffer.from(f.token).toString('hex')] } };
    const result = redactor.value(raw);
    absent(result, f.token);
    assert.equal(result.stdout, MASK);
    assert.equal(result.exitCode, 17);
    assert.equal(result.timedOut, false);
    assert.equal(raw.stdout, f.token);
    assert.equal(input.env.TEST_API_TOKEN, f.token);
  } finally { await f.cleanup(); }
});

test('recognized assignments, headers, URLs, CLI values and provider formats', async () => {
  const redactor = await OutputRedactor.create(parseConfig({}));
  const value = opaque();
  for (const text of [
    `CLOUDFLARE_API_TOKEN=${value}`, `{"apiKey":"${value}"}`, `password='${value}'`,
    `Authorization: Bearer ${value}`, `Cookie: session=${value}; refresh=${value}`,
    `https://person:${value}@example.test/path`, `https://example.test/?access_token=${value}&ok=1`,
    `command --api-key ${value}`, `ghp_${'a'.repeat(36)}`, `sk-proj-${'b'.repeat(42)}`,
  ]) {
    const result = redactor.text(text);
    absent(result, value);
    assert.ok(result.includes(MASK), 'recognized credential should be replaced');
  }
});

test('unlabeled credentials in referenced files outside cwd are discovered', async () => {
  const f = await fixture();
  try {
    const other = join(f.directory, 'other'); await mkdir(other);
    const redactor = await OutputRedactor.create(f.config, { cwd: other, command: 'python3', args: ['-c', `p = "${f.path}"`] });
    assert.equal(redactor.text(f.token), MASK);
  } finally { await f.cleanup(); }
});

test('dotenv, JSON, comments and PEM are parsed as data without executing content', async () => {
  const f = await fixture();
  try {
    const token = opaque(); const jsonValue = opaque(); const commented = opaque();
    await writeFile(join(f.directory, '.env'), `export API_TOKEN='${token}'\nNOT_SECRET=$(touch should-not-exist)\n`);
    await writeFile(join(f.directory, '.secrets', 'settings.json'), JSON.stringify({ nested: { clientSecret: jsonValue } }));
    await writeFile(join(f.directory, '.secrets', 'commented.key'), `# application credential\n${commented}\n`);
    const redactor = await OutputRedactor.create(f.config, { cwd: f.directory });
    for (const value of [token, jsonValue, commented]) assert.equal(redactor.text(value), MASK);
    assert.equal(redactor.text('-----BEGIN PRIVATE KEY-----\naGVsbG9wcml2YXRla2V5\n-----END PRIVATE KEY-----'), MASK);
    await assert.rejects(readFile(join(f.directory, 'should-not-exist')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('pre-operation credential remains protected after rotation and deletion', async () => {
  const f = await fixture();
  try {
    const redactor = await OutputRedactor.create(f.config, { cwd: f.directory });
    const replacement = opaque(); await writeFile(f.path, replacement);
    await redactor.refresh(); await rm(f.path); await redactor.refresh();
    assert.equal(redactor.text(`${f.token} ${replacement}`), `${MASK} ${MASK}`);
  } finally { await f.cleanup(); }
});

test('explicit unconventional files and directories redact opaque values', async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, 'private.data'); const value = opaque(); await writeFile(path, value);
    const config = parseConfig({ outputRedaction: { files: [path], directories: [dirname(f.path)] } });
    const redactor = await OutputRedactor.create(config);
    assert.equal(redactor.text(value), MASK);
    assert.equal(redactor.text(f.token), MASK);
  } finally { await f.cleanup(); }
});

test('missing and malformed sources do not break ordinary output', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, '.secrets', 'broken.json'), '{invalid json');
    const config = parseConfig({ ...f.config, outputRedaction: { files: [join(f.directory, 'missing')] } });
    const redactor = await OutputRedactor.create(config, { cwd: f.directory });
    assert.equal(redactor.text('Build complete: 18 tests; commit 0123456789abcdef'), 'Build complete: 18 tests; commit 0123456789abcdef');
  } finally { await f.cleanup(); }
});

test('bounded file inspection suppresses output, not execution metadata', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, '.secrets', 'huge.data'), 'a'.repeat(70 * 1024));
    const redactor = await OutputRedactor.create(f.config, { cwd: f.directory });
    const result = redactor.value({ exitCode: 0, stdout: 'opaque log', stderr: '', timedOut: false });
    assert.deepEqual(result, { exitCode: 0, stdout: MASK, stderr: '', timedOut: false });
  } finally { await f.cleanup(); }
});

test('symlink discovery does not read values outside granted roots', async () => {
  const f = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'mcp-redaction-outside-'));
  try {
    const token = opaque(); await writeFile(join(outside, 'private'), token);
    await symlink(join(outside, 'private'), join(f.directory, '.secrets', 'alias'));
    const redactor = await OutputRedactor.create(f.config, { cwd: f.directory });
    assert.equal(redactor.text(token), token);
  } finally { await f.cleanup(); await rm(outside, { recursive: true, force: true }); }
});

test('credential-file reads return marker and normal source files remain readable', async () => {
  const f = await fixture(); const h = await harness(f.config);
  try {
    const result = await h.client.callTool({ name: 'fs.read', arguments: { path: f.path } });
    assert.notEqual(result.isError, true);
    assert.equal((result.structuredContent as Record<string, unknown>)['content'], MASK);
    absent(result, f.token.slice(0, 8));
    const source = join(f.directory, 'normal.ts'); await writeFile(source, 'const answer = 42;');
    const normal = await h.client.callTool({ name: 'fs.read', arguments: { path: source } });
    assert.equal((normal.structuredContent as Record<string, unknown>)['content'], 'const answer = 42;');
  } finally { await h.close(); await f.cleanup(); }
});

test('MCP failures redact secret details while preserving error codes', async () => {
  const f = await fixture(); const adapter = new LocalComputerAdapter(f.config);
  adapter.readFile = async () => { throw adapterError('OS_ERROR', 'fs.read', `rejected ${f.token}`, { token: f.token }); };
  const config = parseConfig({ ...f.config, outputRedaction: { files: [f.path] } });
  const h = await harness(config, adapter);
  try {
    const result = await h.client.callTool({ name: 'fs.read', arguments: { path: join(f.directory, 'ordinary') } });
    assert.equal(result.isError, true); absent(result, f.token);
    assert.match(JSON.stringify(result), /OS_ERROR/);
  } finally { await h.close(); await f.cleanup(); }
});

test('the full result is learned before either text or structured content is returned', async () => {
  const token = opaque(); const redactor = await OutputRedactor.create(parseConfig({}));
  const result = await redactor.result({ content: [{ type: 'text', text: token }], structuredContent: { apiKey: token } }, 'fixture');
  absent(result, token);
  assert.equal(result.content[0]?.type === 'text' ? result.content[0].text : '', MASK);
});

test('binary image data is not corrupted by text replacement', async () => {
  const redactor = await OutputRedactor.create(parseConfig({}));
  const data = Buffer.from('test pixels').toString('base64');
  const result = await redactor.result({ content: [{ type: 'image', data, mimeType: 'image/png' }] }, 'screen.capture');
  assert.equal(result.content[0]?.type === 'image' ? result.content[0].data : '', data);
});

test('real child authenticates with file credential; split stdout/stderr are redacted, side effects and exit codes unchanged', async () => {
  const f = await fixture(); const h = await harness(f.config);
  let authenticated = 0;
  const http = createServer((request, response) => {
    if (request.headers.authorization === `Bearer ${f.token}`) { authenticated++; response.end('authenticated'); }
    else { response.statusCode = 403; response.end('unauthorized'); }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const script = join(f.directory, 'consume.mjs');
  await writeFile(script, `import fs from 'node:fs';
const credential = fs.readFileSync(process.argv[2], 'utf8').trim();
const response = await fetch(process.argv[3], {headers: {Authorization: 'Bearer ' + credential}});
if (!response.ok) process.exit(99);
fs.writeFileSync('effect.txt', 'credential accepted');
process.stdout.write('authenticated\\n' + credential.slice(0, 9));
setTimeout(() => { process.stdout.write(credential.slice(9) + '\\n'); process.stderr.write(credential); process.exitCode = 7; }, 30);
`);
  try {
    const result = await h.client.callTool({ name: 'shell.exec', arguments: {
      command: basename(process.execPath), args: [script, f.path, `http://127.0.0.1:${address.port}`], cwd: f.directory,
      env: { PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? ''), UV_THREADPOOL_SIZE: '2' }, timeoutMs: 10_000,
    } });
    assert.notEqual(result.isError, true);
    const body = result.structuredContent as Record<string, unknown>;
    assert.equal(body['exitCode'], 7); assert.equal(authenticated, 1);
    assert.equal(body['stdout'], `authenticated\n${MASK}\n`); assert.equal(body['stderr'], MASK);
    absent(result, f.token);
    assert.equal(await readFile(join(f.directory, 'effect.txt'), 'utf8'), 'credential accepted');
    assert.equal((await readFile(f.path, 'utf8')).trim(), f.token);
  } finally { await h.close(); await new Promise<void>(resolve => http.close(() => resolve())); await f.cleanup(); }
});

test('durable output is redacted on disk before one-character pagination and replay', async () => {
  const f = await fixture(); let executions = 0;
  const store = new JobStore(f.config, async path => {
    await runJob(path, async () => { executions++; return { exitCode: 0, stdout: f.token, stderr: f.token, durationMs: 1, timedOut: false }; });
  });
  try {
    const request = { command: 'echo', args: [], cwd: f.directory };
    const record = await store.start('redaction-durable-once', request);
    assert.equal(record.state, 'succeeded'); assert.equal(record.outputRedacted, true);
    for (const stream of ['stdout', 'stderr'] as const) {
      assert.equal(await readFile(join(f.config.jobs.directory, record.jobId, `${stream}.txt`), 'utf8'), MASK);
      let text = ''; let offset = 0;
      for (;;) {
        const page = await store.output(record.jobId, stream, offset, 1); text += page['text']; offset = page['nextOffset'] as number;
        if (page['complete']) break;
      }
      assert.equal(text, MASK);
    }
    await store.start('redaction-durable-once', request); assert.equal(executions, 1);
  } finally { await f.cleanup(); }
});

test('unproven legacy output is never exposed through pagination', async () => {
  const f = await fixture();
  const store = new JobStore(f.config, async path => {
    await runJob(path, async () => ({ exitCode: 0, stdout: 'ordinary', stderr: '', durationMs: 1, timedOut: false }));
  });
  try {
    const record = await store.start('redaction-legacy-output', { command: 'echo', args: [], cwd: f.directory });
    const { outputRedacted: _flag, ...legacy } = record;
    await atomicJobJson(join(f.config.jobs.directory, record.jobId, 'status.json'), legacy);
    await writeFile(join(f.config.jobs.directory, record.jobId, 'stdout.txt'), f.token);
    assert.equal((await store.output(record.jobId, 'stdout'))['text'], MASK);
    assert.equal((await store.status(record.jobId)).state, 'succeeded');
  } finally { await f.cleanup(); }
});

test('adapter-returned partial credential content is redacted; existing read limits are preserved', async () => {
  const f = await fixture(); const adapter = new LocalComputerAdapter(f.config);
  const actual = await harness(f.config);
  const realRead = adapter.readFile.bind(adapter);
  adapter.readFile = async (path, maxBytes) => path === f.path ? f.token.slice(0, 8) : realRead(path, maxBytes);
  const partial = await harness(f.config, adapter);
  try {
    const limited = await actual.client.callTool({ name: 'fs.read', arguments: { path: f.path, maxBytes: 8 } });
    assert.equal(limited.isError, true); assert.match(JSON.stringify(limited), /OUTPUT_LIMIT/);
    absent(limited, f.token);
    const redacted = await partial.client.callTool({ name: 'fs.read', arguments: { path: f.path, maxBytes: 8 } });
    assert.notEqual(redacted.isError, true);
    assert.equal((redacted.structuredContent as Record<string, unknown>)['content'], MASK);
    absent(redacted, f.token.slice(0, 8));
  } finally { await partial.close(); await actual.close(); await f.cleanup(); }
});

test('repeated redaction is stable for markers in assignments and CLI arguments', async () => {
  const redactor = await OutputRedactor.create(parseConfig({}));
  for (const text of [`API_TOKEN=${MASK}`, `api_key="${MASK}"`, `--token ${MASK}`, MASK]) {
    assert.equal(redactor.text(text), text);
    assert.equal(redactor.text(redactor.text(text)), text);
  }
});

test('credential aliases and paths with spaces are protected', async () => {
  const f = await fixture(); const h = await harness(f.config);
  try {
    const alias = join(f.directory, 'ordinary.txt'); await symlink(f.path, alias);
    const result = await h.client.callTool({ name: 'fs.read', arguments: { path: alias } });
    assert.equal((result.structuredContent as Record<string, unknown>)['content'], MASK);
    const path = join(f.directory, '.secrets', 'key with spaces'); await writeFile(path, f.token);
    const redactor = await OutputRedactor.create(f.config, { command: 'cat', args: [path] });
    assert.equal(redactor.text(f.token), MASK);
  } finally { await h.close(); await f.cleanup(); }
});

test('inspection budget exhaustion preserves the MCP result discriminant and command exit code', async () => {
  const f = await fixture(); const h = await harness(f.config);
  try {
    await writeFile(join(f.directory, '.secrets', 'too-big.data'), 'a'.repeat(70 * 1024));
    const result = await h.client.callTool({ name: 'shell.exec', arguments: { command: 'echo', args: ['completed'], cwd: f.directory } });
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0]?.type, 'text');
    assert.equal((result.structuredContent as Record<string, unknown>)['exitCode'], 0);
    assert.equal((result.structuredContent as Record<string, unknown>)['stdout'], MASK);
  } finally { await h.close(); await f.cleanup(); }
});

test('reading a project log discovers its neighboring credential sources without a cwd argument', async () => {
  const f = await fixture(); const h = await harness(f.config);
  try {
    const path = join(f.directory, 'build.log'); await writeFile(path, `build authenticated ${f.token}`);
    const result = await h.client.callTool({ name: 'fs.read', arguments: { path } });
    absent(result, f.token);
    assert.equal((result.structuredContent as Record<string, unknown>)['content'], `build authenticated ${MASK}`);
  } finally { await h.close(); await f.cleanup(); }
});

test('raw padded Base64 credentials are not mistaken for environment assignments', async () => {
  const f = await fixture();
  try {
    const token = randomBytes(32).toString('base64');
    await writeFile(f.path, token + '\n');
    const redactor = await OutputRedactor.create(f.config, { cwd: f.directory });
    assert.equal(redactor.text(token), MASK);
    assert.equal(redactor.text(Buffer.from(token).toString('base64')), MASK);
  } finally { await f.cleanup(); }
});

test('source variable references cannot rename MCP response fields', async () => {
  const f = await fixture(); const adapter = new LocalComputerAdapter(f.config);
  adapter.exec = async () => ({ exitCode: 0, stdout: 'ordinary text diagnostics', stderr: '', durationMs: 1, timedOut: false });
  const h = await harness(f.config, adapter);
  try {
    const result = await h.client.callTool({ name: 'shell.exec', arguments: { command: 'python3', args: ['-c', 'credential=' + ['te', 'xt'].join('')], cwd: f.directory } });
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0]?.type === 'text' ? result.content[0].text : '', 'ok');
    assert.equal((result.structuredContent as Record<string, unknown>)['stdout'], 'ordinary text diagnostics');
  } finally { await h.close(); await f.cleanup(); }
});

test('known credential collisions redact values but preserve protocol property names', async () => {
  const f = await fixture(); const adapter = new LocalComputerAdapter(f.config);
  const h = await harness(f.config, adapter);
  try {
    for (const word of ['te'+'xt', 'std'+'out', 'exit'+'Code', 'structured'+'Content']) {
      adapter.exec = async () => ({ exitCode: 7, stdout: word, stderr: '', durationMs: 1, timedOut: false });
      const result = await h.client.callTool({ name: 'shell.exec', arguments: { command: 'python3', env: { TEST_API_TOKEN: word }, cwd: f.directory } });
      assert.notEqual(result.isError, true);
      assert.equal(result.content[0]?.type, 'text');
      assert.equal(typeof (result.content[0] as { text?: string }).text, 'string');
      assert.equal((result.structuredContent as Record<string, unknown>)['stdout'], MASK);
      assert.equal((result.structuredContent as Record<string, unknown>)['exitCode'], 7);
    }
  } finally { await h.close(); await f.cleanup(); }
});

test('output suppression retains public enum values and directory-list schema', async () => {
  const f = await fixture(); const h = await harness(f.config);
  try {
    await writeFile(join(f.directory, '.secrets', 'large.data'), 'x'.repeat(70 * 1024));
    const result = await h.client.callTool({ name: 'fs.list', arguments: { path: f.directory } });
    assert.notEqual(result.isError, true);
    const entries = (result.structuredContent as { entries: { name: string; type: string }[] }).entries;
    assert.ok(entries.some(entry => entry.type === 'directory'));
    assert.ok(entries.every(entry => entry.name === MASK));
  } finally { await h.close(); await f.cleanup(); }
});


test('returned source and logs do not teach ordinary values as secrets', async () => {
  const redactor = await OutputRedactor.create(parseConfig({}));
  const text = 'const token = value;\nvalue.length value.map\napi_key=banana\nnormal banana workflow';
  const result = await redactor.result({
    content: [{ type: 'text', text }],
    structuredContent: { stdout: text },
  }, 'shell.exec');
  const output = result.content[0]?.type === 'text' ? result.content[0].text : '';
  assert.match(output, /const token = \[SECRET_REDACTED\];/);
  assert.match(output, /value\.length value\.map/);
  assert.match(output, /api_key=\[SECRET_REDACTED\]/);
  assert.match(output, /normal banana workflow/);
});
