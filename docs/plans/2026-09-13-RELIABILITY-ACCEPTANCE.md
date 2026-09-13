# Reliability acceptance follow-up, 2026-09-13

## Verified starting state

Main 6762464 already contained the first hardening implementation beaf62b. The active VM backend was the identified beaf62b runtime on 3211, with both tunnels actually executing the pinned 0.0.14 binary. The legacy convenience executable still reported 0.0.10 and was not the binary running those services. The original backend remained alive only to preserve its user-owned processes. Existing deployment acceptance was inspected rather than assumed.

## Additional defects addressed

- Reproduced a SIGTERM-ignoring descendant surviving timeout after its parent closed stdout/stderr. Cleanup now kills remaining members before clearing termination timers. Regression confirms the descendant is gone or reaped, not simply that the parent returned.
- Recovery now executes a bounded approved shell probe; capability declarations alone are insufficient. Execution-probe failures do not become backend-down diagnoses.
- Config-file digest and loaded runtime/release fingerprint are checkpointed. Configuration/authentication/policy/execution mismatches suppress dependent tunnel restarts without changing permissions.
- Malformed recovery state is repaired conservatively without resetting restart budgets. State writes fsync the directory before external actions.
- Candidate jobs and their retention tests use a private ledger, not the production ledger. Production settings are loaded and verified after candidate fault tests finish.
- Backend working directory is preserved across upgrades.
- Release packaging rejects source/revision mismatch and dirty source inputs.
- Existing fresh system.info tool metadata retains the diagnosis rule distinguishing permissions, capacity, connectivity and unknown delivery outcomes.

## Validation

The preserved baseline reproducer on debian1 returned timedOut=true while its descendant remained in sleeping state. The new regression test passes with final process-group cleanup.

The full frozen-install gate ran on debian1 in /tmp/chatgpt-mcp-acceptance-20260913. TypeScript typecheck/build and 142 TypeScript tests passed. The Python suite passed 28 behavioral tests, including a real loopback HTTP fixture with green readiness and stale poll timestamps. Systemctl is stubbed in unit tests so they cannot restart live services.

Final production release identity, staged canary results, guarded rollout result and live connector evidence belong in the active deployment's private acceptance.json. A source commit or passing unit suite alone is not proof that deployment succeeded. Inspect ~/.config/chatgpt-mcp/active.json and the referenced deployment directory before reporting completion.

## Desktop boundary

The desktop connector was probed twice during this follow-up and returned tunnel_client_not_seen. No configured desktop SSH route was found, and the existing e14 hostname did not resolve from the VM. This is lack of a verified management connection, not a write-permission denial. Give the desktop agent docs/DESKTOP-UPDATE.md together with the exact VM-validated release revision. Do not copy VM tunnel identities or credentials.

These targeted fault tests and live checks are not a multi-day soak or a guarantee against an upstream service refusing or ceasing to dispatch requests.

## Native unit validation follow-up

The e1068ba candidate was rejected before any tunnel changed because its WorkingDirectory value had literal quotes. The original release remained active. The generator was corrected, and backend unit rendering is now checked with the real systemd parser before enabling any candidate. A regression runs the native parser against the generated unit (including a directory containing spaces) and confirms that the original quoted-path mistake is rejected. Candidate startup failures now share the same cleanup path as other pre-cutover failures. The failed candidate unit and journal were preserved in its private deployment evidence, not hot-patched in the immutable release.
