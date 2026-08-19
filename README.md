# chatgpt-mcp

A stateless MCP server that exposes explicitly configured capabilities on your computer to ChatGPT or any compatible MCP client.

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

ChatGPT chooses which tool to call. `chatgpt-mcp` validates the call against your local capability configuration and performs the operation. It is a thin protocol adapter, not a second planner, and it does not add its own interactive approval loop.

The authoritative architecture is in [`SPEC.md`](./SPEC.md). Delivery sequencing is in [`PLAN.md`](./PLAN.md).

## Capabilities

Every family except `system.info` is opt-in. Disabled capability families are omitted from MCP tool discovery where practical.

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
| `service.status` | Read an allowed system service state |
| `service.control` | Start, stop, or restart an allowed service |
| `app.launch` | Launch a configured named application and return an opaque handle |
| `app.close` | Close an application previously launched through its handle |
| `browser.open` | Open an allowed URL scheme through the configured browser opener |
| `screen.capture` | Capture the desktop and return an MCP PNG image content block |
| `input.move` | Move the desktop pointer |
| `input.click` | Click the desktop pointer, optionally at coordinates |
| `input.type` | Type literal text into the focused application |
| `input.key` | Send a key sequence to the focused application |

## Protocol and transports

The canonical protocol is MCP `2026-07-28`.

- **HTTP:** stateless Streamable HTTP at `/mcp`; the SDK creates a fresh MCP server instance for every request.
- **stdio:** the same server factory through the SDK v2 `serveStdio()` entrypoint.
- No application code depends on `Mcp-Session-Id` or hidden client session state.
- The only continuity in the current surface is explicit: `app.launch` returns a bounded opaque handle that must be passed to `app.close`.

HTTP binds to `127.0.0.1:3210` by default. `/healthz` is also exposed.

## Requirements

Core server:

- Node.js 22+
- pnpm 9.x
- Linux/Unix `ps` for `process.list`

Optional Linux host commands depend on what you enable:

- services: `systemctl` by default (configurable)
- browser opening: `xdg-open` by default (configurable)
- desktop input: `xdotool`
- screenshots: one of `grim`, `gnome-screenshot`, `scrot`, or ImageMagick `import`

No optional desktop command is required when its capability is disabled.

## Install

```sh
git clone https://github.com/platform-modules/chatgpt-mcp.git
cd chatgpt-mcp
corepack enable
corepack prepare pnpm@9.7.0 --activate
pnpm install
pnpm gate
```

`pnpm gate` runs type checking, behavioral tests, and the TypeScript build.

## Configure

```sh
cp config.example.json config.local.json
export CHATGPT_MCP_CONFIG="$PWD/config.local.json"
```

The default configuration exposes only `system.info`. See [`config.example.json`](./config.example.json) for every capability family.

### Minimal filesystem + shell example

```json
{
  "filesystem": {
    "read": true,
    "write": true,
    "roots": ["/home/YOU/projects"]
  },
  "shell": {
    "enabled": true,
    "allowedCommands": ["git", "node", "pnpm"]
  }
}
```

### Named application example

Applications are configured by name; the caller does not supply an arbitrary executable through `app.launch`.

```json
{
  "application": {
    "enabled": true,
    "applications": {
      "terminal": {
        "command": "x-terminal-emulator",
        "args": [],
        "allowArguments": false
      },
      "firefox": {
        "command": "firefox",
        "args": [],
        "allowArguments": true
      }
    },
    "maxTracked": 64
  }
}
```

`app.launch` returns:

```json
{
  "handle": "app_...",
  "pid": 12345
}
```

Use the returned `handle`, not a hidden MCP session, with `app.close`.

### Services

```json
{
  "service": {
    "enabled": true,
    "allowedServices": ["nginx.service", "docker.service"]
  }
}
```

An explicit `"*"` allows any syntactically valid service name.

### Browser and desktop

```json
{
  "browser": {
    "enabled": true,
    "allowedSchemes": ["http", "https"]
  },
  "desktop": {
    "screenCapture": true,
    "input": true,
    "screenBackend": "auto",
    "inputBackend": "xdotool"
  }
}
```

`screenBackend: "auto"` tries `grim`, `gnome-screenshot`, `scrot`, then ImageMagick `import`.

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

If you intentionally want broad filesystem/shell/process/service authority, configure it explicitly rather than changing code:

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
  },
  "service": {
    "enabled": true,
    "allowedServices": ["*"]
  }
}
```

`allowedCommands: ["*"]` still means an executable name plus argument array. `shell.exec` never silently turns input into `sh -c`.

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

For local inspection:

```sh
npx @modelcontextprotocol/inspector node dist/src/stdio.js
```

## Connect to ChatGPT

For a private computer, use OpenAI Secure MCP Tunnel. The current setup is documented in [`docs/CHATGPT.md`](./docs/CHATGPT.md).

```text
ChatGPT
   |
OpenAI-hosted tunnel endpoint
   |
   | outbound HTTPS initiated by your machine
   v
tunnel-client
   |
   +-- stdio: node /path/to/chatgpt-mcp/dist/src/stdio.js
   |
   `-- or HTTP: http://127.0.0.1:3210/mcp
```

The MCP server does not need a public inbound listener when Secure MCP Tunnel is used.

## Trust-boundary behavior

### Filesystem

Every filesystem operation passes through one central authorization module. It normalizes paths, checks configured roots, rejects sibling-prefix tricks, resolves existing ancestors, and rejects symlink escapes including creation beneath a symlinked ancestor.

### Shell

`shell.exec` validates the executable allow-list, uses `spawn(..., { shell: false })`, validates `cwd`, clamps runtime, bounds combined output, and controls caller-provided environment entries.

### Services

Service names are checked against the configured allow-list before invoking the configured service manager.

### Applications

`app.launch` accepts a configured application name, not an arbitrary executable. Caller arguments are independently enabled per application. Handles are bounded by `application.maxTracked` and dead processes are pruned.

### Browser

URLs are parsed before opening and the scheme must be configured. The default schemes are only `http` and `https`.

### Desktop

Desktop input and screenshots are separate opt-in capabilities. Input values and screenshot/text sizes are bounded before operating-system tools are invoked.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm gate
```

GitHub Actions runs the same gate on pushes and pull requests.

The test suite covers configuration, structural error contracts, filesystem traversal/symlink escape, shell policy, core and extended adapters, tool discovery/delegation, MCP image output, modern stateless HTTP, the Node HTTP boundary, and the stdio process entrypoint.

## Platform limitations

- The concrete adapter is Linux-oriented today.
- `process.list` uses `ps`.
- `service.*` defaults to systemd's `systemctl`.
- `input.*` currently uses `xdotool`, so native Wayland environments may need XWayland or a future compositor-specific adapter.
- `screen.capture` supports common Linux screenshot commands; desktop/session permissions still apply.
- The project does not install OpenAI `tunnel-client` or optional desktop packages.
- External ChatGPT/tunnel smoke requires the operator's OpenAI tunnel identity/runtime credentials and cannot be impersonated by repository CI.

## Upstream references

- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP specification: https://modelcontextprotocol.io/specification/2026-07-28
- OpenAI Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- ChatGPT Developer Mode: https://developers.openai.com/api/docs/guides/developer-mode
