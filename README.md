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

- Linux
- Node.js 22+
- Corepack or `npx` (the installer obtains pnpm 9.7.0 through one of them)
- systemd user services for the persistent tunnel installed by `./install.sh`

Optional Linux host commands depend on what you enable:

- services: `systemctl` by default (configurable)
- browser opening: `xdg-open` by default (configurable)
- desktop input: `xdotool`
- screenshots: one of `grim`, `gnome-screenshot`, `scrot`, or ImageMagick `import`

The quick installer can install the current official OpenAI `tunnel-client` and common Debian/Ubuntu desktop helpers when they are missing.

# Quick install: ChatGPT + your Linux computer

For the normal single-machine setup, use the included installer. It configures `chatgpt-mcp` over stdio, connects it through OpenAI Secure MCP Tunnel, validates the tunnel, and installs a persistent systemd **user** service.

The default quick-install profile intentionally grants broad owner-controlled authority: filesystem read/write from `/`, wildcard executable access through `shell.exec`, process control, service control, browser opening, screenshots, and desktop input where the host supports it. The installer shows this before continuing. For a narrower policy, use the manual configuration section below instead.

## 1. Create an OpenAI MCP tunnel

Open:

**https://platform.openai.com/settings/organization/tunnels**

Create a tunnel (or open an existing one) and copy its ID. It has the form:

```text
tunnel_0123456789abcdef0123456789abcdef
```

When the tunnel will be used from ChatGPT, associate it with the ChatGPT workspace/account that should be able to see it. OpenAI currently requires **Tunnels Read + Manage** to create/edit a tunnel and **Tunnels Read + Use** to run `tunnel-client` or select the tunnel while creating the ChatGPT app.

## 2. Create the runtime API key

Open:

**https://platform.openai.com/settings/organization/api-keys**

Create a normal **runtime API key**, not an Admin API key. A restricted key with **Tunnels Read + Use** is sufficient for the long-running tunnel client when your Platform principal also has those permissions.

Keep the resulting `sk-...` key. The installer asks for it with hidden terminal input and stores it locally in `.secrets/runtime-api-key` with mode `0600`.

The two values have different jobs:

```text
tunnel_...   = which tunnel this computer belongs to
sk-...       = proves tunnel-client is authorized to use that tunnel
```

The runtime key is used to authenticate `tunnel-client` to OpenAI's **tunnel control plane**. It is not used by this project to make a model inference request. See [Why does the tunnel need an API key?](#why-does-the-tunnel-need-an-api-key) below.

## 3. Clone and run one installer

```sh
git clone https://github.com/platform-modules/chatgpt-mcp.git
cd chatgpt-mcp
./install.sh
```

The installer will:

- ask for the tunnel ID and runtime API key if they are not already supplied;
- protect both values under `.secrets/`;
- run dependency installation and the full project gate;
- create `config.local.json` from the broad-control template;
- install the latest official OpenAI `tunnel-client` on supported Linux architectures if it is missing;
- install common desktop helpers on Debian/Ubuntu when needed;
- initialize the `chatgpt-computer` tunnel profile;
- run `tunnel-client doctor --explain`;
- install and start `~/.config/systemd/user/chatgpt-mcp-tunnel.service`;
- verify that the service stays running and re-run tunnel diagnostics.

If you already have the values in environment variables, non-interactive setup is supported:

```sh
export CONTROL_PLANE_TUNNEL_ID='tunnel_0123456789abcdef0123456789abcdef'
export CONTROL_PLANE_API_KEY='sk-...'
./install.sh --yes
```

Using `export` keeps the key out of the `./install.sh` command line. Do not commit either value.

If you do not want the installer to attempt desktop-package installation:

```sh
./install.sh --no-desktop
```

## 4. Add the tunnel to ChatGPT

While the tunnel service is running:

1. In ChatGPT web, open **Settings → Security and login → Developer mode** and enable it.
2. Open **https://chatgpt.com/plugins**.
3. Select the plus button and create a developer-mode app.
4. Under **Connection**, choose **Tunnel**.
5. Select the tunnel you created, or paste its `tunnel_id` when offered.
6. Enable the new app in a conversation from the Developer mode tool picker.
7. First test: `Use my computer MCP's system.info tool and report the hostname and enabled capabilities.`

If the tunnel is not listed, check that it is associated with the target ChatGPT workspace/account and that your Platform principal has **Tunnels Read + Use**.

## Check or remove the local installation

```sh
./scripts/tunnel-status.sh
```

To remove the persistent service and disable the local tunnel profile while leaving your repository config/secrets untouched:

```sh
./scripts/tunnel-uninstall.sh
```

## Why does the tunnel need an API key?

The API key is an **authentication credential for the tunnel transport**.

ChatGPT cannot directly connect to `localhost` on your Linux computer. `tunnel-client` therefore makes an outbound HTTPS connection to OpenAI, polls for MCP work addressed to your tunnel, forwards those MCP calls to `chatgpt-mcp` locally, and sends the MCP responses back. The runtime API key proves to the OpenAI tunnel control plane that this local daemon is authorized to use that tunnel.

For the ChatGPT Developer Mode path shown here, `chatgpt-mcp` does **not** call an OpenAI model API, and the runtime key is not passed to a model endpoint by this project. The model is the ChatGPT conversation you are already using; the tunnel is the transport that lets that ChatGPT conversation reach your private MCP server.

OpenAI bills API model usage separately from ChatGPT subscriptions. Merely running this tunnel does not turn the ChatGPT conversation into a Responses API/model-token request made by `chatgpt-mcp`. OpenAI's current Secure MCP Tunnel documentation does not publish a separate tunnel-pricing schedule, so this project does not promise that the tunnel service itself will remain unpriced forever. If you separately use OpenAI model APIs, that API usage is billed under the API Platform as usual.

## Manual install / development

If you do not want the broad quick-install policy or do not want a persistent tunnel service, install manually:

```sh
git clone https://github.com/platform-modules/chatgpt-mcp.git
cd chatgpt-mcp
corepack pnpm install
corepack pnpm gate
```

`pnpm gate` runs type checking, behavioral tests, and the TypeScript build.

## Configure manually

```sh
cp config.example.json config.local.json
export CHATGPT_MCP_CONFIG="$PWD/config.local.json"
```

The default configuration exposes only `system.info`. See [`config.example.json`](./config.example.json) for every capability family. `config.local.json` and `.secrets/` are gitignored.

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

[`config.full.example.json`](./config.full.example.json) is the broad policy used by `./install.sh`. If you intentionally want broad filesystem/shell/process/service authority in a manual setup, copy it to `config.local.json` and adjust it before starting the server.

`allowedCommands: ["*"]` still means an executable name plus argument array. `shell.exec` never silently turns input into `sh -c`.

## Start over HTTP

```sh
corepack pnpm build
CHATGPT_MCP_CONFIG="$PWD/config.local.json" corepack pnpm start:http
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
corepack pnpm build
CHATGPT_MCP_CONFIG="$PWD/config.local.json" corepack pnpm start:stdio
```

stdout is reserved for MCP protocol traffic. Diagnostics are written to stderr.

For local inspection:

```sh
npx @modelcontextprotocol/inspector node dist/src/stdio.js
```

## Connect to ChatGPT manually

The automated installer above is the preferred single-machine path. The complete manual tunnel procedure is in [`docs/CHATGPT.md`](./docs/CHATGPT.md).

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
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm gate
```

GitHub Actions runs the same gate on pushes and pull requests and also syntax-checks the installer scripts.

The test suite covers configuration, structural error contracts, filesystem traversal/symlink escape, shell policy, core and extended adapters, tool discovery/delegation, MCP image output, modern stateless HTTP, the Node HTTP boundary, and the stdio process entrypoint.

## Platform limitations

- The concrete adapter is Linux-oriented today.
- `process.list` uses `ps`.
- `service.*` defaults to systemd's `systemctl`.
- `input.*` currently uses `xdotool`, so native Wayland environments may need XWayland or a future compositor-specific adapter.
- `screen.capture` supports common Linux screenshot commands; desktop/session permissions still apply.
- `./install.sh` can install the latest official `tunnel-client` on Linux amd64/arm64 and common Debian/Ubuntu desktop helpers. Other platforms/package managers may require manual prerequisites.
- External ChatGPT/tunnel smoke still requires the operator's own OpenAI tunnel identity/runtime credentials; repository CI cannot impersonate them.

## Upstream references

- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP specification: https://modelcontextprotocol.io/specification/2026-07-28
- OpenAI Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- OpenAI tunnel-client: https://github.com/openai/tunnel-client
- OpenAI tunnel management: https://platform.openai.com/settings/organization/tunnels
- OpenAI runtime API keys: https://platform.openai.com/settings/organization/api-keys
- ChatGPT Developer Mode: https://developers.openai.com/api/docs/guides/developer-mode
