import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('stdio entrypoint serves the same modern MCP tool surface', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-mcp-stdio-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, '{}', 'utf8');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/stdio.ts'],
    cwd: process.cwd(),
    env: {
      CHATGPT_MCP_CONFIG: configPath,
      CHATGPT_MCP_LOG_LEVEL: 'silent',
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'chatgpt-mcp-stdio-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );

  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'modern');
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), ['system.info']);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
