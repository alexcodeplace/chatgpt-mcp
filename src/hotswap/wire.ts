import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';

export const MAX_WIRE_BYTES = 8 * 1024 * 1024;
export class RouteError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RouteError('INVALID_OBJECT', 400);
  return value as Record<string, unknown>;
}
export function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new RouteError('LOOPBACK_BACKEND_REQUIRED', 400);
  }
  return url;
}
export function readBytes(stream: IncomingMessage, limit = MAX_WIRE_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    const cleanup = () => { stream.off('data', data); stream.off('end', end); stream.off('error', fail); stream.off('aborted', aborted); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const aborted = () => fail(new RouteError('INTERRUPTED_INPUT', 400));
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { fail(new RouteError('WIRE_LIMIT', 413)); stream.resume(); return; }
      chunks.push(chunk);
    };
    stream.on('data', data); stream.once('end', end); stream.once('error', fail); stream.once('aborted', aborted);
  });
}
export function forwardHeaders(headers: IncomingMessage['headers']): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {};
  const connection = String(headers.connection ?? '').toLowerCase().split(',').map(v => v.trim());
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith('x-mcp-route-') || ['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'content-length', 'content-encoding'].includes(key) || connection.includes(key)) continue;
    if (value !== undefined) output[key] = value;
  }
  return output;
}
