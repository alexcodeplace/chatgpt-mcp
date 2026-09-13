# Named-key operations: deck-kmgr consumer contract

Status: DESIGN ONLY, September 13, 2026. No new MCP tools, key manager, owner-decision workflow, storage migration or runtime configuration is shipped by this document.

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

## Proposed opt-in MCP tools

| Tool | Allowed behavior |
| --- | --- |
| `kmgr.list` | Return authorized key names only; project argument is a filter, not an authentication claim |
| `kmgr.profiles` | Return supported non-secret operation scopes for a visible key |
| `kmgr.run` | Submit an authenticated, typed operation with validated inputs and idempotency identity; return a result or durable request/job handle promptly |
| `kmgr.status` | Read the caller-authorized request/job state, review link, and sanitized result without replaying execution |

Tool names are proposed, not present runtime capabilities. Resolve naming and adapter types against the installed MCP conventions before implementation, without changing these authority boundaries.

No agent-facing `get`, `reveal`, `export`, `approve`, `grant`, `import`, `replace`, or key-delete operation. No arbitrary command or destination URL to receive credentials. A generic `fs`, shell, service, or local broker-client path must not provide indirect owner authority.

The MCP service must not read, cache, decrypt or inject the provider key into its child environment. The broker uses it privately in a trusted provider adapter. A key name such as `cloudflare.multideal.full.api` is an identifier, not a secret value and not evidence of unlimited permission.

## Request and execution handling

Bind operations to the authenticated connector/client and owner-approved project association. Do not accept an asserted `owner`, Telegram sender ID, project name, or desired profile as proof of permission. Keep any transport credential for submitting operations separate from owner-management and decision authority.

A pending result includes a stable request ID, immutable revision, durable job ID where allocated, expiry and a non-authorizing Overdeck review link. Preserve structured MCP schemas while reporting pending/denied/unavailable states. Do not hold a foreground call open during a human wait or interpret unavailable authorization as approval.

The broker resumes the saved operation after a valid owner decision. The MCP client can read its state when active; disconnection must not lose the job or repeat it. `always` and `never` persistence and request deduplication are broker responsibilities, not MCP-local caches. An expired or changed request cannot be approved through a stale link or replayed owner message.

An approval is not a successful deployment. Expose truthful execution status and sanitized result/exit information. Report uncertain provider outcomes without automatic side-effect repetition. Do not claim a closed ChatGPT conversation can be awakened merely because the broker completes a job.

## Compatibility and trust boundary

The adapter is optional and disabled until explicitly enrolled through Overdeck's owner setup. Existing MCP filesystem, shell, desktop and output-redaction capabilities retain their contracts. This is not a migration that silently disables authorized legacy credential use.

Existing output redaction remains defense in depth. The core protection is that the agent/MCP environment never obtains the provider secret and cannot modify the broker, its trusted adapters, its owner UI/receiver, or its grants. Broadly privileged agent environments require a separate protected administrative boundary.

Botmaster's current generic agent inbox and mutable mirrored message records are not, by themselves, verified owner authorization. Only the protected path defined in the canonical spec may submit a decision. chatgpt-mcp does not implement that Telegram verification or expose a shortcut to it.

This local integration does not override safety checks made upstream before tool dispatch. Distinguish local permissions, broker decisions, transport failure and platform refusal honestly.

## Consumer acceptance to add with implementation

Use synthetic keys and an isolated broker fixture to prove name-only discovery, caller/project isolation, typed operation validation, durable pending responses, status recovery, structured result compatibility, and unchanged legacy capabilities. Verify the MCP process and its logs/env/artifacts never receive key bytes.

Exercise a real installed Overdeck/Botmaster decision through the broker and observe the result through MCP without agent approval authority or owner 'continue'. Test denial, expiration, replay, altered inputs, unavailable broker and forged decision attempts. Those are implementation acceptance requirements, not tests run by this documentation change.
