import { MAX_WIRE_BYTES, object, RouteError } from './wire.js';

/** Incremental SSE framing, including CRLF split across network chunks. Only
 * JSON data fields are rewritten; event IDs, comments and retry fields survive. */
export class SseRewriter {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private text = '';
  private scanFrom = 0;
  private lines: string[] = [];
  private frameBytes = 0;
  constructor(private readonly rewrite: (message: Record<string, unknown>) => Record<string, unknown>) {}

  push(bytes: Uint8Array): string[] { this.text += this.decoder.decode(bytes, { stream: true }); return this.consume(false); }
  end(): string[] {
    this.text += this.decoder.decode();
    const frames = this.consume(true);
    if (this.text || this.lines.some(line => !line.startsWith(':'))) throw new RouteError('INCOMPLETE_BACKEND_EVENT', 502);
    return frames;
  }
  private consume(final: boolean): string[] {
    const frames: string[] = [];
    const newline = /\r\n|\r|\n/g;
    while (true) {
      newline.lastIndex = this.scanFrom;
      const match = newline.exec(this.text);
      if (!match) { this.scanFrom = this.text.length; break; }
      if (!final && match[0] === '\r' && match.index + 1 === this.text.length) { this.scanFrom = match.index; break; }
      const line = this.text.slice(0, match.index);
      this.text = this.text.slice(match.index + match[0].length); this.scanFrom = 0;
      this.frameBytes += Buffer.byteLength(line) + 1;
      if (this.frameBytes > MAX_WIRE_BYTES) throw new RouteError('BACKEND_EVENT_LIMIT', 502);
      if (line !== '') { this.lines.push(line); continue; }
      if (this.lines.length) frames.push(this.frame());
      this.lines = []; this.frameBytes = 0;
    }
    if (this.frameBytes + Buffer.byteLength(this.text) > MAX_WIRE_BYTES) throw new RouteError('BACKEND_EVENT_LIMIT', 502);
    return frames;
  }
  private frame(): string {
    const data = this.lines.filter(line => line === 'data' || line.startsWith('data:'))
      .map(line => line === 'data' ? '' : line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return this.lines.join('\n') + '\n\n';
    let value: Record<string, unknown>;
    try { value = object(JSON.parse(data)); } catch { throw new RouteError('INVALID_BACKEND_EVENT', 502); }
    const rewritten = JSON.stringify(this.rewrite(value));
    const retained = this.lines.filter(line => line !== 'data' && !line.startsWith('data:'));
    return [...retained, 'data: ' + rewritten].join('\n') + '\n\n';
  }
}

/** Small finite administrative probes accept either negotiated MCP encoding. */
export function decodeRpc(bytes: Uint8Array, contentType: string | undefined, id?: unknown): Record<string, unknown> {
  const text = Buffer.from(bytes).toString('utf8');
  if (!contentType?.includes('text/event-stream') && !text.startsWith('event:') && !text.startsWith('data:')) return object(JSON.parse(text));
  let reply: Record<string, unknown> | undefined;
  const parser = new SseRewriter(message => {
    if (('result' in message || 'error' in message) && (id === undefined || message.id === id)) reply = message;
    return message;
  });
  parser.push(bytes); parser.end();
  if (!reply) throw new RouteError('BACKEND_REPLY_MISSING', 502);
  return reply;
}
