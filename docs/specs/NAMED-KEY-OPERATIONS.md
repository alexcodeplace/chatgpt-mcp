# Named-key operations: deck-kmgr consumer contract

Status: OPTIONAL CONSUMER IMPLEMENTED, September 14, 2026. The four agent tools are disabled by default. No key store, owner-enrollment UI, storage migration, or live endpoint activation is included in this consumer change.

## Canonical authority

The product specification is owned by the Overdeck repository:

- Repository: `alexcodeplace/overdeck`.
- Specification: `docs/specs/2026-09-13-deck-kmgr-design.md`.
- Indexed implementation plan: `docs/plans/2026-09-13-deck-kmgr.md`.
- Local sibling checkout: `~/Projects/overdeck`.

Read that specification before implementing this adapter. It owns permission semantics, protected credential storage, enrollment, UI, Botmaster routing/reply authentication, provider execution, persistence, recovery and acceptance. This document specifies only the MCP consumer boundary, not a second version of the product policy.

## Owner-directed experience

Overdeck contains the decision-making UI and key-management wizard. Botmaster notifies the project's channel, falling back to the Overdeck channel when no relevant project channel exists. The owner can decide directly using `#<request-id> approve`, `#<request-id> always`, `#<request-id> deny`, or `#<request-id> never`.

The same immutable request and protected broker transition serve the Overdeck buttons and authenticated owner replies. Replies are real decisions, not messages that the agent must reinterpret. Normal approved use and automatic continuation require no config edits, credential relays, second mandatory passkey prompt, or manual chat restart.

The canonical Overdeck spec defines the four commands' precise scope and denial precedence. A message ID is not a request ID. An agent-visible acknowledgement is not proof of authorization; only broker state is authoritative.

## Opt-in MCP tools

| Tool | Allowed behavior |
| --- | --- |
| `kmgr.list` | Return authorized key names only; project argument is a filter, not an authentication claim |
| `kmgr.profiles` | Return supported non-secret operation scopes for a visible key |
| `kmgr.run` | Submit an authenticated, typed operation with validated inputs and idempotency identity; return a result or durable request/job handle promptly |
| `kmgr.status` | Read the caller-authorized request/job state, review link, and sanitized result without replaying execution |

These names are registered only when the endpoint is explicitly enrolled. A disabled configuration registers none of them. The client credential is read privately from a file; no provider credential is handled by this process. Configuration fields are the future owner wizard integration seam, not instructions for the owner to edit configuration files.

No agent-facing `get`, `reveal`, `export`, `approve`, `grant`, `import`, `replace`, or key-delete operation. No arbitrary command or destination URL to receive credentials. A generic `fs`, shell, service, or local broker-client path must not provide indirect owner authority.

The MCP service must not read, cache, decrypt or inject the provider key into its child environment. The broker uses it privately in a trusted provider adapter. A key name such as `cloudflare.multideal.full.api` is an identifier, not a secret value and not evidence of unlimited permission.

## Request and execution handling

Bind operations to the authenticated connector/client and owner-approved project association. Do not accept an asserted `owner`, Telegram sender ID, project name, or desired profile as proof of permission. Keep any transport credential for submitting operations separate from owner-management and decision authority.

A pending result includes a stable request ID, immutable revision, durable job ID where allocated, expiry and a non-authorizing Overdeck review link. Preserve structured MCP schemas while reporting pending/denied/unavailable states. Do not hold a foreground call open during a human wait or interpret unavailable authorization as approval.

The broker resumes the saved operation after a valid owner decision. The MCP client can read its state when active; disconnection must not lose the job or repeat it. `always` and `never` persistence and request deduplication are broker responsibilities, not MCP-local caches. An expired or changed request cannot be approved through a stale link or replayed owner message.

An approval is not a successful deployment. Expose truthful execution status and sanitized result/exit information. Report uncertain provider outcomes without automatic side-effect repetition. Do not claim a closed ChatGPT conversation can be awakened merely because the broker completes a job.

## Compatibility and trust boundary

The adapter is optional and disabled until explicitly enrolled through Overdeck's owner setup. Existing MCP filesystem, shell and desktop capabilities retain their verbatim-output contracts. This is not a migration that silently disables authorized legacy credential use.

The shared MCP output-redaction layer was removed on main at 7c38c64 by owner direction. This adapter does not restore it. Named-key protection instead requires that the agent/MCP environment never obtains the provider secret and cannot modify the protected broker, its trusted adapters, owner UI/receiver, or grants. Broadly privileged agent environments require a separate protected administrative boundary.

Botmaster's current generic agent inbox and mutable mirrored message records are not, by themselves, verified owner authorization. Only the protected path defined in the canonical spec may submit a decision. chatgpt-mcp does not implement that Telegram verification or expose a shortcut to it.

This local integration does not override safety checks made upstream before tool dispatch. Distinguish local permissions, broker decisions, transport failure and platform refusal honestly.

## Consumer acceptance

Use synthetic keys and an isolated broker fixture to prove name-only discovery, caller/project isolation, typed operation validation, durable pending responses, status recovery, structured result compatibility, and unchanged legacy capabilities. Verify the MCP process and its logs/env/artifacts never receive key bytes.

Exercise a real installed Overdeck/Botmaster decision through the broker and observe the result through MCP without agent approval authority or owner 'continue'. Test denial, expiration, replay, altered inputs, unavailable broker and forged decision attempts. Those are implementation acceptance requirements, not tests run by this documentation change.

Implementation evidence: client boundaries, disabled-by-default registration, name-only projection, versioned profiles, durable handles, request-scoped status, redirect refusal, bounded responses and credential-free error messages are covered by the consumer tests. The existing full remote gate passed at fe429d1 (run 34831577182). An additional actual MCP protocol round-trip test is included in the following commit. Installed Overdeck/Botmaster owner-flow acceptance is still separate and has not been claimed.
