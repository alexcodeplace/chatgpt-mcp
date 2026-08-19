# ChatGPT Computer MCP — Specification

**Status:** Canonical initial specification  
**Protocol target:** MCP `2026-07-28`  
**Runtime:** Node.js 22+, TypeScript, ESM  
**Primary deployment:** private/local computer reachable from ChatGPT through an MCP connection/tunnel

## 1. Purpose

`chatgpt-mcp` is a thin MCP server that gives ChatGPT a controlled, typed interface for taking actions on a computer.

The server is intentionally a protocol adapter, not an orchestration system. ChatGPT decides what action to request; the MCP server validates the request against its exposed capability policy and delegates it to a local `ComputerAdapter` implementation.

The owner decides what the server can do by configuration. The server does not add a second interactive approval workflow of its own.

## 2. Goals

1. Expose useful computer operations to ChatGPT as MCP tools.
2. Use the current stateless MCP protocol (`2026-07-28`) as the canonical protocol contract.
3. Keep protocol transport, tool definitions, policy, and computer implementation separate.
4. Make the first usable deployment require only Node.js plus this repository.
5. Bind network serving to loopback by default so it can be paired with a private tunnel without exposing the machine directly.
6. Permit precise capability restriction by tool, filesystem root, command, service, or application without requiring code changes.
7. Keep all continuity explicit: if an operation needs later continuation, return a handle that a later request supplies explicitly.
8. Keep the MCP layer portable so additional adapters (remote agent, Windows, macOS, container, SSH, etc.) can be added without changing the public tool contract.

## 3. Non-goals

The first version will not:

- implement an autonomous planner or agent loop;
- maintain hidden per-ChatGPT sessions;
- mirror an entire shell protocol into MCP;
- implement an interactive approval UI;
- depend on a public inbound port;
- invent a second RPC protocol between the MCP server and its in-process local adapter;
- promise cross-platform GUI automation in the initial milestone.

## 4. Protocol architecture

### 4.1 Canonical protocol

The canonical protocol revision is MCP `2026-07-28`.

This revision is stateless at the protocol layer:

- no `initialize` / `initialized` handshake is required;
- no `Mcp-Session-Id` is part of the modern protocol contract;
- request identity/capabilities travel with each request;
- every Streamable HTTP JSON-RPC message is its own POST;
- state required by an operation must be represented explicitly rather than stored as implicit MCP session state.

Reference:

- https://modelcontextprotocol.io/specification/2026-07-28
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md

### 4.2 Primary transport: stateless Streamable HTTP

The primary transport is Streamable HTTP on one `/mcp` endpoint.

Requirements:

- use the MCP TypeScript SDK v2 `createMcpHandler(factory)` serving model;
- create a fresh MCP server instance per request;
- bind to `127.0.0.1` by default;
- accept POST on `/mcp`;
- validate `Origin` when present;
- do not create or depend on protocol sessions;
- do not require sticky routing or shared MCP session storage.

Default endpoint:

```text
http://127.0.0.1:3210/mcp
```

The port is configurable.

### 4.3 Secondary transport: stdio

A stdio entrypoint is provided for local MCP hosts and tunnel clients that spawn a command directly.

It must use the v2 `serveStdio(factory)` entry so modern MCP connections use the 2026 protocol. The same tool factory is shared with HTTP.

Stdio is a transport compatibility option; it must not introduce different tool semantics or hidden state.

### 4.4 Legacy protocol compatibility

The implementation may accept the SDK's stateless legacy compatibility mode where it costs no additional architecture, but all project code is written against the modern `2026-07-28` semantics.

There will be no application code that relies on legacy `initialize`, server-side MCP sessions, unsolicited server-to-client RPC, or `Mcp-Session-Id`.

## 5. Architecture

```text
ChatGPT / MCP host
       |
       | MCP 2026-07-28
       v
+---------------------------+
| transport                 |
| HTTP / stdio              |
+-------------+-------------+
              |
              v
+---------------------------+
| MCP tool layer            |
| schemas + result mapping  |
+-------------+-------------+
              |
              v
+---------------------------+
| capability policy         |
| allow / scope / limits    |
+-------------+-------------+
              |
              v
+---------------------------+
| ComputerAdapter           |
| typed implementation seam |
+-------------+-------------+
              |
              v
+---------------------------+
| LocalComputerAdapter      |
| Node / OS primitives      |
+---------------------------+
```

### 5.1 Strict seam rule

The MCP package must not mix JSON-RPC/SDK details into the local computer implementation.

`ComputerAdapter` is the internal typed seam. Tool handlers depend on this seam, not on `child_process`, `fs`, desktop commands, or operating-system details directly.

A future adapter swap must not require changing MCP tool names or schemas unless the public capability itself changes.

## 6. Statelessness contract

No correctness-critical mutable state may be associated implicitly with an MCP client/session.

Allowed process state:

- immutable parsed configuration;
- bounded caches that do not alter semantics;
- explicit resource registries keyed by opaque handles returned to the caller, when a capability genuinely represents a long-running OS resource.

If an operation needs continuity, the result must return an explicit handle, for example:

```json
{
  "processHandle": "proc_01J..."
}
```

A later call must provide that handle explicitly. The handle is application state, not an MCP session identifier.

Initial synchronous tools should avoid handles where possible.

## 7. Tool contract

Tool names use a stable dotted namespace. Inputs and outputs are structured and machine-readable. Human-readable text may be included but must not be the only result representation where structured data is practical.

### 7.1 Milestone 1 tools

#### `system.info`

Read basic host/runtime information.

Returns at minimum:

- hostname;
- platform;
- architecture;
- OS release;
- uptime;
- current working directory;
- configured capability summary.

#### `fs.list`

List one directory.

Input:

- `path` — absolute path or path under an allowed root.

Output entries include:

- name;
- type (`file`, `directory`, `symlink`, `other`);
- size where applicable;
- modification time.

#### `fs.read`

Read a text file.

Input:

- `path`;
- optional byte limit.

The implementation must reject files outside configured roots and must cap response size.

#### `fs.write`

Write a UTF-8 text file.

Input:

- `path`;
- `content`;
- optional mode: `create`, `overwrite`, or `append`.

The implementation must reject paths outside configured roots.

#### `fs.mkdir`

Create a directory.

Input:

- `path`;
- optional `recursive` boolean.

#### `fs.move`

Move/rename a filesystem entry.

Input:

- `source`;
- `destination`.

Both sides must be inside configured roots.

#### `fs.delete`

Delete a file or directory.

Input:

- `path`;
- optional `recursive` boolean.

#### `shell.exec`

Execute one local command and wait for completion.

Input:

- `command` — executable name;
- `args` — argument array;
- optional `cwd`;
- optional `env` additions;
- optional `timeoutMs`.

The tool intentionally takes an executable plus argument array rather than a shell command string. The implementation uses direct process spawning with `shell: false` by default.

Output:

- exit code;
- stdout;
- stderr;
- duration;
- timeout flag.

Output size and runtime are bounded by configuration.

#### `process.list`

List visible processes using the host adapter.

Output includes a stable subset where available:

- PID;
- parent PID;
- user;
- command/executable;
- arguments.

#### `process.kill`

Send a signal to a PID.

Input:

- PID;
- optional signal.

### 7.2 Milestone 2 tools

The following are part of the intended public surface but are not required for the first implementation commit:

- `service.status`
- `service.control`
- `app.launch`
- `app.close`
- `browser.open`
- `screen.capture`
- `input.click`
- `input.move`
- `input.type`
- `input.key`

OS-specific behavior for these tools belongs behind `ComputerAdapter` implementations.

### 7.3 Tool annotations

Where the MCP SDK supports tool behavior annotations, tools should accurately declare read-only/destructive/idempotent properties. These annotations are descriptive metadata, not the authorization mechanism.

## 8. Capability policy

Configuration defines the actual authority exposed by one running server.

The MCP tool list should contain only enabled capabilities where practical; disabled capabilities must never execute.

Example configuration shape:

```json
{
  "filesystem": {
    "read": true,
    "write": true,
    "roots": ["/home/alex/projects", "/home/alex/Downloads"],
    "maxReadBytes": 1048576,
    "maxWriteBytes": 4194304
  },
  "shell": {
    "enabled": true,
    "allowedCommands": ["git", "node", "pnpm", "npm", "python3", "bash"],
    "maxRuntimeMs": 120000,
    "maxOutputBytes": 4194304
  },
  "process": {
    "list": true,
    "kill": true
  }
}
```

`allowedCommands: ["*"]` may be supported as an explicit owner choice.

Desktop-facing authority has a master `desktop.hostDisplayAccess` boolean. `screen.capture`, desktop input, configured application launch, and configured browser opening require this master grant in addition to their own family flags. When it is denied, shell children must not inherit host graphical-session environment such as `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `MIR_SOCKET`, or `DBUS_SESSION_BUS_ADDRESS`, and caller-provided environment input must not be allowed to reintroduce those values.

No hard-coded interactive confirmation step is inserted after policy authorization. The permission boundary is the combination of ChatGPT/plugin permissions plus this server's configured capabilities.

## 9. Filesystem path rules

Filesystem access is a trust-boundary concern and must be enforced centrally.

Requirements:

1. normalize and resolve requested paths before use;
2. compare resolved paths against resolved allowed roots;
3. prevent `..` traversal from escaping a root;
4. account for symlinks when accessing existing paths so a symlink cannot silently escape an allowed root;
5. for creation paths, validate the nearest existing ancestor before creation;
6. never duplicate root-check logic independently across tools.

The filesystem policy implementation is a single reusable module used by every filesystem operation and by `cwd` validation for `shell.exec`.

## 10. Command execution rules

`shell.exec` uses `spawn`/equivalent with `shell: false` by default.

Requirements:

- executable allow-list is checked before spawn;
- `cwd`, when provided, must satisfy configured filesystem/shell roots;
- execution timeout is bounded by server configuration;
- stdout/stderr are bounded to prevent unbounded memory use;
- child termination on timeout is deterministic;
- caller-provided environment entries are merged only when allowed by configuration;
- when host-display access is denied, graphical-session environment is removed from child processes and attempts to provide it explicitly are rejected;
- command result is returned even for non-zero exit status; infrastructure/policy failures use MCP tool errors.

A later explicit `shell.execShell` capability may permit shell-string execution, but it must be separately configurable and must not be silently folded into `shell.exec`.

## 11. Configuration

Configuration precedence:

1. explicit CLI arguments;
2. environment variables;
3. JSON config file;
4. safe defaults.

Initial environment variables:

- `CHATGPT_MCP_CONFIG` — config file path;
- `CHATGPT_MCP_HOST` — HTTP bind host, default `127.0.0.1`;
- `CHATGPT_MCP_PORT` — HTTP port, default `3210`;
- `CHATGPT_MCP_TOKEN` — optional bearer token for the HTTP endpoint;
- `CHATGPT_MCP_LOG_LEVEL` — `silent|error|warn|info|debug`.

Configuration is parsed once at process startup and treated as immutable.

## 12. HTTP boundary

For the local default:

- bind to `127.0.0.1`;
- reject invalid `Origin` headers;
- expose only `/mcp` plus a minimal `/healthz` endpoint;
- never expose directory listings or static files from the HTTP server;
- if `CHATGPT_MCP_TOKEN` is configured, require `Authorization: Bearer <token>` on `/mcp`;
- non-loopback binding must require explicit configuration.

The server must be compatible with being placed behind a private MCP tunnel. Tunnel/auth details are deployment concerns and do not alter tool behavior.

## 13. Errors

Internal seam errors use one structural shape:

```ts
interface ComputerAdapterError {
  code: string;
  message: string;
  operation: string;
  details?: Record<string, unknown>;
}
```

Cross-module checks must use structural guards rather than relying on `instanceof` identity.

Stable initial error codes include:

- `CAPABILITY_DISABLED`
- `PATH_NOT_ALLOWED`
- `COMMAND_NOT_ALLOWED`
- `INVALID_INPUT`
- `NOT_FOUND`
- `TIMEOUT`
- `OUTPUT_LIMIT`
- `OS_ERROR`

MCP tool handlers map these errors to concise tool failures without leaking secrets from configuration or environment variables.

## 14. Logging and observability

Diagnostics go to stderr, never stdout in stdio mode.

Each operation log should include:

- operation/tool name;
- request correlation identifier when available;
- duration;
- outcome/error code;
- non-secret target metadata useful for diagnosis.

Logs must not dump file contents, command output, environment variables, bearer tokens, or arbitrary request bodies by default.

## 15. Project layout

Target layout:

```text
src/
  config.ts
  errors.ts
  policy/
    filesystem.ts
    shell.ts
  adapter/
    computer-adapter.ts
    local-computer-adapter.ts
  tools/
    register-tools.ts
    filesystem.ts
    shell.ts
    system.ts
    process.ts
  server.ts
  http.ts
  stdio.ts

test/
  filesystem-policy.test.ts
  local-adapter.test.ts
  tools.test.ts
  http.test.ts
```

The layout may stay smaller while the implementation is small. Empty/speculative layers must not be created merely to match this diagram.

## 16. Dependencies

Runtime dependencies should remain minimal.

Expected initial dependencies:

- `@modelcontextprotocol/server` v2;
- `@modelcontextprotocol/node` v2 for Node HTTP adaptation if required by the chosen serving implementation;
- `zod` v4 for tool/config schemas.

Node built-ins are preferred for filesystem, process, HTTP, path, and OS operations.

## 17. Testing requirements

Before the first usable release, automated tests must prove at least:

1. server tool discovery exposes enabled tools;
2. disabled tools cannot execute;
3. filesystem reads/writes within a configured temporary root work;
4. traversal outside a root is rejected;
5. symlink escape is rejected;
6. allowed command execution works;
7. disallowed command execution is rejected;
8. timeout terminates a command;
9. output is bounded;
10. modern stateless HTTP can perform independent requests without a session identifier;
11. stdio starts without writing diagnostics to stdout;
12. malformed configuration fails closed at startup.

Tests must use temporary directories/processes and must not modify the developer's real home directory.

## 18. Documentation requirements

`README.md` must explain:

- prerequisites;
- installation;
- configuration;
- starting HTTP and stdio transports;
- connecting from ChatGPT / an MCP tunnel;
- example tool requests;
- how to expand or reduce granted capabilities;
- how to run tests;
- current platform limitations.

`docs/CHATGPT.md` should provide the shortest ChatGPT-specific setup path.

## 19. Milestone-1 acceptance criteria

Milestone 1 is complete when a user can:

1. clone the repository;
2. install dependencies;
3. create a local configuration granting selected roots/commands;
4. start the server on loopback;
5. connect an MCP client using the `2026-07-28` protocol;
6. discover the configured tools;
7. read/write an allowed test file;
8. execute an allowed command;
9. receive a structured result;
10. demonstrate that an out-of-root path and a disallowed executable are rejected;
11. run the automated test suite successfully.

## 20. Design decisions that require a spec change

The following changes are architectural and must update this specification before implementation:

- adding hidden MCP session state;
- changing the canonical MCP protocol era away from `2026-07-28`;
- replacing explicit adapter handles with implicit client/session continuity;
- making a public inbound listener the default deployment;
- changing the public tool namespace/schema incompatibly;
- moving OS-specific logic into MCP handlers instead of the adapter seam;
- adding an internal interactive approval workflow as a mandatory execution step.
