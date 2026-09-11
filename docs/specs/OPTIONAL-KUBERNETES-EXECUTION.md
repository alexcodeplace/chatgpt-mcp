# Optional Kubernetes Execution Backend

## Status

Implementation specification for an opt-in remote execution backend. The public/default product remains local-only. K3s is one supported Kubernetes distribution, not a hard-coded deployment assumption.

## Goals

1. Reduce MCP host CPU/RAM pressure by moving explicitly eligible heavy `shell.exec` work to Kubernetes-scheduled pods.
2. Preserve the existing MCP tool names, schemas, success/error shapes, security policy, cancellation semantics, output limits, and local-host operations.
3. Keep lightweight and host-sensitive operations local.
4. Separate local-shell and remote-shell admission pools so remote dispatches do not consume scarce local-heavy shell capacity.
5. Reduce peak MCP memory by spooling command output to bounded temporary storage rather than retaining all stdout/stderr chunks in memory.
6. Add per-execution metrics/resource attribution and shorter configurable deadlines for lightweight operations.
7. Reduce unnecessary stateless MCP server allocation where this can be done without changing protocol behavior.
8. Make Kubernetes support completely optional, configurable, portable, and absent from default execution.

## Non-goals

- Kubernetes must not be required to install, start, or use chatgpt-mcp.
- The installer must not install `kubectl`, probe a cluster, create namespaces, or mutate Kubernetes unless explicitly requested/configured.
- Public defaults must not contain private hostnames, Tailscale addresses, cluster contexts, node names, namespaces, registries, paths, or credentials.
- `debian1`, `debian2`, and `debian3` are deployment details of one installation and MUST NOT appear in generic runtime logic or default config.
- Kubernetes is not allowed to silently take over commands. If the remote backend is disabled or a command is not explicitly eligible, execution remains local.

## Configuration model

A new top-level `execution` section is optional. Its parsed default is local-only. Example shape:

```json
{
  "execution": {
    "defaultBackend": "local",
    "lightweightTimeoutMs": 30000,
    "local": {
      "maxConcurrent": 8
    },
    "kubernetes": {
      "enabled": false,
      "kubectlCommand": "kubectl",
      "kubeconfig": null,
      "context": null,
      "namespace": "default",
      "image": null,
      "serviceAccount": null,
      "remoteCommands": [],
      "localOnlyCommands": [],
      "heavyCommandPatterns": [],
      "maxConcurrent": 24,
      "workspace": {
        "mode": "snapshot",
        "containerPath": "/workspace",
        "exclude": []
      },
      "resources": {
        "requests": {},
        "limits": {}
      },
      "nodeSelector": {},
      "tolerations": [],
      "podLabels": {},
      "ttlSecondsAfterFinished": 300,
      "startupTimeoutMs": 60000,
      "cleanupTimeoutMs": 15000,
      "requiredCommands": [],
      "requiredEnvironment": {},
      "versionChecks": {}
    }
  }
}
```

Exact field names may evolve during implementation, but the following are mandatory configuration surfaces:

- enable/disable
- Kubernetes client executable/API access configuration
- kubeconfig and context
- namespace
- image
- service account
- command routing allow-list/rules
- local-only routing overrides
- remote concurrency
- workspace transfer strategy and excludes
- CPU/memory requests and limits
- node selector and tolerations
- labels/annotations required by an installation
- job/pod startup and cleanup timeouts
- TTL/cleanup behavior
- required executable/tool parity checks
- optional version parity checks

No cluster-specific value is compiled into the package.

## Routing semantics

`execution.defaultBackend` remains `local` by default. Kubernetes routing requires all of:

1. `execution.kubernetes.enabled === true`;
2. a configured image;
3. the command is explicitly eligible by routing configuration; and
4. the command is not classified host-sensitive/local-only.

Host-sensitive operations always remain local, including workstation service/process management, browser/application/desktop operations, and commands that depend on local sockets or host-specific state. `fs.*`, `process.*`, `service.*`, `app.*`, `browser.*`, and desktop tools retain their current local adapter semantics. Only eligible `shell.exec` calls are remotely dispatched in this milestone.

An explicit local-only command list takes precedence over all remote rules. Unknown commands remain local. There is no implicit "all shell commands go to Kubernetes" mode in the public default.

## Workspace semantics

Remote commands must execute against an isolated snapshot of the requested `cwd`; they must never run directly against a shared mutable project tree by default.

The default opt-in remote workspace mode is `snapshot`:

1. create a uniquely named pod;
2. let the Kubernetes scheduler place it;
3. transfer the authorized working tree into an isolated container workspace using a bounded tar stream;
4. execute the requested command in that workspace;
5. capture bounded stdout/stderr and execution metadata;
6. clean up the pod in a `finally` path.

Generated files are not synchronized back unless a future explicit output-sync feature is configured. Commands that intentionally mutate the authoritative workstation tree therefore remain local.

## Tool and configuration parity

The MCP tool surface presented to ChatGPT remains determined by the normal chatgpt-mcp configuration, not by the Kubernetes image. Enabling Kubernetes MUST NOT add, remove, or rename MCP tools.

Before a deployment is eligible for cutover, a parity gate MUST verify:

- exact MCP tool-name set
- exact tool input/output schemas
- effective capability flags from `system.info`
- effective filesystem/shell/process/service/application/browser/desktop policy
- concurrency policy
- output and timeout policy
- Kubernetes remote command allow-list
- required executables inside the configured pod image
- configured executable versions when version checks are supplied

A mismatch is a cutover blocker, not a warning.

## Admission control

The concurrency controller gains distinct shell classes:

- local shell
- remote/Kubernetes shell

Remote dispatches use a separately configurable pool and MUST NOT consume the local-shell ceiling. Both still count toward the global non-control budget unless a later measured design justifies a separate top-level budget. Reserved control slots remain available regardless of either shell pool.

Queue scanning must remain work-conserving: a saturated local-shell pool cannot head-of-line block a startable remote request, and vice versa.

## Output memory

Local and remote command execution must share a bounded capture abstraction that spools output to temporary files while counting bytes. It may materialize the final response only after the command finishes and only if within the configured response limit.

Requirements:

- no unbounded stdout/stderr arrays in Node memory
- shared byte budget across stdout and stderr
- kill full local process group or remote pod when output limit is exceeded
- remove temporary output files on success, failure, timeout, cancellation, and process shutdown
- preserve the existing `OUTPUT_LIMIT` API behavior

The public default shell output limit should be reduced to a conservative value only if compatibility testing shows no regression; otherwise retain the current default and document smaller recommended values. Existing explicit configurations must continue to work.

## Deadlines

Add a configurable lightweight-operation deadline used for short local operations where no tool-specific longer timeout applies. Heavy/remote work retains explicit shell runtime policy. Cancellation always wins over timeout.

## Metrics/resource accounting

`/metrics` must expose enough information to distinguish MCP overhead from child/remote work, including at minimum:

- active/queued local shell
- active/queued remote shell
- routing decision counters (local, remote, forced-local, fallback/error)
- output bytes captured/spooled
- execution duration totals/peaks
- Kubernetes pod create/start/execute/cleanup outcomes
- remote node/pod identity when available in per-operation logs (not required in aggregate metrics)

No credential or kubeconfig contents may be exposed.

## Protocol/server allocation

The HTTP transport currently creates stateless MCP server objects per request. Implementation should reuse immutable tool definitions/shared adapter/router/concurrency state and avoid redundant per-request allocation where supported by the SDK. This optimization must be benchmarked and must not introduce cross-request/session state leakage. If the SDK requires one server object per stateless request, keep that boundary and optimize only safe shared components rather than violating protocol semantics.

## Kubernetes portability

The implementation targets the Kubernetes API contract, not K3s-specific behavior. It must be usable with K3s, upstream Kubernetes, and compatible managed clusters as long as the configured client/context can create/delete pods and exec into them.

The implementation MUST NOT assume:

- a Tailscale network
- any specific node hostname
- a specific CNI
- a specific storage class
- a private registry
- hostPath availability
- privileged pods
- fixed node labels

Deployment-specific selectors, tolerations, images, service accounts, caches, registries, and networking are configuration.

## Failure behavior

- Kubernetes unavailable before dispatch: return a bounded remote-execution error; do not hang the MCP.
- Pod unschedulable/start timeout: delete pod and fail boundedly.
- Request cancellation: terminate remote exec and delete pod.
- Runtime timeout: delete pod and return timeout semantics.
- Output overflow: terminate/delete pod and return `OUTPUT_LIMIT`.
- MCP restart: orphan cleanup must be deterministic by labels/TTL; startup may reap expired owned pods.
- Remote backend disabled/misconfigured: server still starts local-only unless the operator explicitly selected a configuration mode that requires remote execution.

## Cutover safety

No production tunnel is moved until all unit/integration/cluster gates pass. Rollout is connector-by-connector:

1. Keep current production backend untouched.
2. Run candidate backend on a separate local port with Kubernetes enabled.
3. Verify parity against current production and run load/failure tests.
4. Repoint only the `overdeck-vm` tunnel to the candidate backend.
5. Observe real activity and verify health, metrics, parity, cancellation, remote scheduling, and no configuration drift.
6. Keep `Overdeck` on the old backend during this soak.
7. Only after the VM profile passes, repoint `Overdeck` to the same proven candidate.
8. Preserve a one-command rollback to the previous backend endpoint/config for each tunnel.
9. Never arm overlapping rollback timers.

The backend itself remains locally available for host-sensitive tools; Kubernetes is the optional heavy-shell executor. This preserves existing computer-control semantics while removing heavy compute from the MCP host.

Remote workspace configuration may define `prepareCommands` as trusted executable-plus-argument arrays. They default to empty and run inside the isolated pod after snapshot/parity checks. Each preparation command may include `whenFiles`, a list of relative workspace paths that must all exist before that command runs. This lets deployments restore project dependencies only for matching workspaces, without shell interpretation, path traversal, or changing public local-only defaults.

The optional Kubernetes backend also exposes `idleCommand` as a deployment configuration array (default `['sleep', 'infinity']`). Deployments that require an init/reaper process may configure an explicit argument array such as `['/usr/bin/tini', '--', 'sleep', 'infinity']`; no shell interpolation is used.
