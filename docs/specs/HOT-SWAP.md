# Live backend replacement without an idle window

Status: owner-directed contract, 2026-09-15. Implementation and installed acceptance must be recorded below; this specification alone is not a completion receipt.

## Observable acceptance, first

Keep agents continuously reading, appending uniquely identified writes, executing uniquely identified commands, and using long-lived application/recording handles. Upgrade A to B and roll back B to A while at least one A request is deliberately held open. New ordinary calls must report B immediately after activation, held A calls must complete once, A handles and jobs must remain usable/cancellable, and B handles must remain usable after rollback. Tunnel and router PIDs must not change. No owner coordination, global idle check, retry of uncertain mutations, or waiting for old handles to disappear is allowed.

## Ownership and boundaries

The existing MCP SDK, tool schemas, policy enforcement, adapters, durable job workers and K3s executor remain authoritative. Add a small persistent local HTTP router and a private Unix-socket control API. Overdeck's existing workstation/mcp manager owns release selection, staging, activation and host/VM convergence. workstation/agent-vm's existing QGA transport delivers the same manager to the guest. No direct guest-only installation, VM reboot, duplicate tunnel poller, new scheduler, broad service restart, or credential transfer.

A generation identifies a *process incarnation*, not merely a source revision or port. Registry state contains its revision, instance identity, immutable artifact path, URL and lifecycle. Active selection is a compare-and-swap epoch persisted atomically before acknowledgement. Candidate registration probes actual runtime identity, compatible routing/job ABI, same capability configuration (excluding transport port), and readiness. The existing isolated candidate canaries run before publication. Failed/stale candidates leave the active route unchanged.

Each request captures its generation once. Subsequent activation/rollback never alters that request, closes its socket, or retries its body. Ordinary requests after the activation linearization point use the active generation. Only owner-directed follow-up operations use draining generations. This is not session stickiness: new work in an old agent session must use the new backend.

## Handles, jobs, cancellation

Application and recording handle results acquire an opaque versioned owner envelope at the router. The raw handle stays only at its owning backend. The router unwraps follow-up handles, routes to that exact generation, and never probes a destructive operation across backends. Wrong-kind, malformed or unknown owners fail explicitly. New backend requests carry an expected incarnation header; a restarted process at a reused URL must refuse before executing. Resource inventory is read-only, authenticated, and reports actual adapter ownership, not inferred idle time. Natural process exit can release ownership. Outstanding recordings remain owned until finalized or explicitly reconciled, including failure.

Durable jobs keep their existing identifiers, on-disk reservation, worker identity and immutable worker executable. All compatible generations use the same ledger ABI and directory. Duplicate operation IDs must not launch duplicate commands across versions. Job status/output/cancel may be served by a compatible backend; the worker, not that backend, owns execution. Changing ledger ABI or capability policy incompatibly refuses activation rather than migrating live state. In-use artifacts are never pruned.

HTTP response disconnection cancels only that request's upstream exchange. Legacy notifications/cancelled are matched by authenticated/session scope plus the typed JSON-RPC request ID; an ambiguous ID never cancels other agents. Unknown/completed cancellation is harmless. A router-generated unique exchange identifier avoids backend request-ID collisions. The router never treats an upgrade as cancellation. An already-started mutation with a transport failure returns an explicit unknown outcome; exactly-once claims do not extend to arbitrary network/process/power failures. No transparent retry is permitted, including ECONNRESET.

A retired backend is stoppable only after it is neither active nor the rollback target, has zero routed in-flight calls, and its authenticated inventory proves no owned resources. Unknown inventory, legacy ownership, outstanding jobs using its artifact, or failed observation retain it. No age-based forced drain. Retirement is explicit and race-checked; capacity pressure is visible, not permission to kill owners.

A capability-policy change remains incompatible with ordinary hot activation. It may cross the routing boundary only through an explicit maintenance cutover after the desired candidate has passed all normal private canaries. The controller pauses the existing tunnel and ingress main processes without replacing their PIDs, proves router in-flight count is zero, stops only the internal router, atomically persists the desired capability configuration plus a registry selecting the candidate, and restarts that router before resuming ingress/tunnels. The cross-policy registry deliberately has no normal previous rollback target; old generations remain retained only for opaque owner follow-ups. A failed maintenance cutover restores the old registry and router capability file before ingress/tunnels resume. Ordinary same-policy hot swaps keep the no-router-restart contract.

## Continuous legacy adoption

The current tunnel targets a backend directly and has no verified live-target reload. Restarting it after an idle sample has an admission race and does not satisfy this contract. The first installation therefore must not use that old cutover.

The Linux/Node legacy adoption seam installs a minimal forwarding listener in the *existing* HTTP server without stopping it. Already-dispatched listeners and responses keep running. New requests, including requests on existing keep-alive sockets, enter the persistent router. Owner follow-ups to the legacy backend use a private authenticated bypass and the captured original handler. Untagged pre-adoption handles remain assigned to the adopted legacy generation, never to a replacement. Legacy ownership is unenumerable and retained conservatively.

Attach is narrowly scoped to the enrolled PID and expected loopback listener, verifies the running executable and revision before use, loads only verified immutable bridge code, and must close any inspector it temporarily opened. A pre-existing inspector or unexpected listener/runtime shape refuses safely before mutation. The bridge is idempotent and must have a reproducible startup preload installed by Overdeck, not an untracked live patch. The old listener becomes retained ingress/legacy ownership; it is not killed by backend release convergence. Failure leaves the original listener intact. No raw debugger expressions, credential values or inspected application data enter logs. Integration tests must prove attach during an active command and on an existing keep-alive connection before this seam may be used live. Unsupported platforms keep an explicit unsupported-adoption result; they must not fall back to a disruptive restart.

## Control, observability and security

The control socket and registry are user-owned private files. MCP ingress cannot invoke administrative routes. Validate Host, Origin, bearer credentials, methods, path, body size, generation identity, numeric ports and response bounds. Strip all caller-supplied internal routing headers. Control registration accepts only loopback backends; no generic open proxy. Preserve SDK protocol headers and JSON responses; reject unsupported routing-affecting batch forms before execution rather than splitting mutations.

Status reports active/previous generation, epoch, source/PID identities, per-generation in-flight calls and handle counts, retained legacy ingress, validation failures and last activation. Never log arguments, output, secrets or sensitive job requests. Backend-only upgrades change no tunnel profile, tunnel unit, identity, credential, or PID. Router implementation upgrades are a distinct maintenance operation, not silently coupled to backend releases.

Rollback is an atomic selection of a still-running validated previous generation. It never rewinds files, job ledgers or external side effects. Calls/handles created on the rolled-back generation retain their owner. Activation is serialized under the existing manager/recovery ownership lock and uses the router epoch to reject stale writers. Recovery must not restart a healthy tunnel or a resource-owning backend merely because another generation is unhealthy. Never claim convergence from a staged artifact or queued sync.

## Required verification and delivery

Focused deterministic tests: epoch conflicts, failed validation, registration/activation rollback, owner envelope handling, malformed/auth/oversize input, ambiguity-safe cancellation, no retry after uncertain downstream response, incarnation mismatch, registry reopen, explicit safe retirement and resource leaks/refusal. Fault injection covers failed persistence and candidate death before activation.

Real integration: at least two real MCP HTTP backends, a real persistent router, real filesystem and child processes, held requests/barriers (not arbitrary sleeps), concurrent read/write/exec through A -> B -> A, old/new handles, durable jobs and cancellation. Verify exact command/write markers occur once and old backend requests remain active at the instant new backend calls succeed. Legacy attach must be exercised in a separate child with a real open request and existing keep-alive connection. Test startup preload and idempotent redeployment. Preserve backend/tunnel separation with installer tests that poison restart/wait-idle seams.

Run builds/tests in K3s with exact source and receipts. Produce the upstream immutable release through its existing packer, land source, update Overdeck's single pin, land manager changes, and deploy through Overdeck to enrolled host and VM. Installed proof uses the actual connector path and second normal sync with unchanged tunnel/router PIDs, profile/config hashes and active revision. Record exact revisions, artifacts, commands and unverified cases. No DONE before that evidence exists.

## Implementation record

The implementation uses `src/hotswap/` plus the existing HTTP server, adapters,
durable job store and recovery controller. `scripts/deploy-hot.py` owns staging
and selection; the Overdeck workstation MCP module publishes its pin and deploys
the same verified manager to the guest through the existing VM transport.

September 16 verification identified and fixed two additional lifecycle defects:
request cancellation must remain rooted in the native HTTP response rather than
weak intermediate SDK Request objects, and the inspector WebSocket must fully
disconnect before its synchronous shutdown runs on the backend event loop. The
one-shot finalization capability closes only the exact inspector opened for that
adoption; it cannot close a later owner debugger. Forced-GC, recorded process,
rollback, compiled-runtime and owner-debugger refusal tests cover these seams.

Release acceptance runs in `.github/workflows/gate.yml`; the corresponding
immutable artifact is admitted only from the successful exact-revision run.
`scripts/hot-live-proof.py` runs installed read/write/execute traffic during
normal Overdeck synchronization and checks rollback, durable cancellation,
unchanged tunnel/router PIDs and a verified no-op second apply. Actual deployment
receipts live under `~/.local/state/overdeck/mcp/` on each enrolled target. An
unexecuted or failed receipt is not installed acceptance. Desktop capture remains
a separate capability: synthetic recording bytes prove owner routing and process
finalization, not live screen capture or permission to enable a disabled desktop.
