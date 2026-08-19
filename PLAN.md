# ChatGPT Computer MCP — Implementation Plan

**Status:** Active implementation plan  
**Authoritative design:** [`SPEC.md`](./SPEC.md)  
**Target protocol:** MCP `2026-07-28`

## 1. Delivery strategy

Build the smallest usable stateless computer-action MCP first, pin its trust-boundary behavior with tests, then deepen the adapter surface only after the core seam is proven.

Order of work:

1. scaffold the TypeScript/Node package and development gates;
2. define config, error, policy, and `ComputerAdapter` seams;
3. implement the local adapter for system/filesystem/shell/process operations;
4. register MCP tools from the adapter + capability policy;
5. expose stateless HTTP and stdio transports from the same MCP factory;
6. prove policy isolation and stateless request behavior with automated tests;
7. document local and ChatGPT/tunnel use;
8. only then add desktop/service/browser capabilities.

The implementation must not introduce hidden client/session state as a shortcut.

---

## 2. Phase 0 — Package foundation

### Deliverables

- `package.json`
- `tsconfig.json`
- `.gitignore`
- `.editorconfig`
- `src/` entrypoints
- test runner setup
- lint/typecheck/build/test scripts

### Decisions

- Node.js 22+
- TypeScript
- ESM-only
- `pnpm`
- strict TypeScript
- Node built-ins whenever possible
- MCP TypeScript SDK v2
- Zod 4 for boundary schemas

### Package scripts

Target commands:

```text
pnpm build
pnpm typecheck
pnpm test
pnpm gate
pnpm start:http
pnpm start:stdio
pnpm dev:http
```

### Exit criteria

- clean install;
- `pnpm typecheck` runs;
- `pnpm test` runs;
- `pnpm build` produces runnable ESM output.

---

## 3. Phase 1 — Typed internal seams

### 3.1 Configuration

Create one immutable validated configuration shape.

Modules:

```text
src/config.ts
src/config.test.ts
```

Implement:

- safe defaults;
- JSON config-file loading;
- environment overrides;
- HTTP host/port/token;
- filesystem roots + byte limits;
- shell allow-list + runtime/output limits;
- process capabilities;
- log level.

Fail closed on malformed configuration.

### 3.2 Error contract

Modules:

```text
src/errors.ts
src/errors.test.ts
```

Implement a structural `ComputerAdapterError` shape and guard with stable codes from the spec.

Do not make cross-module correctness depend on `instanceof`.

### 3.3 ComputerAdapter seam

Modules:

```text
src/adapter/computer-adapter.ts
```

Define the smallest explicit contract required by milestone-1 tools:

- `systemInfo`
- `listDirectory`
- `readFile`
- `writeFile`
- `makeDirectory`
- `movePath`
- `deletePath`
- `exec`
- `listProcesses`
- `killProcess`

Inputs/outputs remain host-neutral and contain no MCP SDK types.

### Exit criteria

- seam compiles without importing MCP;
- config and errors have behavioral tests;
- public adapter signatures are explicit and documented by types.

---

## 4. Phase 2 — Trust-boundary policy

This phase is completed before exposing mutation tools.

### 4.1 Filesystem policy

Modules:

```text
src/policy/filesystem.ts
src/policy/filesystem.test.ts
```

Implement one canonical path authorization function used by all consumers.

Prove:

- path inside root succeeds;
- `../` escape fails;
- sibling-prefix tricks fail (`/allowed2` is not `/allowed`);
- existing symlink escape fails;
- creation under a symlinked ancestor cannot escape;
- multiple configured roots work;
- root itself is valid.

### 4.2 Shell policy

Modules:

```text
src/policy/shell.ts
src/policy/shell.test.ts
```

Implement:

- executable allow-list;
- explicit wildcard support only when configured;
- timeout clamping;
- output-limit clamping;
- cwd authorization through the filesystem policy.

No shell-string parsing belongs here.

### Exit criteria

Every filesystem/shell operation can call one policy seam and does not duplicate authorization logic.

---

## 5. Phase 3 — LocalComputerAdapter

Modules:

```text
src/adapter/local-computer-adapter.ts
src/adapter/local-computer-adapter.test.ts
```

### 5.1 System

Use Node `os` and process primitives for:

- hostname;
- platform;
- architecture;
- release;
- uptime;
- cwd.

### 5.2 Filesystem

Use Node `fs/promises` and `path`.

Behavior:

- run filesystem authorization before every operation;
- cap file reads;
- cap writes;
- identify entry types without following unsafe symlinks;
- deterministic create/overwrite/append semantics;
- return structured operation results.

### 5.3 Shell execution

Use `child_process.spawn` with:

```text
shell: false
```

Implement:

- executable validation before spawn;
- argument-array execution;
- authorized cwd;
- bounded env merge;
- bounded stdout/stderr capture;
- deterministic timeout termination;
- elapsed duration;
- non-zero exit as a normal execution result.

Do not introduce `exec()` or shell interpolation for the milestone-1 tool.

### 5.4 Processes

Prefer standard Linux process information first because the initial machine is Linux.

Implementation may use a direct `ps` invocation behind the adapter. Normalize its result into the host-neutral seam.

`killProcess` uses the Node process signal primitive where possible.

### Exit criteria

Tests execute only against temporary directories and disposable child processes. Nothing in tests writes into the real home/project directories.

---

## 6. Phase 4 — MCP tool surface

Modules:

```text
src/tools/register-tools.ts
src/tools/system.ts
src/tools/filesystem.ts
src/tools/shell.ts
src/tools/process.ts
src/tools/tools.test.ts
```

If splitting by domain adds ceremony before the code warrants it, begin with `register-tools.ts` and split once it becomes materially easier to navigate.

### Tools

Implement milestone 1 exactly as specified:

- `system.info`
- `fs.list`
- `fs.read`
- `fs.write`
- `fs.mkdir`
- `fs.move`
- `fs.delete`
- `shell.exec`
- `process.list`
- `process.kill`

### Rules

- Zod validates every input;
- disabled capabilities are omitted from tool registration where practical;
- tool handlers call `ComputerAdapter`, not Node OS APIs;
- structured content is returned for machine-readable values;
- destructive/read-only annotations are accurate;
- adapter errors are mapped centrally.

### Exit criteria

An in-process MCP client/test can list and invoke enabled tools and cannot invoke disabled capabilities.

---

## 7. Phase 5 — Stateless MCP transports

### 7.1 Server factory

Modules:

```text
src/server.ts
```

Create one factory that accepts immutable config + adapter and returns a newly configured MCP server.

The factory owns tool registration only. It owns no protocol session state.

### 7.2 HTTP transport

Modules:

```text
src/http.ts
src/http.test.ts
```

Implement stateless MCP `2026-07-28` over Streamable HTTP.

Requirements:

- `/mcp` endpoint;
- `/healthz` endpoint;
- default `127.0.0.1:3210`;
- optional bearer token;
- Origin validation;
- new server instance per request via SDK v2 serving factory;
- no app-generated `Mcp-Session-Id`;
- no sticky-session assumption.

Tests must execute multiple independent MCP requests and prove no session identifier is required for correctness.

### 7.3 stdio transport

Modules:

```text
src/stdio.ts
src/stdio.test.ts
```

Use the SDK v2 stateless stdio server helper.

Ensure:

- diagnostics go to stderr;
- stdout remains protocol-only;
- identical adapter/config/tool factory is used.

### Exit criteria

Both transport entrypoints expose the same effective tools under the same configuration.

---

## 8. Phase 6 — Documentation and operator UX

### Deliverables

```text
README.md
docs/CHATGPT.md
config.example.json
```

### README requirements

Document:

1. what the project is;
2. architecture;
3. stateless-vs-session rationale;
4. prerequisites;
5. clone/install/build;
6. configuration;
7. local HTTP start;
8. stdio start;
9. tool catalogue;
10. capability restriction examples;
11. unrestricted-owner configuration example;
12. security/trust-boundary behavior without repetitive generic warnings;
13. development/test commands;
14. current limitations.

### `docs/CHATGPT.md`

Provide the shortest actionable route for ChatGPT:

```text
computer -> chatgpt-mcp -> local MCP endpoint -> Secure MCP Tunnel -> ChatGPT Developer Mode
```

Include exact commands from current official OpenAI documentation after verifying the current CLI/tunnel syntax during implementation.

Do not freeze speculative tunnel commands into docs before verification.

### Exit criteria

A fresh-machine operator can get from clone to a working local MCP test using only repository docs.

---

## 9. Phase 7 — Integration verification

Run the full gate and a manual smoke test.

### Automated gate

```text
pnpm gate
```

Must cover:

- TypeScript;
- unit/behavioral tests;
- build;
- local HTTP MCP smoke test.

### Manual local smoke

Verify:

1. `system.info`;
2. `fs.list` inside an allowed temp/test root;
3. rejected read outside root;
4. `fs.write` then `fs.read`;
5. allowed `shell.exec`;
6. rejected command;
7. `process.list`;
8. no MCP session ID dependency.

### ChatGPT/tunnel smoke

When tunnel credentials/setup are available:

1. expose loopback MCP through the private tunnel;
2. connect it in ChatGPT Developer Mode;
3. list tools;
4. invoke a read-only tool;
5. invoke one configured write/action tool;
6. confirm returned structured data and local side effect match.

If this external smoke cannot be executed from CI/development context, record it as a documented operator validation rather than pretending it ran.

---

## 10. Phase 8 — Desktop and service capabilities

Only begin after milestone 1 is green.

Candidate Linux adapter additions:

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

Before each capability lands:

1. define its typed adapter contract;
2. define policy configuration;
3. define MCP schema;
4. add behavioral tests;
5. document host dependencies (`systemd`, Wayland/X11 tooling, portal, etc.).

Do not bake Linux-specific command shapes into the MCP tool schema when a host-neutral concept is possible.

---

## 11. Implementation wave map

### Wave A — Foundation

- package scaffold
- config
- errors
- adapter seam
- policies
- tests

**Gate:** typecheck + policy tests.

### Wave B — Core computer actions

- LocalComputerAdapter
- system/filesystem/shell/process tools
- adapter/tool tests

**Gate:** all trust-boundary and core action tests.

### Wave C — Protocol serving

- MCP server factory
- stateless HTTP
- stdio
- protocol tests

**Gate:** independent stateless calls + stdio smoke.

### Wave D — Operator path

- README
- ChatGPT/tunnel guide
- example config
- end-to-end local smoke

**Gate:** `pnpm gate` + documented smoke results.

### Wave E — Capability expansion

- service/app/browser/screen/input adapters

**Gate:** capability-specific behavioral tests.

---

## 12. Engineering constraints

These are mandatory throughout implementation.

### Keep the seam strict

- MCP types stop at the tool boundary.
- OS implementation details stop at `ComputerAdapter`.
- Policy authorization is centralized.
- Configuration is immutable after startup.

### Keep implementation shallow

- no service/repository/controller layering around a direct Node primitive;
- no dependency for functionality available cleanly in Node built-ins;
- no class unless lifecycle/state makes a class materially clearer;
- no speculative plugin/provider registry in milestone 1.

### Keep state explicit

- no correctness logic keyed by MCP client/session;
- long-running resources return explicit opaque handles;
- handles are passed back explicitly on later calls;
- bounded registries get cleanup/limits before they are introduced.

### Fail closed at the trust boundary

- malformed config prevents startup;
- ambiguous path authorization rejects;
- disabled capability rejects/does not register;
- unknown executable rejects when an allow-list is active;
- output/runtime limits clamp rather than trust caller values.

---

## 13. Initial file set

Expected first implementation wave:

```text
.gitignore
.editorconfig
package.json
tsconfig.json
config.example.json
src/config.ts
src/errors.ts
src/policy/filesystem.ts
src/policy/shell.ts
src/adapter/computer-adapter.ts
src/adapter/local-computer-adapter.ts
src/server.ts
src/tools/register-tools.ts
src/http.ts
src/stdio.ts
test/config.test.ts
test/filesystem-policy.test.ts
test/shell-policy.test.ts
test/local-computer-adapter.test.ts
test/tools.test.ts
test/http.test.ts
README.md
docs/CHATGPT.md
```

This list is a target, not permission to create empty architecture. Consolidate files while modules are shallow; split them when the interface becomes materially clearer.

---

## 14. Definition of done for milestone 1

Milestone 1 is done only when all of the following are true:

- [ ] MCP `2026-07-28` is the canonical implemented protocol.
- [ ] HTTP requests do not depend on server-side MCP sessions.
- [ ] HTTP binds loopback by default.
- [ ] stdio uses the same MCP server factory/tool semantics.
- [ ] `ComputerAdapter` contains no MCP SDK types.
- [ ] filesystem root restrictions are symlink-aware and tested.
- [ ] command allow-list is enforced before spawn.
- [ ] shell execution defaults to `shell: false`.
- [ ] execution timeout is bounded and tested.
- [ ] stdout/stderr capture is bounded and tested.
- [ ] capability-disabled tools cannot execute.
- [ ] malformed configuration fails closed.
- [ ] all milestone-1 tools have behavioral tests.
- [ ] `pnpm gate` is green.
- [ ] README documents full local setup.
- [ ] ChatGPT/tunnel guide uses verified current OpenAI setup instructions.
- [ ] manual local smoke result is recorded accurately.

---

## 15. First implementation action

Begin with **Wave A**, not the MCP handlers.

The first code commit should establish:

1. package/build/test scaffold;
2. validated immutable config;
3. structural error seam;
4. `ComputerAdapter` types;
5. filesystem and shell policy with behavioral tests.

This pins the authority boundary before any real computer mutation is reachable through MCP.
