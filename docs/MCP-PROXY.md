# MCP tool proxy

`chatgpt-mcp` can expose tools from other MCP servers alongside its computer tools.
A configured namespace named `godot` exposes `godot.<upstream-tool-name>`.
Namespaces are configuration, not product integrations: the same implementation
handles Godot, GitHub, Cloudflare and other MCP tool servers.

MCP tools are a flat catalogue, not a nested protocol object. Namespacing makes
upstream tools discoverable as sub-tools of the existing connector without adding
another public endpoint or a generic untyped `call` dispatcher.

## Godot AI

The machine running the upstream must have Godot AI installed. Editor operations
also require the Godot editor to be open with the Godot AI plugin enabled.
The proxy does not install the editor or invent a connection to a desktop on a
different machine.

### Existing Godot AI HTTP server on this machine

Merge this section into the configuration selected by `CHATGPT_MCP_CONFIG`.
Replace the absolute capability path with the actual path for the account running
Godot. The proxy does not expand `~` or shell variables in configuration values.

```json
{
  "proxy": {
    "upstreams": {
      "godot": {
        "transport": "http",
        "url": "http://127.0.0.1:8000/mcp",
        "headers": {
          "Authorization": {
            "file": "/home/you/.config/godot-ai/capabilities/http-8000.json",
            "jsonField": "http",
            "prefix": "Bearer "
          }
        },
        "connectTimeoutMs": 10000,
        "callTimeoutMs": 120000
      }
    }
  }
}
```

Godot AI rotates its HTTP capability when the server restarts. The proxy reads
this private record on every HTTP request; do not paste the token into the JSON
configuration or commit the capability file. A changed upstream session may
still require `proxy.refresh` after a server restart. Calls are never replayed.
Respect the plugin's existing directory/file permission checks.

### Godot AI's supported stdio attach bridge

For a local editor, use the exact launch command from the Godot AI dock's
**Run this manually** entry. Put its executable in `command` and each argument
in a separate `args` entry. A preinstalled bridge can look like this:

```json
{
  "proxy": {
    "upstreams": {
      "godot": {
        "transport": "stdio",
        "command": "/absolute/path/to/godot-ai",
        "args": ["attach", "--port", "8000", "--ws-port", "9500", "--disable-telemetry"],
        "connectTimeoutMs": 30000
      }
    }
  }
}
```

Use a bridge version compatible with the installed plugin. Installing or updating
packages is an operator action, not something triggered by a model-supplied tool
argument. A bridge on another machine can be reached by configuring `ssh` as the
stdio executable, with `-T`, `-o BatchMode=yes` and the dock's command as the remote
command. Use the same remote user as the editor and retain SSH host-key checking.
No change to the proxy implementation is required.

## Other upstreams

### Remote HTTP with a dedicated token

```json
{
  "proxy": {
    "upstreams": {
      "github": {
        "transport": "http",
        "url": "https://api.githubcopilot.com/mcp/",
        "headers": {
          "Authorization": { "env": "GITHUB_MCP_TOKEN", "prefix": "Bearer " }
        }
      },
      "cloudflare": {
        "transport": "http",
        "url": "https://YOUR-CONFIGURED-CLOUDFLARE-MCP-ENDPOINT/mcp",
        "headers": {
          "Authorization": { "env": "CLOUDFLARE_MCP_TOKEN", "prefix": "Bearer " }
        }
      }
    }
  }
}
```

The endpoint and authentication scheme must match the selected service. The
Cloudflare URL is intentionally a placeholder: its MCP services do not all have
the same endpoint or authorization contract. This proxy resolves pre-provisioned
credentials; it does not perform interactive OAuth authorization or refresh OAuth
tokens. An independently configured OAuth-capable stdio bridge can be proxied
instead. Neither example grants access by itself.

### Generic local process or legacy SSE server

```json
{
  "proxy": {
    "upstreams": {
      "local": {
        "transport": "stdio",
        "command": "/absolute/path/to/server",
        "args": ["--stdio"],
        "cwd": "/absolute/path/to/workspace",
        "env": { "LOG_LEVEL": "error" },
        "envFrom": ["LOCAL_MCP_API_KEY"]
      },
      "legacy": {
        "transport": "sse",
        "url": "https://example.com/sse"
      }
    }
  }
}
```

There is no automatic HTTP-to-SSE fallback. Select the upstream's actual
transport so a failed call cannot accidentally be replayed through another one.
Stdio commands are spawned directly without a shell. Only the SDK's minimal safe
environment, `env`, and explicitly named `envFrom` variables reach the child;
the server's full environment and downstream credentials are not inherited.

## Discovery and operation

After deploying/restarting `chatgpt-mcp` with the new configuration, rediscover
its tools in the client. The same connector now lists native tools such as
`system.info`, proxy controls, and each configured `<namespace>.<tool>`.
A client may cache its tool catalogue and need a connector refresh/reconnection.

`proxy.status` reports upstream namespace, transport, state, tool count and active
calls. It excludes command lines, URLs, file paths and credentials.
`proxy.refresh` accepts an optional `upstream` namespace, reconnects when necessary
and refreshes discovery. List tools again afterward. On a long-lived downstream
stdio connection, use this explicit refresh to update registered tools.

HTTP requests share runtime-owned upstream sessions. Successful discovery is
cached for 60 seconds; failed discovery has a 10-second retry cooldown. Upstream
list-change notifications invalidate the cache. Refresh bypasses the cooldown.
Disabled or unavailable upstreams do not remove the native computer tools.
Initial discovery can add up to the configured connection timeout to a request.
A failed refresh retains the last good tool catalogue, but calls report that the
upstream is unavailable instead of silently claiming success.

Tool arguments and output JSON schemas are preserved rather than converted to a
restricted schema subset. Input validation occurs before forwarding. Text,
images, structured output, metadata and tool-error results are forwarded through
the MCP SDK. Very long tool names receive a deterministic hash suffix to remain
within the 128-character tool-name limit.

## Limits and grants

Each upstream supports `enabled` (default true), `allowTools` (an exact-name
allowlist; absent means all eligible tools, an empty array means none),
`connectTimeoutMs` (10 seconds), `callTimeoutMs` (120 seconds), `maxConcurrent`
(4), and `maxTools` (512). At most 32 upstreams and 64 discovery pages per upstream
are accepted. Native namespaces and prototype-related keys cannot be reused.

The top-level `proxy` section supports `discoveryTtlMs`, `retryDelayMs` and
`maxResultBytes` (6 MiB by default). The byte limit bounds accepted catalogues and
returned tool results after SDK decoding; it is not a streaming HTTP memory limit.
Local stdio messages additionally use the SDK's 8 MiB input-buffer bound.

Only configured endpoints can receive requests. HTTP redirects and cross-origin
SSE message endpoints are rejected. Plain HTTP is accepted on loopback only;
`allowInsecureHttp: true` is an explicit owner opt-in for a non-loopback endpoint.
Prefer HTTPS or an SSH stdio bridge. Header names that control transport framing,
Host, cookies or MCP protocol/session headers cannot be configured.

Upstream capabilities are separate owner grants from the native filesystem/shell
permissions. Enabling a proxy can grant powerful actions even while native shell
access is disabled. Review upstreams and apply `allowTools` where appropriate.
All callers authorized to this `chatgpt-mcp` instance share its configured
upstream identity. This is not a multi-tenant credential-isolation service.
Upstream descriptions/results remain untrusted content; proxying is not a safety
review of the tools themselves.

Cancellation and deadlines are forwarded where the upstream transport supports
them. A timeout, disconnect or cancellation does not prove that a remote action
was rolled back. No tool call is automatically retried. Inspect the affected
system before deciding whether to invoke a mutating tool again.

## Scope

This is a **tool proxy**, not a transparent proxy for every MCP primitive.
Resources, prompts, server-to-client sampling, interactive elicitation, task APIs
and progress notifications are not forwarded. Tools requiring task-mode
execution are not exposed. Upstreams depending on those features need an adapter
or further implementation; the proxy does not advertise unsupported capabilities.

With no configured upstreams, the native tool catalogue is unchanged. Proxy
configuration is included in the existing hot-swap policy fingerprint, so adding
upstream grants must go through the managed deployment's policy-change path.

## Verification and deployment

`pnpm gate` runs type checking, all tests and the build. The focused suite is
`pnpm exec tsx --test test/proxy.test.ts`. Tests use real HTTP, SSE and child-process
stdio transports, not only mocked method calls.

The repository disallows GitHub-hosted artifact uploads. CI still verifies the
immutable runtime package with `scripts/release.py`; it does not retain a
GitHub Actions artifact. For deployment, build the exact passing revision in a
clean worktree, package it with `scripts/release.py pack`, verify its manifest,
and use the existing managed hot-swap flow. Do not replace a running checkout or
restart another agent's transport to activate a development build.

Primary references: the MCP transport/tool specifications and Godot AI's
`docs/client-configuration.md` in `hi-godot/godot-ai`.
