import type { McpServer, CallToolResult } from '@modelcontextprotocol/server';
import type { ChatGptMcpConfig } from '../config.js';
import { OutputRedactor, SECRET_REDACTED } from '../security/output-redaction.js';

export type ToolRegistrar = Pick<McpServer, 'registerTool'>;

/** Preserve the SDK's overloaded signatures and forward its callback tuple unchanged. */
export function redactedTools(server: McpServer, config: Readonly<ChatGptMcpConfig>): ToolRegistrar {
  const registerTool = new Proxy(server.registerTool, {
    apply(target, _receiver, parameters: unknown[]) {
      const [name, definition, handler] = parameters;
      if (typeof name !== 'string' || !definition || typeof definition !== 'object' || typeof handler !== 'function') {
        throw new TypeError('Invalid tool registration.');
      }
      const wrapped = async (...callbackArguments: unknown[]): Promise<CallToolResult> => {
        const input = 'inputSchema' in definition ? callbackArguments[0] : {};
        const redactor = await OutputRedactor.create(config, input);
        let result: CallToolResult;
        try { result = await Reflect.apply(handler, undefined, callbackArguments) as CallToolResult; }
        catch {
          result = { isError: true, content: [{ type: 'text', text: 'Unexpected tool failure. Inspect operation state before retrying.' }] };
        }
        try { return await redactor.result(result, name); }
        catch {
          // The operation already ran. Do not leak parser errors or invent a denial.
          return { ...(result.isError === undefined ? {} : { isError: result.isError }),
            content: [{ type: 'text', text: SECRET_REDACTED }] };
        }
      };
      return Reflect.apply(target, server, [name, definition, wrapped]);
    },
  });
  return { registerTool };
}
