# chatgpt-mcp

A stateless MCP server that exposes explicitly configured capabilities on your computer to ChatGPT or any compatible MCP client.

The project is intentionally thin:

```text
ChatGPT / MCP client
        |
        | MCP 2026-07-28
        v
chatgpt-mcp
        |
        | typed ComputerAdapter seam
        v
local operating system
```

ChatGPT chooses which tool to call. `chatgpt-mcp` validates the call against your local capability configuration and performs the operation. It does not run a second planner and it does not add its own interactive approval loop.

The authoritative architecture is in [`SPEC.md`](./SPEC.md). Delivery sequencing is in [`PLAN.md`](./PLAN.md).

## Current capabilities

Milestone 1 exposes:

| Tool | Purpose |
| --- | --- |
| `system.info` | Host/runtime information and granted capability summary |
| `fs.list` | List an allowed directory |
| `fs.read` | Read an allowed UTF-8 text file |
| `fs.write` | Create, overwrite, or append an allowed text file |
| `fs.mkdir` | Create an allowed directory |
| `fs.move` | Move/rename inside allowed roots |
| `fs.delete` | Delete inside allowed roots |
| `shell.exec` | Spawn one allowed executable with an argument array; no implicit shell |
| `process.list` | List visible processes |
| `process.kill` | Send a signal to a PID |

Disabled capability families are omitted from MCP tool discovery where practical.

## Protocol and transports

The canonical protocol is MCP `2026-07-28`.

- **HTTP:** stateless Streamable HTTP at `/mcp`; the SDK creates a fresh MCP server instance for every request.
- **stdio:** the same server factory through the SDK v2 `serveStdio()` entrypoint.
- No application code depends on `Mcp-Session-Id` or hidden client session state.
- Future long-running operations must return explicit handles that later calls pass back.

HTTP binds to `127.0.0.1:3210` by default. `/healthz` is also exposed.

## Requirements

- Node.js 22+
- pnpm 9.x
- Linux for the current process-listing implementation (`ps`)

If pnpm is not installed and Corepack is available:

```sh
corepack enable
corepack prepare pnpm@9.7.0 --activate
```

## Install

```sh
git clone https://github.com/platform-modules/chatgpt-mcp.git
cd chatgpt-mcp
pnpm install
pnpm gate
```

`pnpm gate` runs type checking, behavioral tests, and the TypeScript build.

## Configure

Copy the example:

```sh
cp config.example.json config.local.json
export CHATGPT_MCP_CONFIG="$PWD/config.local.json"
```

The default configuration exposes only `system.info`. Filesystem, shell, and process authority are opt-in.

Example:

```json
{
  "http": {
    "host": "127.0.0.1",
    "port": 3210
  },
  "filesystem": {
    "read": true,
    "write": true,
    "roots": ["/home/YOU/projects", "/home/YOU/Downloads"],
    "maxReadBytes": 1048576,
    "maxWriteBytes": 4194304
  },
  "shell": {
    "enabled": true,
    "allowedCommands": ["git", "node", "pnpm", "npm", "python3", "bash"],
    "maxRuntimeMs": 120000,
    "maxOutputBytes": 4194304,
    "allowEnvironment": false
  },
  "process": {
    "list": true,
    "kill": false
  },
  "logLevel": "info"
}
```

### Environment overrides

- `CHATGPT_MCP_CONFIG`
- `CHATGPT_MCP_HOST`
- `CHATGPT_MCP_PORT`
- `CHATGPT_MCP_TOKEN`
- `CHATGPT_MCP_ALLOWED_HOSTS` — comma-separated hostnames
- `CHATGPT_MCP_ALLOWED_ORIGINS` — comma-separated origin hostnames
- `CHATGPT_MCP_LOG_LEVEL`

Configuration is parsed once at startup and deeply frozen.

### Broad owner-controlled access

If you intentionally want broad local authority, configure it explicitly rather than changing code:

```json
{
  "filesystem": {
    "read": true,
    "write": true,
    "roots": ["/"],
    "maxReadBytes": 16777216,
    "maxWriteBytes": 16777216
  },
  "shell": {
    "enabled": true,
    "allowedCommands": ["*"],
    "maxRuntimeMs": 600000,
    "maxOutputBytes": 16777216,
    "allowEnvironment": true
  },
  "process": {
    "list": true,
    "kill": true
  }
}
```

`allowedCommands: ["*"]` still means an executable name plus argument array. `shell.exec` does not silently turn the input into `sh -c`.

## Start over HTTP

```sh
pnpm build
CHATGPT_MCP_CONFIG="$PWD/config.local.json" pnpm start:http
```

Default endpoint:

```text
http://127.0.0.1:3210/mcp
```

Health check:

```sh
curl http://127.0.0.1:3210/healthz
```

If `CHATGPT_MCP_TOKEN` or `http.token` is set, `/mcp` requires `Authorization: Bearer <token>`. `/healthz` remains token-free.

A non-loopback HTTP bind is rejected unless `http.allowedHosts` / `CHATGPT_MCP_ALLOWED_HOSTS` is configured. Origin validation is also applied when an `Origin` header is present.

## Start over stdio

```sh
pnpm build
CHATGPT_MCP_CONFIG="$PWD/config.local.json" pnpm start:stdio
```

stdout is reserved for MCP protocol traffic. Diagnostics are written to stderr.

For a local inspection without ChatGPT:

```sh
npx @modelcontextprotocol/inspector node dist/src/stdio.js
```

## Connect to ChatGPT

For a computer that should remain private, use OpenAI Secure MCP Tunnel. The shortest current setup is documented in [`docs/CHATGPT.md`](./docs/CHATGPT.md).

The local layout is:

```text
ChatGPT
   |
OpenAI-hosted tunnel endpoint
   |
   | outbound HTTPS connection initiated by your machine
   v
tunnel-client
   |
   +-- stdio: node /path/to/chatgpt-mcp/dist/src/stdio.js
   |
   `-- or HTTP: http://127.0.0.1:3210/mcp
```

The MCP server does not need a public inbound listener when Secure MCP Tunnel is used.

## Filesystem boundary

Every filesystem operation uses one central path-authorization module. It:

- resolves requested paths;
- verifies they are within a configured root;
- rejects sibling-prefix tricks;
- resolves existing ancestors;
- rejects symlink escapes, including creation beneath a symlinked ancestor.

Tests operate only on temporary directories.

## Shell boundary

`shell.exec`:

- validates the executable against the configured allow-list;
- uses `child_process.spawn` with `shell: false`;
- validates `cwd` through the filesystem policy;
- clamps runtime to the configured maximum;
- bounds combined stdout/stderr;
- rejects caller-provided environment entries unless `allowEnvironment` is enabled;
- returns non-zero process exit codes as normal execution results.

Infrastructure and policy failures are returned as typed adapter/tool errors.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm gate
```

The test suite covers configuration, structural error contracts, filesystem traversal/symlink escape, shell policy, the local adapter, MCP tool discovery/invocation, modern stateless HTTP, the Node HTTP boundary, and the stdio process entrypoint.

## Current limitations

- Process listing currently targets Linux/Unix `ps` output.
- GUI/input/service/browser capabilities are a later implementation wave and are not part of Milestone 1 yet.
- The project does not install or configure OpenAI `tunnel-client` for you.
- External ChatGPT/tunnel smoke requires your OpenAI tunnel identity/runtime credentials and is therefore an operator validation, not something CI can impersonate.

## Upstream references

- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP specification: https://modelcontextprotocol.io/specification/2026-07-28
- OpenAI Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- ChatGPT Developer Mode: https://developers.openai.com/api/docs/guides/developer-mode
