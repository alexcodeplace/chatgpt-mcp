import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

if (process.env.PID_FILE) writeFileSync(process.env.PID_FILE, String(process.pid));
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined || process.env.MODE === 'stall') return;
  let result;
  if (request.method === 'initialize') {
    result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'stdio-test-upstream', version: '1' } };
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'inspect', description: 'Inspect fixture identity', inputSchema: { type: 'object', additionalProperties: false } }] };
  } else if (request.method === 'tools/call') {
    const body = { pid: process.pid, explicit: process.env.MCP_PROXY_EXPLICIT ?? null, inherited: process.env.MCP_PROXY_UNRELATED_SECRET ?? null };
    result = { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
  } else if (request.method === 'ping') {
    result = {};
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
input.on('close', () => process.exit(0));
