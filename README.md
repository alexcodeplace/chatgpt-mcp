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

Every family except `system.info` is opt-in. Disabled capability families are omitted from MCP tool discovery where practical. Desktop-facing capabilities also require the master `desktop.hostDisplayAccess` grant.

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
| `screen.capture` | Capture the desktop as a PNG MCP image; requires `desktop.hostDisplayAccess` |
| `input.move` | Move the desktop pointer; requires `desktop.hostDisplayAccess` |
| `input.click` | Click the desktop pointer; requires `desktop.hostDisplayAccess` |
| `input.type` | Type literal text into the focused application |
| `input.key` | Send a key sequence to the focused application |

## Requirements

Core server:

- Linux
- Node.js 22+
- pnpm **11.20.0** (the installer obtains the pinned version through Corepack or `npx`)
- systemd user services for the persistent MCP HTTP backend and tunnel profiles installed by `./install.sh`

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
        | loopback HTTP
        v
systemd-supervised chatgpt-mcp
```

No public inbound listener is required.

The quick installer intentionally uses [`config.full.example.json`](./config.full.example.json), which grants broad owner-controlled access: filesystem read/write from `/`, wildcard executable access, process/service control, browser opening, host-display access, screenshots, and desktop input where supported. If you want narrower authority, use `config.example.json` and the manual setup instead.

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
git clone https://github.com/platform-modules/chatgpt-mcp.git
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
- initializes the `chatgpt-computer` tunnel profile against `http://127.0.0.1:3210/mcp`;
- installs a shared `chatgpt-mcp.service` HTTP backend with automatic restart;
- installs a profile-specific `chatgpt-mcp-tunnel-<profile>.service`, so multiple tunnels are independently supervised;
- uses an ephemeral loopback tunnel health port so concurrent profiles do not collide on port 8080;
- runs `tunnel-client doctor --explain` against the supervised HTTP backend;
- verifies both services and the HTTP health endpoint.

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

## 4. Create the ChatGPT plugin

First confirm the local tunnel is healthy:

```sh
./scripts/tunnel-status.sh
```

You want to see `MCP HTTP service: ACTIVE`, `MCP HTTP health: OK`, the profile-specific tunnel service as `ACTIVE`, and `RESULT ok` from `tunnel-client doctor`.

Then, in **ChatGPT web**:

1. Enable **Developer mode** in ChatGPT settings. The exact settings location can vary as the ChatGPT UI changes.
2. Open the ChatGPT Plugins page directly: **https://chatgpt.com/plugins**
3. Click the **`+`** button to create a new developer plugin.
4. In the **New Plugin** dialog, use these values:
   - **Name:** `ChatGPT-MCP`
   - **Description:** optional; for example, `Access to my Linux workstation through chatgpt-mcp.`
   - **Connection:** `Tunnel`
   - **Available tunnels:** select the tunnel created in step 1. If it is not listed, use **Use tunnel ID instead** and enter the `tunnel_...` ID.
   - **Authentication:** `No Auth`
5. Do **not** choose OAuth. `chatgpt-mcp` does not implement an MCP-server OAuth flow; the OpenAI runtime API key already authenticates `tunnel-client` to the tunnel control plane.
6. Check **I understand and want to continue** after reviewing the custom-MCP warning.
7. Click **Create**.

Use the plugin name **`ChatGPT-MCP`** in this guide and for normal installations. Do not use the earlier example name `My Computer`.

After creation, start a chat and select **ChatGPT-MCP** from the ChatGPT tools/plugin menu, or refer to it directly in the prompt if your UI offers it. A first read-only test is:

```text
Use ChatGPT-MCP's system.info tool and report the hostname and enabled capabilities.
```

Then test filesystem discovery without changing anything:

```text
Use ChatGPT-MCP to list my Projects directory. Do not modify anything.
```

### If plugin creation fails

- **`does not implement OAuth`**: set **Authentication** to **No Auth**.
- **Tunnel not listed**: verify the tunnel is associated with the ChatGPT workspace/account you are using and that the relevant Platform principal has **Tunnels Read + Use**.
- **Generic `Error creating connector`**: first confirm `./scripts/tunnel-status.sh` still reports `ACTIVE` and `RESULT ok`, then retry creation using the exact plugin name **`ChatGPT-MCP`** and **No Auth**.

OpenAI changes the ChatGPT plugin/app UI over time. The current OpenAI developer-mode guidance is linked under [Upstream references](#upstream-references).

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
git clone https://github.com/platform-modules/chatgpt-mcp.git
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

`desktop.hostDisplayAccess` is a master grant for access to the workstation's graphical session. When false, `screen.capture`, desktop input, application launching, and browser opening are omitted even if their subordinate flags are true. `shell.exec` children also have `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `MIR_SOCKET`, and `DBUS_SESSION_BUS_ADDRESS` removed, callers cannot add those variables back through the tool's `env` parameter, and a defense-in-depth guard rejects common screenshot executables plus high-signal FFmpeg/GStreamer/D-Bus/Python/JavaScript capture invocations.

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
- Host-display access is a separate master capability; desktop input/screenshots cannot execute unless it is granted.
- With host-display access denied, shell children do not inherit the normal desktop/session environment and cannot re-add those variables through MCP input.
- Desktop input and screenshots remain separate subordinate opt-in capabilities with bounded inputs/outputs.

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
- `hostDisplayAccess=false` also blocks common screenshot CLIs and obvious one-shot capture payloads (for example FFmpeg `x11grab`, GStreamer `ximagesrc`, screenshot D-Bus APIs, Python `pyautogui`/PIL/mss, and common Node/Electron capture APIs). This is a defense-in-depth denylist, not a security sandbox.
- Wildcard `shell.exec` remains arbitrary same-user code execution; deliberately obfuscated or custom native code can bypass denylist heuristics. Use VM/container/OS isolation for hostile workloads.
- The automatic installer targets Linux amd64/arm64 and systemd user services.
- External ChatGPT/tunnel smoke requires the operator's own OpenAI tunnel identity/runtime credentials; repository CI cannot impersonate them.

## Upstream references

- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP specification: https://modelcontextprotocol.io/specification/2026-07-28
- OpenAI Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- OpenAI tunnel-client: https://github.com/openai/tunnel-client
- OpenAI tunnel management: https://platform.openai.com/settings/organization/tunnels
- OpenAI runtime API keys: https://platform.openai.com/settings/organization/api-keys
- ChatGPT Plugins page: https://chatgpt.com/plugins
- ChatGPT Developer Mode / MCP apps: https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta
