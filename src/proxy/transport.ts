import { open } from 'node:fs/promises';
import { Client, SSEClientTransport, StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { HeaderConfig, UpstreamConfig } from './config.js';

/** Only fixed, owner-configured upstreams receive these credentials. */
export async function resolveHeaders(config: HeaderConfig): Promise<Headers> {
  const headers = new Headers();
  for (const [name, source] of Object.entries(config)) {
    let value: unknown = source;
    if (typeof source !== 'string') {
      if ('env' in source) {
        value = process.env[source.env];
      } else {
        const file = await open(source.file, 'r');
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 16_384) throw new Error('Invalid credential file.');
          const buffer = Buffer.alloc(16_385);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 16_384) throw new Error('Credential file is too large.');
          const text = buffer.subarray(0, bytesRead).toString('utf8').trim();
          value = source.jsonField === undefined ? text : (JSON.parse(text) as Record<string, unknown>)[source.jsonField];
        } finally { await file.close(); }
      }
      if (typeof value !== 'string' || !value || value.length > 16_384 || /[\r\n\0]/.test(value)) {
        throw new Error('Upstream credential is unavailable or invalid.');
      }
      value = source.prefix + value;
    }
    headers.set(name, value as string);
  }
  return headers;
}

/** The SDK may initiate close during failed connect without awaiting it. */
function ownTransport<T extends Transport>(transport: T): T {
  const close = transport.close.bind(transport);
  let closing: Promise<void> | undefined;
  transport.close = () => closing ??= close();
  return transport;
}

export function createUpstreamClient(config: UpstreamConfig): { client: Client; transport: Transport } {
  // Legacy negotiation works with existing stdio/SSE servers, including Godot AI.
  // HTTP auto negotiation also accepts newer, stateless-only upstream servers.
  const client = new Client({ name: 'chatgpt-mcp-proxy', version: '0.2.0' }, {
    versionNegotiation: { mode: config.transport === 'http' ? 'auto' : 'legacy' },
    listMaxPages: 64,
  });
  if (config.transport === 'stdio') {
    const env = { ...getDefaultEnvironment(), ...config.env };
    for (const name of config.envFrom) {
      const value = process.env[name];
      if (value === undefined) throw new Error('An upstream environment variable is unavailable.');
      env[name] = value;
    }
    return { client, transport: ownTransport(new StdioClientTransport({
      command: config.command, args: [...config.args], env,
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      // Upstream stderr may contain credentials. Never mix it into MCP output/logs.
      stderr: 'ignore', maxBufferSize: 8 * 1024 * 1024,
    })) };
  }
  const endpoint = new URL(config.url);
  const upstreamFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // SSE may supply a separate POST path, but cannot move credentials to another origin.
    if (url.origin !== endpoint.origin || url.username || url.password) throw new Error('Upstream origin changed.');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    (await resolveHeaders(config.headers)).forEach((value, name) => headers.set(name, value));
    return fetch(input, { ...init, headers, redirect: 'error' });
  };
  return { client, transport: ownTransport(config.transport === 'http'
    ? new StreamableHTTPClientTransport(endpoint, { fetch: upstreamFetch })
    : new SSEClientTransport(endpoint, { fetch: upstreamFetch })) };
}
