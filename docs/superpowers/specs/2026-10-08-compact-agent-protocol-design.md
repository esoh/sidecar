# Compact agent protocol

Date: 2026-10-08. Proposed design, based on Sidecar main `21f6894`.

## Outcome and agreed scope

Reduce the identifiers and delimiters the model must read and reproduce while preserving deterministic routing, one-trip simple replies, same-thread follow-ups, and simultaneous work across documents. Support both native Codex and Claude conversations.

The user selected persistent aliases rather than truncated UUIDs: a lowercase entity prefix followed by an uppercase base-36 counter (`1`–`9`, `A`–`Z`, `10`, ...). Allocation belongs entirely to Sidecar. It must not require an agent turn, a new tool call, or an external service. A retry uses the same alias. Normal restarts and deletion of documents/threads never recycle issued aliases.

Keep canonical UUIDs, native agent identities, content hashes, saved history, and browser URLs internally. This is a wire-format change, not a rewrite of existing records. No UI redesign, new dependency, tunnel change, or automatic installation/restart of other agents belongs in this change.

The owner-alias design below is a recommendation included for review. The other alias families and shorter markers reflect the approved conversational design.

## Alternatives considered

- **Selected: durable counter aliases.** Shortest initial identifiers and guaranteed uniqueness within their scope, with local bookkeeping.
- Base64url UUIDs retain UUID entropy without a registry, but are much longer than the selected aliases.
- Truncated hashes are deterministic but require collision handling or longer identifiers. They do not improve this use case over counters.

## Alias vocabulary and scope

| Entity | Example | Allocation scope |
| --- | --- | --- |
| Owner | `oA` | All owners under the configured Sidecar state root |
| Request | `rA` | Owner |
| Document | `dA` | Owner |
| Thread | `tA` | Owner |
| Message | `mA` | Owner |
| Reply recovery attempt | `eA` | Owner |
| Selection | `sA` | Owner |
| Proposed edit | `pA` | Owner |
| Document revision | `vA` | Owner |

Each entity type has its own increasing counter. Prefixes are fixed lowercase characters; the rest is canonical uppercase base 36. For example, `rR` is valid and unambiguous. Counters start at 1; reject zero, leading zeros, lowercase counter digits, wrong entity types, and unknown aliases. Use safe integer counters with an explicit exhaustion error rather than overflow or wraparound. This uses standard JavaScript number encoding, with no new dependency.

`lastRequestId`, `batchId`, `answeredBy`, `covers[]`, and each batch input's `requestId` refer to existing request aliases; they do not allocate a second kind of ID. A quote of a chat message uses the same thread/message aliases as fetched history. Equal canonical IDs reuse their alias within that entity type. A document revision alias maps to the exact existing content hash; it does not replace integrity checks.

`#selection-1` navigation slugs remain unchanged and scoped to their reply. There is no separate compact stream nonce or reply-receipt ID: the request alias identifies the delivery. Native turn/message IDs, runtime instance IDs, client deduplication IDs, reset IDs, and proposal-write transaction IDs remain internal and need not be exposed in ordinary model context. Authentication tokens retain their current format and handling.

## Owner identity

Recommend `ownerKey: "oA"` in model-facing events and command output. A state-root-wide registry maps it to one canonical `codex-UUID` or `claude-UUID`. It is not a separately allocated `o1` inside every owner's directory, and it is never reassigned after that owner has no documents.

`open`/`browse` already establish the native agent identity. Return the alias from that validated operation, retaining a one-time native identity binding in its result so the agent can associate it with its original session. Normal events need only the alias. CLI commands accept either an alias or the existing full owner key; aliases resolve before locating runtime files or sending authenticated requests.

Native adapters continue deriving the full session UUID from native session evidence. A server accepts an alias only if it resolves to that exact server owner. Codex queue reconciliation and Claude receipts must enforce the same mapping mechanically. Aliases are routing names, not credentials. No cross-owner claim, reply, queue mutation, or restart becomes authorized by possessing an alias.

## Persistent bookkeeping

Use an additive registry alongside the existing data, leaving `state.json` at v5:

- `<state-root>/agent-ids/owners.json`: format version 1, next owner counter, and canonical-owner-to-alias records.
- `<owner-directory>/agent-ids.json`: format version 1, the canonical owner and owner alias, counters and mappings for the eight owner-local entity types, and the chosen format of prepared deliveries.

The state root follows `SIDECAR_STATE_DIR`, or the existing default. This is machine-local identity; copying individual owner folders to another root is not an automatic alias migration.

Allocate the owner alias under a short-held cross-process lock in the dedicated registry directory, reusing the existing owner-lock primitive. Validate the registry before mutation. A busy or unrecoverable lock produces a bounded, actionable failure; never guess another number. Different owners must not acquire the same alias during concurrent startup.

The existing exclusive owner process owns its local ledger. Serialize ledger updates in-process, following the existing store's transaction pattern. Build reverse lookup maps in memory. Allocate all aliases needed by one outgoing event/context response in one batch and atomically persist them before publishing that response. No write is needed to re-encode an already-known object. A failed write prevents publishing new aliases; it cannot trigger an agent delivery with unrecorded identifiers.

The ledger is independent of document cleanup. Keep mappings and counters when documents/threads are deleted, and retain the owner entry even when it owns no documents. Mapping a deleted entity must still fail the normal live-record lookup. Never recreate a deleted document from an alias. New records get new canonical IDs and new aliases.

An absent ledger is initializable only for an owner with no previously registered compact ledger. Retain an initialization indicator in the owner registry. A missing ledger for an initialized owner, malformed mappings, duplicate aliases, or counters below allocated values fail closed; they must not silently reset. An orphan ledger with a missing owner registry likewise requires restoration, not a new allocation. Registry/ledger initialization must be retryable if interrupted between writes.

These files use private permissions and atomic temporary-file replacement, consistent with existing persistence. Normal process restarts and document deletion are covered. Deliberate deletion or rollback of all bookkeeping is outside the non-reuse guarantee; backups must include the owner registry and ledgers. Restoring only old document history while retaining the ledger must not reuse an alias. Preserve unknown/newer registry versions instead of overwriting them.

## Model-facing examples

Illustrative event (no UUIDs are needed in the ordinary event):

```json
{
  "type": "sidecar.request",
  "ownerKey": "oA",
  "requestId": "rC",
  "documentId": "d1",
  "thread": {"id": "t2", "lastRequestId": "rB"},
  "text": "What triggers this route?",
  "stream": {
    "prefix": "[[sc:rC]]\n",
    "suffix": "\n[[/sc:rC]]",
    "progress": {
      "prefix": "[[sc-progress:rC]]\n",
      "suffix": "\n[[/sc-progress:rC]]"
    }
  },
  "instruction": "Follow the Sidecar skill."
}
```

Progress, when useful:

```text
[[sc-progress:rC]]
I’ll check the route handler.
[[/sc-progress:rC]]
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
- `src/codex-queue.ts`: recognize exact owned compact events while preserving unrelated native queue entries and existing ordering.
- `hooks/control.js`: recognize compact notifications, hydrate truncated Monitor attachments, bind output markers to the correct native turn, and preserve Stop/Reset behavior before any output.
- Shared `.agents/skills/sidecar/SKILL.md`, README and relevant fixtures: examples, continuity, metadata, recovery and CLI fallback. Edit shared sources, never tool-specific skill symlinks.

Browser APIs and URLs remain canonical. Do not transmit whole alias registries to the model, browser, or SSE clients. No new polling, document transfer, or agent/model round trip is introduced. Internal adapter calls may continue using canonical IDs; translate only where data crosses the model-facing boundary.

## Compatibility, startup and rollback

Readers accept both existing `sidecar`/`sidecar-progress`/`sidecar-reply`/`sidecar-meta` formats and the new `sc`/`sc-progress`/`sc-meta` formats. Existing nonces and thread-plus-receipt replies retain their existing validation. Do not remove the legacy readers in this PR.

Freeze the selected output format for each prepared delivery and persist it with the alias bookkeeping before sending. Outstanding legacy deliveries and their hydration/recovery retain their legacy markers. Retries must not silently switch formats or reallocate aliases. A server restart keeps existing uncertain-request/recovery semantics; it does not resend edits or tasks merely because aliases exist.

Codex delivery is produced and captured by the updated app. Claude needs explicit compact-protocol capability from its native control module as well as a compatible watcher before compact delivery is enabled. An already-loaded old module must continue receiving the old event and marker form. Negotiate this mechanically through existing watcher/control traffic, with no model instruction to fetch capabilities and no new heartbeat. New adapters continue working with an old server; absent capability means legacy. The new parser and shared skill also accept old metadata while an agent refreshes its instructions.

The additive ledgers do not force a saved-state schema upgrade. Rolling back the app leaves them untouched and uses legacy identifiers/markers. Drain compact requests before a deliberate downgrade: an older server cannot capture compact output. If downgrade happens with unfinished work, preserve it as uncertain and use the existing explicit recovery path; do not replay the original task automatically. Re-upgrading reuses the retained mappings/counters. Back up the ledgers with the existing records for any subsequent authorized installation.

## Acceptance evidence

1. Exact base-36 boundaries and strict type/case validation; stable alias reuse; no counter wraparound. Concurrent owner allocation produces distinct aliases. Wrong-owner and wrong-type aliases cannot resolve to a valid route.
2. Restart, closed documents/threads, ordinary state-history restore, failed ledger writes and interrupted initialization preserve the non-reuse contract. Missing/corrupt initialized ledgers produce an actionable error and no delivery.
3. The same alias appears consistently in open output, direct/fallback requests, batches, `lastRequestId`, `covers`, chat quotes, history, selections, proposals and revision references. User-authored UUID-looking text is unchanged.
4. Legacy and compact final/progress/metadata parsing, every split-marker boundary, multiple threads in one native message, duplicate delivery, superseded coverage, incomplete finals and stale recovery. No early metadata effects or duplicate saved replies.
5. Both native adapters: busy mid-turn delivery, idle queue/start, cross-thread replies, Monitor hydration, native interruption, Stop before output, Reset queue cleanup and reply recovery. Old Claude capability falls back to legacy; new capability enables compact markers.
6. Real disposable Codex and Claude smoke checks using only scratch documents/sessions, plus focused browser coverage showing unchanged final/progress display and hidden metadata. No probes in the user's active review owners.
7. Representative old/new event and reply envelopes show exact byte reduction. If an existing local tokenizer is available, report measured token counts; never equate character savings with a measured token saving. Existing SSE bandwidth behavior remains unchanged.

Run the relevant parser, store/ledger, direct-delivery, batching, recovery, Codex queue, hooks and mid-turn tests plus typechecks. This spec is not a claim those checks have passed. Product implementation, dependency installation, live upgrades, and publishing await the later approved plan/execution stages.
