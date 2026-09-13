import { OutputRedactor } from '../security/output-redaction.js';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RoutingComputerAdapter } from '../adapter/routing-computer-adapter.js';
import type { ExecRequest, ExecResult } from '../adapter/computer-adapter.js';
import { parseConfig } from '../config.js';
import { adapterError, isComputerAdapterError } from '../errors.js';
import { atomicJobJson, processIdentity, type JobRecord, type JobRequest } from './job-store.js';

/** Separate worker, never restarted automatically. Claim and outcome are durable. */
export async function runJob(directory: string, execute?: (request: ExecRequest) => Promise<ExecResult>): Promise<void> {
  try { await mkdir(join(directory, 'claimed'), { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  const path = join(directory, 'status.json');
  let record = JSON.parse(await readFile(path, 'utf8')) as JobRecord;
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let checking = false;
  const checkCancellation = async (): Promise<void> => {
    if (checking) return;
    checking = true;
    try { await stat(join(directory, 'cancel.json')); abort.abort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') abort.abort(); }
    finally { checking = false; }
  };
  const timer = setInterval(() => { void checkCancellation(); }, 250);
  timer.unref();
  let result: ExecResult | undefined;
  let errorCode: string | undefined;
  try {
    const data = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')) as JobRequest;
    const config = parseConfig(data.config);
    const identity = await processIdentity(process.pid);
    if (identity === undefined) throw new Error('Worker process identity unavailable.');
    record = { ...record, state: 'running', workerPid: process.pid, workerIdentity: identity, updatedAt: new Date().toISOString() };
    await atomicJobJson(path, record);
    await rm(join(directory, 'request.json'));
    await checkCancellation();
    if (abort.signal.aborted) throw adapterError('CANCELLED', 'shell.exec', 'Job cancelled before execution.');
    const computer = new RoutingComputerAdapter(config);
    const adapter = execute ?? computer.exec.bind(computer);
    const redactor = await OutputRedactor.create(config, data.request);
    const raw = await adapter({ ...data.request, signal: abort.signal });
    await redactor.refresh();
    result = redactor.value(raw);
  } catch (error) {
    // Do not persist arbitrary exception messages, which may contain arguments or secrets.
    errorCode = isComputerAdapterError(error) ? error.code : 'OS_ERROR';
  } finally {
    clearInterval(timer);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
  const stdout = result?.stdout ?? '';
  const stderr = result?.stderr ?? '';
  for (const [name, data] of [['stdout.txt', stdout], ['stderr.txt', stderr]] as const) {
    const file = await open(join(directory, name), 'w', 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  }
  await atomicJobJson(path, {
    ...record, state: abort.signal.aborted ? 'cancelled' : (result?.exitCode === 0 && !result.timedOut ? 'succeeded' : 'failed'),
    updatedAt: new Date().toISOString(), exitCode: result?.exitCode ?? null, timedOut: result?.timedOut ?? false,
    outputRedacted: true,
    resultBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr), ...(errorCode === undefined ? {} : { errorCode }),
  });
  await rm(join(directory, 'request.json'), { force: true });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (directory === undefined) throw new Error('A private job directory is required.');
  await runJob(directory);
}
