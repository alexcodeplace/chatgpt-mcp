# VM reliability release acceptance, September 13, 2026

## Released identity

The active VM runtime is source revision `8ebbb709ad907938a59baddfbaba2b4b6449bf3b`, incorporated into main by PR #7, following implementation PR #5 and acceptance-fix PR #6. The final verification checkout began at merge commit `8cbf5d6`. Runtime source must be identified through `~/.config/chatgpt-mcp/active.json` and `system.info.runtime`, not the old mutable runtime checkout.

- Backend unit: `chatgpt-mcp-runtime-8ebbb709ad90.service`.
- Backend address: `http://127.0.0.1:3212`.
- Identified release: `~/.local/share/chatgpt-mcp-releases/8ebbb709ad907938a59baddfbaba2b4b6449bf3b`.
- Deployment evidence: `~/.local/state/chatgpt-mcp/deployments/8ebbb709ad90-4e912051/`.
- Both tunnel processes execute `~/.local/lib/tunnel-client/0.0.14/tunnel-client`, version `0.0.14+0f870e50a973fa820d4c409000059e181e8d242b`.

The older `~/.local/bin/tunnel-client` remains a legacy executable. Its `--version` output does not identify the executable running either supervised tunnel. Check the service's actual executable, not the first PATH match. The new installer and launchers use the pinned binary explicitly.

## Acceptance performed

The guarded rollout committed at 08:27:11 UTC on September 13. Each profile demonstrated fresh polling after its individual cutover. The independent rollback timer is inactive after successful commit.

A fresh frozen-dependency gate was rerun on debian1 from the final source tree:

- TypeScript typecheck, 142 tests, and production compilation passed, with zero failures, cancellations, or skipped tests.
- All 28 Python behavioral tests passed, including recovery fixtures, rollback, manifest verification, and native systemd-unit parsing.
- Shell syntax checks passed.
- Buildbox evidence: `/tmp/chatgpt-mcp-final-20260913/final-gate.log` and `final-gate.exit` (0).

The immutable release manifest verified 2,202 files. The dependency-lock SHA-256 is `ea3d3ca66d47de98bee8df55a9d1f9d5c533a052bc7645338e78e72ada49ad1c`.

The deployment's `canary-results.json` records successful filesystem lifecycle, atomic stale-hash conflict rejection, durable duplicate-ID handling, cancellation, and a systemd job surviving a real candidate-backend restart. Candidate job tests used a private staging ledger, not the production ledger. A final post-staging probe checked actual shell execution and filesystem operations against the loaded production configuration before accepting the release.

Live connector verification after rollout confirmed the exact runtime revision and all previously granted capabilities. A fresh connector write/read canary was verified and its temporary file deleted. A durable job was submitted through the bridge, allowed to finish, and then submitted again with the identical operation ID and arguments. The second request returned the original completed record and output rather than executing again. Its retained job ID is `97d1da7e0a238489b840609e79bfd8c5b1f372544e25d690ca64876e1eb12f67`.

`final-verification.json` in the deployment directory records the additional live evidence, including fresh polling on both profiles, the verified running tunnel executable versions, backend execution canaries, and zero controller restart-budget usage at final observation. Client-visible calls were verified through the connector available to this conversation; both profiles' control-plane polling was independently checked. Those are distinct statements, not a claim to have tested delivery through both accounts' ChatGPT sessions.

## Recovery and preservation

The two legacy watchdog timers are disabled. One shared recovery controller and timer own backend and per-profile recovery. The active release and both tunnel profiles were healthy, with no recovery restarts required during final verification.

The earlier backend units are disabled for future boot but deliberately remain running. Inspection found actual `Xvfb` and `display` processes in both retired service cgroups. Stopping those units would terminate user display resources. No VM reboot, browser restart, permission widening, or automatic configuration restoration was performed. Do not remove those units merely because they are not the active MCP route.

## Desktop update boundary

The desktop connector returned `tunnel_client_not_seen` on two fresh probes. A further private-network inspection found the user's `e14` peer online, but its SSH listener refused port 22 and the short hostname did not resolve on the VM. This is more precise than saying the desktop is absent from the network. There was no verified executable management connection, so the desktop was not modified.

The tested Linux/systemd release is ready for the desktop agent to apply after inspecting its own installation. Use `DESKTOP-AGENT-PROMPT-2026-09-13.md` and the full procedure in `DESKTOP-UPDATE.md`. Never copy the VM's account profiles or credentials to the desktop.

## Scope of completion

Implementation, merged source, VM staged rollout, fault tests, and live verification are complete. Desktop installation requires a local agent or a working authorized management connection. Targeted tests and a short observation period are not a multi-day soak. Upstream tool-dispatch refusals and a client that stops sending requests remain outside the local daemon's control.
