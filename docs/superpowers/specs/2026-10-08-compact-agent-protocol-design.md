# Compact agent protocol

Date: 2026-10-08. Proposed design, based on Sidecar main `21f6894`.

## Outcome and agreed scope

Reduce the identifiers and delimiters the model must read and reproduce while preserving deterministic routing, one-trip simple replies, same-thread follow-ups, and simultaneous work across documents. Support both native Codex and Claude conversations.

The user selected persistent aliases rather than truncated UUIDs: a lowercase entity prefix followed by an uppercase base-36 counter (`1`–`9`, `A`–`Z`, `10`, ...). Allocation belongs entirely to Sidecar. It must not require an agent turn, a new tool call, or an external service. A retry uses the same alias. Normal restarts and deletion of documents/threads never recycle issued aliases.

Keep canonical UUIDs, native agent identities, content hashes, saved history, and browser URLs internally. This is a wire-format change, not a rewrite of existing records. No UI redesign, new dependency, tunnel change, or automatic installation/restart of other agents belongs in this change. At the user's request, downgrade support and byte/token-saving benchmarks are out of scope.

The user selected one computer-wide registry for all aliases. Owner identity and every other alias family share that registry; agent-specific ledgers are not part of the design.

## Alternatives considered

- **Selected: durable counter aliases.** Shortest initial identifiers and guaranteed uniqueness within their scope, with local bookkeeping.
- Base64url UUIDs retain UUID entropy without a registry, but are much longer than the selected aliases.
- Truncated hashes are deterministic but require collision handling or longer identifiers. They do not improve this use case over counters.

## Alias vocabulary and scope

All aliases are unique across agents sharing the computer's configured Sidecar state root.

| Entity | Example |
| --- | --- |
| Owner | `oA` |
| Request | `rA` |
| Document | `dA` |
| Thread | `tA` |
| Message | `mA` |
| Reply recovery attempt | `eA` |
| Selection | `sA` |
| Proposed edit | `pA` |
| Document revision | `vA` |

Each entity type has its own computer-wide increasing counter. Prefixes are fixed lowercase characters; the rest is canonical uppercase base 36. For example, `rR` is valid and unambiguous. Counters start at 1; reject zero, leading zeros, lowercase counter digits, wrong entity types, and unknown aliases. Use safe integer counters with an explicit exhaustion error rather than overflow or wraparound. This uses standard JavaScript number encoding, with no new dependency.

`lastRequestId`, `batchId`, `answeredBy`, `covers[]`, and each batch input's `requestId` refer to existing request aliases; they do not allocate a second kind of ID. A quote of a chat message uses the same thread/message aliases as fetched history. The same owner, entity type and canonical ID always reuse their alias. Every mapping records its owning agent; a global alias must still fail when used through another owner's server. A document revision alias maps to the exact existing content hash; it does not replace integrity checks.

`#selection-1` navigation slugs remain unchanged and scoped to their reply. There is no separate compact stream nonce or reply-receipt ID: the request alias identifies the delivery. Native turn/message IDs, runtime instance IDs, client deduplication IDs, reset IDs, and proposal-write transaction IDs remain internal and need not be exposed in ordinary model context. Authentication tokens retain their current format and handling.

## Owner identity

Use `ownerKey: "oA"` in model-facing events and command output. The computer-wide registry maps it to one canonical `codex-UUID` or `claude-UUID`. It is never reassigned after that owner has no documents.

`open`/`browse` already establish the native agent identity. Return the alias from that validated operation, retaining a one-time native identity binding in its result so the agent can associate it with its original session. Normal events need only the alias. CLI commands accept either an alias or the existing full owner key; aliases resolve before locating runtime files or sending authenticated requests.

Native adapters continue deriving the full session UUID from native session evidence. A server accepts an alias only if it resolves to that exact server owner. Codex queue reconciliation and Claude receipts must enforce the same mapping mechanically. Aliases are routing names, not credentials. No cross-owner claim, reply, queue mutation, or restart becomes authorized by possessing an alias.

## Persistent bookkeeping

Use one additive registry at `<state-root>/agent-ids/registry.json`, leaving each owner's `state.json` at v5. Registry format version 1 contains all nine counters, canonical-to-alias mappings with ownership, and the chosen format of prepared deliveries. There are no per-agent alias ledgers or separate registry service.

The state root follows `SIDECAR_STATE_DIR`, or the existing default (`~/.local/state/sidecar`). All agents in the normal installation share it. An explicitly separate state root is a separate installation/namespace; copying individual owner folders there is not an automatic alias migration.

Serialize new allocations under a short-held cross-process lock in the dedicated registry directory, reusing the existing owner-lock primitive. After acquiring it, reread and validate the current registry before allocating. Serialize writes from the same process as well. A busy or unrecoverable lock produces a bounded, actionable failure; never guess another number. Concurrent agent processes must not allocate duplicate aliases or overwrite each other's mappings.

Cache known mappings in memory and refresh on lookup misses. Allocate all aliases needed by one outgoing event/context response in one batch and atomically persist them before publishing that response. Never allocate from a cached counter. No write is needed to re-encode an already-known object. A failed write prevents publishing new aliases; it cannot trigger an agent delivery with unrecorded identifiers.

The registry is independent of document cleanup. Keep mappings and counters when documents/threads are deleted, and retain the owner entry even when it owns no documents. Mapping a deleted entity must still fail the normal live-record lookup. Never recreate a deleted document from an alias. New records get new canonical IDs and new aliases.

Retain an initialization marker beside the central registry. Persist the registry and marker before publishing the first alias; retry interrupted first-time initialization under the same lock. If the marker exists but the registry is absent, or mappings are malformed/duplicated or counters are below allocated values, fail closed instead of resetting counters. An existing valid registry without its marker can complete interrupted initialization. Both files belong to central bookkeeping, not an agent-specific ledger.

These files use private permissions and atomic temporary-file replacement, consistent with existing persistence. Normal process restarts and document deletion are covered. Deliberate deletion or rollback of all bookkeeping is outside the non-reuse guarantee; backups must include the central registry and initialization marker. Restoring only old document history while retaining the registry must not reuse an alias. Preserve unknown/newer registry versions instead of overwriting them.

## Model-facing examples

Illustrative complete single-question event (no UUIDs or repeated marker definitions are needed):

```json
{
  "type": "sc.request",
  "ownerKey": "oA",
  "requestId": "rC",
  "documentId": "d1",
  "thread": {"id": "t2", "lastRequestId": "rB"},
  "text": "What triggers this route?",
  "instruction": "Follow the Sidecar skill."
}
```

The shared skill defines the final/progress markers from `requestId`; the server constructs those same markers internally for capture. A normal compact event has no `stream` object. Keep the instruction reminder and existing optional thread title, quote, batch and coverage fields. `sc.request` distinguishes this contract from the legacy event, whose supplied markers must still be copied exactly. Compact recovery uses `sc.recovery` with the existing recovery semantics and a short `recoveryId`. If capture setup fails, include `streamError` and use the existing complete-reply command fallback; absence of a `stream` object alone is normal and must not trigger a fetch/tool call.

Progress, when useful:

```text
[[scp:rC]]
I’ll check the route handler.
[[/scp:rC]]
```

Final answer:

```text
[[sc:rC]]
[[sc-meta {"threadTitle":"Route trigger"}]]
The route runs when …
[[/sc:rC]]
```

The server resolves `rC` to its immutable canonical request, document, and thread before saving. No `sc-reply` marker is required. Metadata keeps its existing JSON fields and behavior. Multiple request blocks can occur in one native assistant message; each must close with its own request alias. Covered requests retain existing completion rules, and interrupted output never executes final metadata.

## Agent boundary and existing consumers

Encode known structured ID fields explicitly; never replace strings recursively by resemblance to UUIDs. User text, Markdown, code, quotes, paths, links, and proposal source strings must remain byte-for-byte unchanged. Fetched context should expose the aliases needed to understand or answer the request and omit transport-only fields such as the serialized submission signature and native turn identifiers.

Required paths:

- `src/server.ts`: direct notifications, batches, continuity and coverage references, ID-only fallback, recovery notifications, Claude hydration, and fetched request/document/thread/selection/proposal context.
- `src/agent.ts` and `src/cli.ts`: native owner resolution, open/browse results, watcher output, request/name-thread/stream/reply commands, and alias-aware status/maintenance command selection. Keep runtime and token lookup canonical.
- `src/stream.ts` and `src/reply-metadata.ts`: compact and legacy parsing, partial chunks, interleaved blocks, finalization, progress, and metadata hiding.
- `src/codex-queue.ts`: recognize exact owned `sc.request`/`sc.recovery` events alongside legacy event types while preserving unrelated native queue entries and existing ordering.
- `hooks/control.js`: recognize compact notifications, hydrate truncated Monitor attachments, bind output markers to the correct native turn, and preserve Stop/Reset behavior before any output.
- Shared `.agents/skills/sidecar/SKILL.md`, README and relevant fixtures: examples, continuity, metadata, recovery and CLI fallback. Edit shared sources, never tool-specific skill symlinks.

Browser APIs and URLs remain canonical. Do not transmit whole alias registries to the model, browser, or SSE clients. No new polling, document transfer, or agent/model round trip is introduced. Internal adapter calls may continue using canonical IDs; translate only where data crosses the model-facing boundary.

## Compatibility during upgrade and startup

Readers accept both existing `sidecar`/`sidecar-progress`/`sidecar-reply`/`sidecar-meta` formats and the new `sc`/`scp`/`sc-meta` formats. Existing nonces and thread-plus-receipt replies retain their existing validation. Do not remove the legacy readers in this PR.

Freeze the selected output format for each prepared delivery and persist it with the alias bookkeeping before sending. Outstanding legacy deliveries and their hydration/recovery retain their legacy markers. Retries must not silently switch formats or reallocate aliases. A server restart keeps existing uncertain-request/recovery semantics; it does not resend edits or tasks merely because aliases exist.

Codex delivery is produced and captured by the updated app. Claude needs explicit compact-protocol capability from its native control module as well as a compatible watcher before compact delivery is enabled. An already-loaded old module must continue receiving the old event and marker form. Negotiate this mechanically through existing watcher/control traffic, with no model instruction to fetch capabilities and no new heartbeat. During an upgrade, updated commands/adapters can encounter an older running viewer; absent capability means legacy until that viewer is upgraded. The new parser and shared skill also accept old metadata while an agent refreshes its instructions.

The additive registry does not force a saved-state schema upgrade. Back up the central bookkeeping with the existing records for any subsequent authorized installation. Preserve normal restart and unfinished-reply recovery; no downgrade procedure or downgrade verification is required.

## Acceptance evidence

1. Exact base-36 boundaries and strict type/case validation; stable alias reuse; no counter wraparound. Concurrent processes allocating owners and other entity types produce globally distinct aliases without lost updates. Wrong-owner and wrong-type aliases cannot resolve to a valid route.
2. Restart, closed documents/threads, ordinary state-history restore, failed registry writes and interrupted initialization preserve the non-reuse contract. A missing/corrupt initialized registry produces an actionable error and no delivery.
3. The same alias appears consistently in open output, direct/fallback requests, batches, `lastRequestId`, `covers`, chat quotes, history, selections, proposals and revision references. Compact inputs omit the repeated marker object, and the shared skill defines exactly the markers the parser accepts. Exercise explicit `streamError` fallback and distinguish a complete compact event from an ID-only notification. User-authored UUID-looking text is unchanged.
4. Legacy and compact final/progress/metadata parsing, every split-marker boundary, multiple threads in one native message, duplicate delivery, superseded coverage, incomplete finals and stale recovery. No early metadata effects or duplicate saved replies.
5. Both native adapters: busy mid-turn delivery, idle queue/start, cross-thread replies, Monitor hydration, native interruption, Stop before output, Reset queue cleanup and reply recovery. Old Claude capability falls back to legacy; new capability enables compact markers.
6. Real disposable Codex and Claude smoke checks using only scratch documents/sessions, plus focused browser coverage showing unchanged final/progress display and hidden metadata. No probes in the user's active review owners.

Run the relevant parser, store/registry, direct-delivery, batching, recovery, Codex queue, hooks and mid-turn tests plus typechecks. This spec is not a claim those checks have passed. Product implementation, dependency installation, live upgrades, and publishing await the later approved plan/execution stages.

## As built — 2026-10-08

The implementation retains canonical state v5 and adds the single machine-wide alias registry. The shared CLI, Codex queue/steering, Claude native module, capture parser and skill support compact delivery while retaining frozen legacy deliveries.

The user expanded this change to fix progress-only recovery and Claude Monitor truncation. A normally completed native turn with no final reply started now stays pending; confirmed interruption and unfinished final replies retain their existing Stop/recovery behavior. Claude's updated module receives full inputs at main-session tool completion or submits them from its idle background timer. Its capability suppresses Monitor delivery while fresh. A failed ambiguous native submission becomes uncertain and is never automatically replayed.

Real Claude validation rejected runtime feature detection on `$.prompt`: the native module API requires direct calls, so the updated module uses that supported form. Legacy modules continue with the legacy watcher path. See [acceptance evidence](../../2026-10-08-compact-protocol-acceptance.md) for versions, verified cases and limits.
