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

Architecture: [`SPEC.md`](./SPEC.md). Detailed ChatGPT/tunnel guide: [`docs/CHATGPT.md`](./docs/CHATGPT.md).

## Reliability updates and existing installations

For an existing installation, use the identified blue/green release workflow in [Reliability operation](docs/RELIABILITY.md), not an in-place reinstall. The initial installer preserves configuration and pins tunnel-client 0.0.14. The upgrade path additionally verifies an immutable runtime, tests a candidate, coordinates recovery, switches tunnels with rollback protection, and leaves the previous backend's active work untouched.

Long operations can use opt-in durable `exec.start/status/output/cancel/list` tools. `fs.replace` provides atomic expected-hash file replacement without changing legacy `fs.write` semantics. `system.info.runtime` identifies the actual running release and configuration. [Desktop-agent update instructions](docs/DESKTOP-UPDATE.md) cover local Linux/systemd rollout when the desktop connector is unreachable.

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
| `app.launch` | Launch a configured named application on a caller-selected X11 `DISPLAY` |
| `app.close` | Close an application previously launched through its handle |
| `browser.open` | Open an allowed URL scheme on a caller-selected X11 `DISPLAY` |
| `screen.capture` | Capture a caller-selected X11 `DISPLAY` as a PNG MCP image; requires `desktop.hostDisplayAccess` |
| `screen.record.start` | Start asynchronous MP4 recording of a caller-selected X11 `DISPLAY`; returns a recording handle |
| `screen.record.stop` | Stop/finalize a recording handle and return its path/size/duration |
| `input.move` | Move the pointer on a caller-selected X11 `DISPLAY`; requires `desktop.hostDisplayAccess` |
| `input.click` | Click the pointer on a caller-selected X11 `DISPLAY`; requires `desktop.hostDisplayAccess` |
| `input.type` | Type literal text into the focused application on a caller-selected X11 `DISPLAY` |
| `input.key` | Send a key sequence to the focused application on a caller-selected X11 `DISPLAY` |

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
- initializes the `chatgpt-computer` tunnel profile against `http://127.0.0.1:3210/mcp`;
- installs a shared `chatgpt-mcp.service` HTTP backend with automatic restart;
- installs a profile-specific `chatgpt-mcp-tunnel-<profile>.service`, so multiple tunnels are independently supervised;
- assigns each profile its own loopback tunnel health port and installs a 15-second watchdog that repairs an unhealthy local backend or tunnel;
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

You want to see `MCP HTTP service: ACTIVE`, `MCP HTTP health: OK`, `Tunnel readiness: OK`, the profile-specific tunnel service and watchdog timer as `ACTIVE`, and `RESULT ok` from `tunnel-client doctor`.

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
- **`OUTPUT_LIMIT` on a very large command/file/image result**: this is intentional. Tool responses are kept below a transport-safe budget so OpenAI Tunnel does not turn an oversized response into an opaque HTTP 413/connector failure. Split large reads or command output into smaller chunks.

OpenAI changes the ChatGPT plugin/app UI over time. The current OpenAI developer-mode guidance is linked under [Upstream references](#upstream-references).

## Status and uninstall

```sh
./scripts/tunnel-status.sh
```

The status command loads the saved runtime key itself and uses an ephemeral health listener, so you do not need to export `CONTROL_PLANE_API_KEY` manually just to run diagnostics.

Remove one profile-specific tunnel service and watchdog while leaving the shared MCP backend and local config/secrets intact:

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
python3 -m unittest discover -s test -p '*_test.py' -v
```

`pnpm gate` runs type checking, behavioral tests, and the TypeScript build.

If Corepack is unavailable, use `npx -y pnpm@11.20.0` instead.

## Configure manually

```sh
cp config.example.json config.local.json
export CHATGPT_MCP_CONFIG="$PWD/config.local.json"
```

The default configuration exposes only `system.info`. See [`config.example.json`](./config.example.json) for every capability family. `config.local.json` and `.secrets/` are gitignored.

`desktop.hostDisplayAccess` is a master grant for access to graphical sessions. Every display-dependent MCP call (`app.launch`, `browser.open`, `screen.capture`, `screen.record.start`, and all `input.*` tools) requires an explicit `display` argument such as `":0"` or `":99"`. The MCP service explicitly strips inherited `DISPLAY`/Wayland/Mir routing, the launcher does not set a default `DISPLAY`, and the MCP server has no implicit GUI-display selection for these tools: the requested value is injected into that operation's child-process environment without mutating the server's `process.env`, so one server can safely target multiple X11 displays concurrently. Inherited Wayland/Mir routing variables are removed for these explicitly X11-targeted operations. The selected display is echoed in structured tool results for observability.

`screen.record.start` returns immediately with a handle and PID instead of blocking for the recording duration. This allows subsequent input/browser/application calls—or additional recordings on other displays—to proceed concurrently. `screen.record.stop` sends FFmpeg a graceful interrupt so the MP4 trailer is finalized, then returns the output path, byte size, display, and elapsed duration. Recording paths must be inside configured writable filesystem roots, use `.mp4`, and not already exist. Duration, output size, and concurrent recording count are bounded by `desktop.maxRecordingSeconds`, `desktop.maxRecordingBytes`, and `desktop.maxRecordings`.

`desktop.hostDisplayAccess` is a master grant for access to the workstation's graphical session. When false, `screen.capture`, screen recording, desktop input, application launching, and browser opening are omitted even if their subordinate flags are true. `shell.exec` children also have `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `MIR_SOCKET`, and `DBUS_SESSION_BUS_ADDRESS` removed, callers cannot add those variables back through the tool's `env` parameter, and a defense-in-depth guard rejects common screenshot executables plus high-signal FFmpeg/GStreamer/D-Bus/Python/JavaScript capture invocations.

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

### Concurrency and overload protection

The HTTP backend uses one process-wide admission controller shared by every stateless MCP request. The default policy allows 48 active tool operations, reserves 8 slots for control/observability work, limits local `shell.exec` to 8 active commands, and bounds the waiting queue at 64 requests for at most 30 seconds. Two local shell slots are reserved for short interactive work whenever the local shell pool is large enough, so explicitly long-running commands cannot monopolize every shell slot. When the queue is full or a queue wait expires, the tool returns `OVERLOADED` locally instead of allowing resource growth to destabilize the backend or tunnel. MCP cancellation removes queued work; cancellation, timeout, and output-limit termination for `shell.exec` kill the complete POSIX process group.

A shell call without `timeoutMs` uses `shell.defaultRuntimeMs` (30 seconds by default, capped by `shell.maxRuntimeMs`). A caller that explicitly requests more than the short default is admitted as long-running local shell work. `concurrency.reservedInteractiveShellSlots` keeps capacity available for short calls while long work is active; its default is 2 when `shellMaxConcurrent` permits it. This makes commands such as a multi-minute `kubectl wait` opt in to the long-running pool instead of silently occupying an interactive slot for the full shell maximum.

The defaults can be changed through the `concurrency` object in the JSON configuration. Keep `reservedControlSlots < maxConcurrent`, `shellMaxConcurrent <= maxConcurrent - reservedControlSlots`, and `reservedInteractiveShellSlots < shellMaxConcurrent`.

### Optional Kubernetes execution

`chatgpt-mcp` is local-only by default. The optional `execution.kubernetes` backend can move explicitly eligible `shell.exec` calls into isolated Kubernetes pods, while filesystem, process, service, application, browser, desktop, and non-routed shell operations retain the existing local-host semantics. Kubernetes support is distribution-neutral: K3s is supported, but no K3s, Tailscale, node-name, namespace, registry, CNI, storage-class, or hostPath assumption is compiled into the package.

The backend is opt-in: `execution.kubernetes.enabled` defaults to `false`, `execution.defaultBackend` is `local`, and an empty `remoteCommands`/`heavyCommandPatterns` set routes nothing remotely. With Kubernetes disabled, startup does not invoke or probe `kubectl`; existing configuration files remain local-only.

#### Generic command policies

`execution.commandPolicies` is an ordered, backend-neutral policy layer for commands submitted through MCP. Rules are evaluated before executable resolution for both `shell.exec` and durable `exec.start`; the first matching rule wins. A rule can match the raw `command`, the request `cwd`, and/or a canonical `invocation`. Each matcher is a JavaScript regular-expression string. The canonical invocation is `JSON.stringify([command, ...args])`, so argument boundaries are deterministic even when an argument contains whitespace or shell punctuation.

Actions are `allow`, `route`, and `deny`. `allow` forces normal local execution and stops legacy routing. `route` selects either `local` or `kubernetes`; an explicit Kubernetes route is fail-closed if that backend is disabled, has no image, or (for `shell.exec`) the request has no explicit `cwd`. `deny` returns `COMMAND_NOT_ALLOWED` with the configured message and the matching `ruleId`. No deployment-specific command names, cluster conventions, or blocker text are compiled into the package.

```json
{
  "execution": {
    "commandPolicies": [
      {
        "id": "remote-analysis",
        "match": { "invocation": "(?:typecheck|lint|test)" },
        "action": { "type": "route", "backend": "kubernetes" }
      },
      {
        "id": "block-local-watchers",
        "match": { "invocation": "(?:--watch|dev|serve)" },
        "action": {
          "type": "deny",
          "message": "This workload is disabled on this host. Use the configured remote runner instead."
        }
      }
    ]
  }
}
```

If no command policy matches, the existing `localOnlyCommands`, `remoteCommands`, and `heavyCommandPatterns` behavior is preserved for backward compatibility. Policies see the MCP request itself; they cannot retroactively inspect arbitrary grandchildren hidden behind an allowed wrapper, so deployments that permit opaque wrapper commands should match those wrappers or add a host-side execution backstop.

All deployment details are configuration, including the Kubernetes client command/arguments, kubeconfig/context, namespace, executor image and pull policy/secrets, service account, remote/local-only routing rules, remote concurrency, workspace path/excludes/archive limit, resource requests/limits, node selectors, tolerations, labels/annotations, volumes/mounts, startup/cleanup limits, required commands/environment, and optional executable-version checks. Keep installation-specific values such as private registry names, cluster contexts, Tailscale addresses, and node labels in an untracked/private `config.local.json`, not in public defaults.

Remote execution requires an explicit `cwd`. The authorized working directory is copied as a bounded tar snapshot into an isolated pod workspace; generated changes are not synchronized back. This makes remote execution appropriate for builds, tests, analysis, and other disposable compute, not for commands intended to mutate the authoritative workstation tree. Explicit `localOnlyCommands` always win over remote routing and unknown commands remain local.

Local and remote shell execution have distinct admission pools. `concurrency.shellMaxConcurrent` controls total local shell concurrency; the long-running local subset is additionally capped at `shellMaxConcurrent - reservedInteractiveShellSlots`. `execution.kubernetes.maxConcurrent` controls remote shell concurrency. All pools still share the global non-control budget and the reserved control slots. `/metrics` reports interactive local, long-running local, and remote shell occupancy separately along with routing, output-byte, duration, and Kubernetes lifecycle counters.

Command output is spooled to bounded temporary files rather than accumulated as unbounded chunk arrays in Node memory. `execution.lightweightTimeoutMs` and `execution.lightweightOutputBytes` provide conservative limits for short helper operations; explicit shell runtime/output limits remain governed by the existing `shell` configuration.

Local `shell.exec` process-tree isolation is also opt-in through `execution.localIsolation`. When enabled on a systemd user session, each local command runs in its own transient service with independent `TasksMax`, `MemoryMax`, and `CPUWeight` controls. The MCP daemon remains outside that command cgroup, and completion, timeout, cancellation, or output-limit cleanup stops the entire transient unit. Environment values are inherited by name rather than embedded in the transient-service command line. Public/default behavior remains unchanged because local isolation defaults to disabled.

Operational endpoints:

```text
GET /healthz  process liveness; remains healthy while busy
GET /readyz   capacity state; returns 503 only when the admission queue is full
GET /metrics  JSON limits, active/queued counts, peaks, and overload/cancellation counters
```

The installer also applies conservative systemd containment to the shared backend (`TimeoutStopSec=5`, `TasksMax=512`, `LimitNOFILE=65536`, `MemoryHigh=6G`, `MemoryMax=9G`, `CPUWeight=80`). HTTP shutdown gives in-flight connections two seconds to drain before they are force-closed, preventing a restart from hanging behind a large request backlog. These are last-resort host guardrails; normal overload should be handled by admission control first. The tunnel watchdog intentionally checks `/healthz`, not `/readyz`, so a healthy busy server is never restarted merely for being saturated.

## Credentials and command output

Authorized commands may use local API keys, deployment tokens, and other credentials under the same filesystem, shell, and environment grants as any other data. The MCP does not apply secret-value output redaction. `fs.read`, `shell.exec`, tool errors, process metadata, URLs, and durable command output are returned as produced by the authorized adapter, subject only to the existing capability, byte, transport, and retention limits.

Durable job requests remain private on disk while pending: request files use restrictive permissions and are deleted by the worker before execution. Durable stdout and stderr are stored in the private job ledger and returned verbatim through `exec.output` until retention expires. Operators should therefore grant only the filesystem roots, commands, environment access, and services they intend the connected client to observe.

This behavior is deliberately transparent: credential-looking strings are not rewritten, credential files are not specially censored, and `system.info.runtime` does not advertise a redaction layer. Upstream platform safety controls, OS permissions, filesystem blocklists, shell policy, and MCP capability grants remain separate controls.

## Filesystem blocklist

`filesystem.blocklist` can protect the direct entries of selected directories while leaving existing project contents writable. It is an accidental-destruction guard, not a shell sandbox.

With `mode: "freeze-children"`, native MCP filesystem mutations reject creation, deletion, rename, or move of a direct entry in the protected directory. `shell.exec` also checks direct `mkdir`, `rmdir`, and `rm` invocations for the same protected entries. Ordinary commands, GUI/browser/input tools, and work inside existing projects remain available.

Crucially, enabling this policy does **not** enable systemd isolation, sudo, `deck-sudo`, mount namespaces, or privilege escalation. `execution.localIsolation.enabled` is the only switch that selects the systemd-isolated executor. If it is `false`, `shell.exec` always uses normal user-level process execution.

Routine `shell.exec` is also authentication-noninteractive: direct `sudo`, `su`, and `pkexec` are refused, SSH runs in batch mode, and credential/askpass UI is disabled. Explicit `deck-sudo` remains available when the deployment intentionally provides it. This prevents agents from surfacing root/password dialogs while preserving owner-authorized noninteractive privilege paths.

This guard deliberately does not claim to stop arbitrary language runtimes or custom wrappers from mutating the filesystem. Use normal OS permissions/snapshots for a hard security boundary.


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
python3 -m unittest discover -s test -p '*_test.py' -v
```

GitHub Actions runs the same TypeScript gate, Python recovery/deployment fault tests, and installer syntax checks on pushes and pull requests. Dependencies install from the frozen lockfile.

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

Remote workspace configuration may define `prepareCommands` as trusted executable-plus-argument arrays. They default to empty and run inside the isolated pod after snapshot/parity checks. Each preparation command may include `whenFiles`, a list of relative workspace paths that must all exist before that command runs. This lets deployments restore project dependencies only for matching workspaces, without shell interpretation, path traversal, or changing public local-only defaults.

The optional Kubernetes backend also exposes `idleCommand` as a deployment configuration array (default `['sleep', 'infinity']`). Deployments that require an init/reaper process may configure an explicit argument array such as `['/usr/bin/tini', '--', 'sleep', 'infinity']`; no shell interpolation is used.
