# chatgpt-mcp

A stateless MCP server that exposes explicitly configured capabilities on a Linux computer to ChatGPT or any compatible MCP client.

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

ChatGPT chooses which tool to call. `chatgpt-mcp` validates the call against the local capability configuration and performs the operation. It is a thin protocol adapter, not a second planner, and it does not add its own interactive approval loop.

Architecture: [`SPEC.md`](./SPEC.md). Delivery history: [`PLAN.md`](./PLAN.md). Detailed ChatGPT/tunnel guide: [`docs/CHATGPT.md`](./docs/CHATGPT.md).

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
| `shell.exec` | Spawn an allowed executable with an argument array |
| `process.list` | List visible processes |
| `process.kill` | Send a signal to a PID |
| `service.status` | Read an allowed system service state |
| `service.control` | Start, stop, or restart an allowed service |
| `app.launch` | Launch a configured named application |
| `app.close` | Close an application previously launched through its handle |
| `browser.open` | Open an allowed URL scheme |
| `screen.capture` | Capture the desktop as a PNG MCP image |
| `input.move` | Move the desktop pointer |
| `input.click` | Click the desktop pointer |
| `input.type` | Type literal text into the focused application |
| `input.key` | Send a key sequence to the focused application |

## Requirements

Core server:

- Linux
- Node.js 22+
- pnpm **11.20.0** (the installer obtains the pinned version through Corepack or `npx`)
- systemd user services for the persistent tunnel installed by `./install.sh`

Optional host commands depend on what you enable:

- services: `systemctl`
- browser opening: `xdg-open`
- desktop input: `xdotool`
- screenshots: one of `grim`, `gnome-screenshot`, `scrot`, or ImageMagick `import`

The quick installer can install the current official OpenAI `tunnel-client` and common Debian/Ubuntu desktop helpers when they are missing.

# Quick install: ChatGPT + your Linux computer

For one computer, the recommended route is:

```text
ChatGPT Developer Mode
        |
OpenAI Secure MCP Tunnel
        |
        | outbound HTTPS
        v
tunnel-client on your computer
        |
        | stdio
        v
chatgpt-mcp
```

No public inbound listener is required.

The quick installer intentionally uses [`config.full.example.json`](./config.full.example.json), which grants broad owner-controlled access: filesystem read/write from `/`, wildcard executable access, process/service control, browser opening, screenshots, and desktop input where supported. If you want narrower authority, use `config.example.json` and the manual setup instead.

## 1. Create an OpenAI MCP tunnel

Open:

**https://platform.openai.com/settings/organization/tunnels**

Create a tunnel and copy its ID. It looks like:

```text
tunnel_0123456789abcdef0123456789abcdef
```

For ChatGPT use, associate the tunnel with the ChatGPT workspace/account that should be able to see it.

Current permission split:

- create/edit/delete tunnel: **Tunnels Read + Manage**
- run `tunnel-client` or select the tunnel in ChatGPT: **Tunnels Read + Use**

## 2. Create a runtime API key

Open:

**https://platform.openai.com/settings/organization/api-keys**

Create a normal runtime API key. Do **not** use an Admin API key for the long-lived tunnel daemon.

The installer asks for the resulting `sk-...` value with hidden terminal input and stores it locally in `.secrets/runtime-api-key` with restrictive permissions.

### Why does the tunnel need an API key?

The key authenticates `tunnel-client` to OpenAI's **tunnel control plane**. It proves that the local daemon is allowed to use the selected tunnel.

It is **not** used by `chatgpt-mcp` to call an OpenAI model API. In this setup ChatGPT is already the model/client; Secure MCP Tunnel is only the private transport that lets that ChatGPT conversation reach the local MCP server.

```text
tunnel_...   = which tunnel this computer belongs to
sk-...       = permission for tunnel-client to use that tunnel
```

`chatgpt-mcp` does not make `/v1/responses` or other model-inference requests with this runtime key. OpenAI API model billing is separate from ChatGPT subscription usage. The current Secure MCP Tunnel documentation does not publish a separate tunnel-pricing schedule; check current OpenAI documentation if that changes.

## 3. Clone and run the installer

```sh
git clone https://github.com/alexcodeplace/chatgpt-mcp.git
cd chatgpt-mcp
./install.sh
```

The installer:

- asks for the tunnel ID and runtime API key if they are not already supplied;
- protects both values under `.secrets/`;
- obtains the project-pinned pnpm 11.20.0 without requiring a writable `/usr/bin` Corepack shim;
- installs dependencies and runs the full project gate;
- creates `config.local.json` from the broad-control template;
- installs the official OpenAI `tunnel-client` if missing on supported Linux architectures;
- installs common desktop helpers on Debian/Ubuntu when needed;
- initializes the `chatgpt-computer` tunnel profile;
- uses an ephemeral loopback health port so an existing service on port 8080 does not block installation;
- runs `tunnel-client doctor --explain`;
- installs and starts `~/.config/systemd/user/chatgpt-mcp-tunnel.service`;
- verifies the service and tunnel diagnostics.

Non-interactive setup is also supported:

```sh
export CONTROL_PLANE_TUNNEL_ID='tunnel_0123456789abcdef0123456789abcdef'
export CONTROL_PLANE_API_KEY='sk-...'
./install.sh --yes
```

Do not put the API key directly on the `./install.sh ...` command line or commit it to Git.

To skip optional desktop-package installation:

```sh
./install.sh --no-desktop
```

## 4. Add it to ChatGPT

While the tunnel service is running:

1. In ChatGPT web, open **Settings → Security and login → Developer mode** and enable it.
2. Open **https://chatgpt.com/plugins**.
3. Select the plus button and create a developer-mode app.
4. Under **Connection**, choose **Tunnel**.
5. Select the tunnel you created, or paste its `tunnel_id` when offered.
6. Enable the new app in a conversation.
7. First test: `Use my computer MCP's system.info tool and report the hostname and enabled capabilities.`

If the tunnel is not listed, verify its ChatGPT workspace association and **Tunnels Read + Use** permission.

## Status and uninstall

```sh
./scripts/tunnel-status.sh
```

The status command loads the saved runtime key itself and uses an ephemeral health listener, so you do not need to export `CONTROL_PLANE_API_KEY` manually just to run diagnostics.

Remove the persistent user service while leaving local config/secrets intact:

```sh
./scripts/tunnel-uninstall.sh
```

# Manual install / development

The repository pins pnpm 11.20.0. Corepack can force that exact version without `corepack enable`:

```sh
git clone https://github.com/alexcodeplace/chatgpt-mcp.git
cd chatgpt-mcp
corepack pnpm@11.20.0 install
corepack pnpm@11.20.0 gate
```

`pnpm gate` runs type checking, behavioral tests, and the TypeScript build.

If Corepack is unavailable, use `npx -y pnpm@11.20.0` instead.

## Configure manually

```sh
cp config.example.json config.local.json
export CHATGPT_MCP_CONFIG="$PWD/config.local.json"
```

The default configuration exposes only `system.info`. See [`config.example.json`](./config.example.json) for every capability family. `config.local.json` and `.secrets/` are gitignored.

For intentionally broad authority, copy [`config.full.example.json`](./config.full.example.json) instead.

## Start over stdio

```sh
corepack pnpm@11.20.0 build
CHATGPT_MCP_CONFIG="$PWD/config.local.json" node dist/src/stdio.js
```

stdout is reserved for MCP protocol traffic. Diagnostics go to stderr.

## Start over HTTP

```sh
corepack pnpm@11.20.0 build
CHATGPT_MCP_CONFIG="$PWD/config.local.json" corepack pnpm@11.20.0 start:http
```

Default endpoint:

```text
http://127.0.0.1:3210/mcp
```

Health check:

```sh
curl http://127.0.0.1:3210/healthz
```

HTTP remains stateless. A non-loopback bind is rejected unless allowed hosts are explicitly configured.

## Trust boundary

- Filesystem operations pass through central path authorization that rejects traversal, sibling-prefix tricks, and symlink escapes.
- `shell.exec` uses direct executable + argument-array spawning with no implicit `sh -c`.
- Services and applications are checked against configured authority before invocation.
- Browser schemes are validated before opening.
- Desktop input and screenshots are separate opt-in capabilities with bounded inputs/outputs.

See [`SPEC.md`](./SPEC.md) for the full contracts.

## Development

```sh
corepack pnpm@11.20.0 typecheck
corepack pnpm@11.20.0 test
corepack pnpm@11.20.0 build
corepack pnpm@11.20.0 gate
```

GitHub Actions runs the same gate on pushes and pull requests and syntax-checks the installer scripts.

## Platform limitations

- The concrete adapter is Linux-oriented.
- `process.list` uses `ps`.
- `service.*` defaults to systemd's `systemctl`.
- `input.*` uses `xdotool`; native Wayland may need XWayland or a future compositor-specific adapter.
- `screen.capture` supports common Linux screenshot commands; desktop/session permissions still apply.
- The automatic installer targets Linux amd64/arm64 and systemd user services.
- External ChatGPT/tunnel smoke requires the operator's own OpenAI tunnel identity/runtime credentials; repository CI cannot impersonate them.

## Upstream references

- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP specification: https://modelcontextprotocol.io/specification/2026-07-28
- OpenAI Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- OpenAI tunnel-client: https://github.com/openai/tunnel-client
- OpenAI tunnel management: https://platform.openai.com/settings/organization/tunnels
- OpenAI runtime API keys: https://platform.openai.com/settings/organization/api-keys
- ChatGPT Developer Mode: https://developers.openai.com/api/docs/guides/developer-mode
