import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRpc, SseRewriter } from '../src/hotswap/sse.js';

test('SSE keeps framing and metadata across every UTF-8 and CRLF byte boundary', () => {
  const source = ': heartbeat\r\n\r\nid: resume-1\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":"upstream","result":{"text":"café 🙂"}}\r\n\r\n';
  const parser = new SseRewriter(message => ({ ...message, id: 7 }));
  let output = '';
  for (const byte of Buffer.from(source)) output += parser.push(Uint8Array.of(byte)).join('');
  output += parser.end().join('');
  assert.ok(output.includes(': heartbeat\n\n'));
  assert.ok(output.includes('id: resume-1\nevent: message\n'));
  assert.deepEqual(decodeRpc(Buffer.from(output), 'text/event-stream', 7), { jsonrpc: '2.0', id: 7, result: { text: 'café 🙂' } });
});

test('finite probes skip notifications and select the corresponding result', () => {
  const source = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n' +
    'event: message\ndata: {"jsonrpc":"2.0","id":"wanted","result":{"ok":true}}\n\n';
  assert.equal((decodeRpc(Buffer.from(source), 'text/event-stream', 'wanted').result as { ok: boolean }).ok, true);
  assert.throws(() => decodeRpc(Buffer.from(source), 'text/event-stream', 'absent'));
  assert.deepEqual(decodeRpc(Buffer.from('{"ok":true}'), 'application/json'), { ok: true });
});

test('incomplete, malformed and oversized SSE results cannot become successful replies', () => {
  const truncated = new SseRewriter(message => message);
  truncated.push(Buffer.from('data: {"result":{}}\n'));
  assert.throws(() => truncated.end());
  assert.throws(() => new SseRewriter(message => message).push(Buffer.from('data: not-json\n\n')));
  assert.throws(() => new SseRewriter(message => message).push(Buffer.alloc(8 * 1024 * 1024 + 1, 120)));
  assert.throws(() => new SseRewriter(message => message).push(Uint8Array.of(0xff)));
});
