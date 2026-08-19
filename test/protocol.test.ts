import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { parseConfig } from '../src/config.js';
import { createComputerMcpServerFactory } from '../src/server.js';

test('HTTP handler negotiates MCP 2026-07-28 and uses no session identifier', async () => {
  const config = parseConfig({});
  const handler = createMcpHandler(createComputerMcpServerFactory(config), {
    legacy: 'reject',
    responseMode: 'json',
  });

  let requestSessionHeaderSeen = false;
  let responseSessionHeaderSeen = false;
  let requestCount = 0;
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      requestCount += 1;
      requestSessionHeaderSeen ||= request.headers.has('mcp-session-id');
      const response = await handler.fetch(request);
      responseSessionHeaderSeen ||= response.headers.has('mcp-session-id');
      return response;
    },
  });

  const client = new Client(
    { name: 'chatgpt-mcp-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );

  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'modern');

    const first = await client.callTool({ name: 'system.info', arguments: {} });
    const second = await client.callTool({ name: 'system.info', arguments: {} });
    assert.equal(first.isError, undefined);
    assert.equal(second.isError, undefined);
    assert.equal(typeof first.structuredContent?.hostname, 'string');
    assert.equal(typeof second.structuredContent?.hostname, 'string');
    assert.ok(requestCount >= 3);
    assert.equal(requestSessionHeaderSeen, false);
    assert.equal(responseSessionHeaderSeen, false);
  } finally {
    await client.close();
    await handler.close();
  }
});
