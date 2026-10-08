# Compact Agent Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shorten model-facing Sidecar identifiers and markers while preserving reliable delivery to the original Codex or Claude conversation.

**Architecture:** Keep canonical records and browser APIs unchanged. A single machine-local registry supplies persistent, globally unique typed aliases; explicit boundary encoders project agent events/context into the compact format. Native adapters negotiate compact delivery during upgrades and the capture layer reads both formats.

**Tech Stack:** Node.js 22+, TypeScript, existing node:test/tsx and Playwright tooling; no new dependency.

**Spec:** [Approved compact protocol design](../specs/2026-10-08-compact-agent-protocol-design.md). Approved in the Sidecar review on 2026-10-08 after changes to centralize the registry, shorten progress to `scp`, omit input marker definitions, and exclude downgrade support and benchmarks.

## Global Constraints

- Work only in the dedicated `feat/compact-agent-protocol` linked worktree at `.claude/worktrees/compact-agent-protocol`; pass its absolute path to any worker/reviewer.
- Prefixes are `o`, `r`, `d`, `t`, `m`, `e`, `s`, `p`, `v`; counters start at 1 and use uppercase base 36. The same owner/type/canonical ID always keeps its alias.
- All counters/mappings live at `<state-root>/agent-ids/registry.json`; a central initialization marker guards against a missing initialized registry. No per-agent ledger or new service.
- Keep `state.json` at v5. Preserve canonical UUIDs, hashes, native session IDs, browser URLs, history and credentials. No automatic cleanup of issued aliases.
- New events are `sc.request`/`sc.recovery`. Normal complete events contain no `stream` object. Keep `instruction: "Follow the Sidecar skill."`; `streamError` invokes complete-reply fallback.
- Final markers are `[[sc:rC]]` / `[[/sc:rC]]`; progress markers are `[[scp:rC]]` / `[[/scp:rC]]`; metadata uses `[[sc-meta {JSON}]]`. No extra reply receipt. Existing `#selection-1` links remain.
- Legacy events/markers remain supported for upgrading running sessions and existing deliveries. No downgrade support or byte/token benchmark work.
- Use scratch state, documents and native sessions for testing. Do not install, restart user viewers/agents, change tunnels, push or open a PR as part of this plan.
- Shared skill changes go into `.agents/skills/sidecar/SKILL.md`, never a symlink.

## Review Focus

- Two processes with stale caches allocate different entity types/owners concurrently: no duplicate aliases or lost mappings. Task 1 tests both cross-process allocation and refresh-on-miss.
- Test fixtures start a server without an explicit state root: they must never write the user's real registry. Task 3 requires a state-root argument and updates every server caller.
- A live Claude module predates the installed watcher/app, or its capability expires: keep legacy new deliveries; do not change a format already handed off. Task 3 covers every capability combination and recovery after restart.
- User prose/code contains IDs or fenced marker examples matching an active request: projection preserves the text, and capture does not treat quoted examples as protocol boundaries. Tasks 2 and 3 exercise these inputs.
- Registry publication, native delivery acknowledgment, interruption and final save race: unpersisted aliases are never sent, unrelated queues stay intact, completed replies win, and tasks are not replayed. Tasks 1 and 3 cover those failure boundaries.

## Preparation

The dedicated worktree already exists. `bash scripts/worktree-setup.sh` was attempted once; this repository has no such script. No product dependencies or runtime changes were made during design.

Before the first executable test, run `pnpm install --frozen-lockfile` in this worktree, then collect `pnpm test` and `pnpm typecheck` baseline results. Do not bootstrap AMC or change its dependencies. Existing repository tests use local listeners, so request the harness's scoped permission when needed. Run slow independent checks in the background, preserving and collecting their real exit codes.

## Task 1: Durable computer-wide alias registry

**Files:** Create `src/agent-ids.ts` and `test/agent-ids.test.ts`. Reuse `src/owner-lock.ts` unchanged unless a reproduced registry-specific defect requires a narrow fix.

**Interfaces:** Export these from `src/agent-ids.ts`:

```ts
type IdKind = 'o' | 'r' | 'd' | 't' | 'm' | 'e' | 's' | 'p' | 'v';
type IdRef = { kind: IdKind; id: string };
type DeliveryFormat = 'legacy' | 'compact-v1';
type AgentIds = {
  allocate(ownerKey: string, refs: readonly IdRef[], delivery?: { requestId: string; format: DeliveryFormat }): Promise<void>;
  encode(ownerKey: string, kind: IdKind, canonicalId: string): string;
  resolve(ownerKey: string, kind: IdKind, alias: string): Promise<string>;
  resolveOwner(alias: string): Promise<string>;
  deliveryFormat(ownerKey: string, requestId: string): Promise<DeliveryFormat | undefined>;
};
function openAgentIds(stateRoot: string): Promise<AgentIds>;
```

`allocate` also ensures the canonical owner's `o` entry exists. `encode` never allocates; its caller must allocate all needed references first. `resolve`/`resolveOwner` accept aliases only and reject type/owner mismatches. Legacy full IDs bypass alias resolution at the boundary and retain existing record validation. `deliveryFormat` returns the persisted selection; attempting to overwrite it with a different format fails.

Registry v1 shape: `{version: 1, next: Record<IdKind, number>, ids: Record<alias, {owner: canonicalOwnerKey, id: canonicalId}>, deliveries: Record<requestAlias, DeliveryFormat>}`. The alias's prefix supplies its kind. An owner entry's `owner` and `id` are its canonical owner key. Every other entry must reference a registered owner; delivery keys must resolve to request entries.

- [x] **Step 1: Add focused registry regressions.** Use fresh `mkdtemp` roots and valid fixed native owners from existing test patterns. Pin the following assertions:

```ts
// First allocation, repeated allocation, and reopen:
await ids.allocate(owner, [{ kind: 'r', id: request }]);
assert.equal(ids.encode(owner, 'r', request), 'r1');
assert.equal(await ids.resolve(owner, 'r', 'r1'), request);
assert.equal(await ids.resolveOwner(ids.encode(owner, 'o', owner)), owner);
```

Add named tests for `base36 boundaries are canonical` (`9 -> 9`, `10 -> A`, `35 -> Z`, `36 -> 10`); `counter exhaustion does not publish or wrap`; `processes preserve globally unique allocations and refresh stale caches`; `deletion and history restore do not reset registry counters`; `wrong owner and kind fail`; `failed write does not publish an alias`; and `interrupted initialization recovers without resetting initialized data`. Verify rejection of `r0`, `r01`, `ra`, unknown aliases, duplicate canonical mappings, low counters, and unknown registry versions without rewriting their bytes. Add `an initialized missing or corrupt registry never resets`: retain the marker, remove or corrupt the registry, then assert an actionable error, no issued alias, and no replacement registry. Use subprocesses for the concurrency case, not only promises in one process. Verify one type's counter does not consume another's sequence.

- [x] **Step 2: Run `node --import tsx --test test/agent-ids.test.ts`.** Expect failure because `src/agent-ids.ts` does not yet exist, then behavioral failures until implemented.

- [x] **Step 3: Implement the registry.** Reuse the existing private-file/atomic-rename and lock patterns. Serialize process-local writes; acquire the shared lock with a bounded five-second wait, reread under lock, validate, allocate the whole batch, persist, then update cache/return. A corrupt/stuck lock fails visibly. No allocation reads a cached counter. Existing IDs are immutable; a known mapping needs no write. Keep the initialization marker at `agent-ids/initialized`; create/validate the registry before that marker and publish nothing until both exist. Read-only cache misses reload the registry. Do not prune mappings, add a database, or introduce a cleanup daemon.

- [x] **Step 4: Rerun the registry tests and typechecks.** Expect all assertions above to pass; interrupted/failed writes must leave the last valid mapping unchanged. Counter exhaustion must fail before an unsafe next value is stored.

- [x] **Step 5: Commit `src/agent-ids.ts` and `test/agent-ids.test.ts`** with `feat: persist computer-wide agent ID aliases`.

## Task 2: Compact output capture with legacy compatibility

**Files:** Modify `src/stream.ts`, `src/reply-metadata.ts`, `test/stream.test.ts`, and `test/proposals.test.ts`.

**Interfaces:** Keep `ReplyRoute` canonical. Extend `ReplyStream`'s existing constructor to `constructor(route: ReplyRoute, stableThreadTag = false, requestAlias?: string)`. An omitted alias preserves the existing behavior. Export `compactReplyMarkers(requestAlias: string): {prefix: string; suffix: string; progress: {prefix: string; suffix: string}}` for use by the server and tests. Expose the stream's optional `requestAlias` for router lookup; aliases resolve only to registered active streams.

Reuse one boundary scan for the router, per-stream rendering and native completion recovery. Export `findReplyBlocks(text: string, streams: ReadonlyMap<string, ReplyStream>): Array<{stream: ReplyStream; start: number; end: number | null}>`, where `end` is immediately after the closing marker, or null for a still-open block. Protocol markers must occupy their own lines and fenced examples must remain text. This replaces repeated boundary searches in the touched capture paths; it is not a general Markdown-parser rewrite.

- [x] **Step 1: Add parser regressions before changing code.** Assert exact output from `compactReplyMarkers('rC')`:

```ts
assert.deepEqual(compactReplyMarkers('rC'), {
  prefix: '[[sc:rC]]\n', suffix: '\n[[/sc:rC]]',
  progress: { prefix: '[[scp:rC]]\n', suffix: '\n[[/scp:rC]]' },
});
```

Parameterize existing legacy cases with compact final/progress and `sc-meta`: every split position in delimiters, reordered/duplicated chunks, multiple request blocks in one native message, wrong closing ID, unknown request, incomplete final, and final metadata applied only on completion. Add `fenced marker examples remain literal answer text` and `another owner's alias never matches a registered stream`. Preserve the legacy nonce and thread-plus-receipt fixtures. Metadata-only/malformed/partially streamed headers retain existing behavior for both names; proposals still use the same selection order.

- [x] **Step 2: Run `node --import tsx --test test/stream.test.ts test/proposals.test.ts`.** Confirm the new compact cases fail for the expected missing parser/formatter behavior.

- [x] **Step 3: Implement compact formatting and dual readers.** Validate canonical `r` aliases; keep route IDs canonical. Locate active streams by their stored request alias and keep all buffer/turn/deduplication limits. Share the fence-aware boundary scan instead of independently adding regexes to each completion path. Recognize `[[sc-meta ` and the legacy metadata prefix without showing partial headers to the viewer. Do not emit compact notifications yet.

- [x] **Step 4: Rerun focused parser/proposal tests plus typechecks.** Existing and compact forms must preserve identical saved text/metadata; partial and quoted examples must not finalize another delivery.

- [x] **Step 5: Commit the four files** with `feat: capture compact reply and progress markers`.

## Task 3: Wire encoding, CLI and both native adapters

**Files:** Create `src/agent-protocol.ts` and `test/agent-protocol.test.ts`. Modify `src/server.ts`, `src/agent.ts`, `src/cli.ts`, `src/codex-queue.ts`, `hooks/control.js`, `.agents/skills/sidecar/SKILL.md`, and README. Update `test/support.ts` and the direct `startServer` callers in `test/agent.test.ts`, `test/codex-stream.test.ts`, `test/library.test.ts`, `test/terminal-interrupt.test.ts`, `test/codex-queue.test.ts`, `test/hooks.test.ts`, `test/direct-delivery.test.ts`. Extend `test/batching.test.ts`, `test/recovery.test.ts`, `test/mid-turn.test.ts` and relevant CLI/queue tests.

**Interfaces:**

- `compactNotification(owner: Owner, event: Record<string, unknown>, ids: AgentIds): Promise<Record<string, unknown>>` in `agent-protocol.ts`: projects a validated canonical prepared notification, allocating all required references in one batch; maps its type to `sc.request`/`sc.recovery`, removes normal marker definitions, maps capture error to `streamError`, and preserves question/context bytes.
- `compactContext(owner: Owner, context: Record<string, unknown>, ids: AgentIds): Promise<Record<string, unknown>>`: explicitly projects the existing full request/document/thread/proposal response. Omit transport-only fields; translate only documented identity and revision fields. Do not write a generic recursive UUID replacer.
- Add required `stateRoot: string` to `ServerOptions`. Production `serve` supplies the configured state root corresponding to its canonical owner directory. All tests supply a private root explicitly; no implicit fallback to real user state in the server.
- Keep native HTTP traffic canonical by default. Updated agent-facing CLI/watcher calls opt in with `X-Sidecar-Protocol: sc1`; `/agent/status` advertises `agentProtocol: 'sc1'` for new clients. Old viewers ignore the header and continue returning legacy data during upgrade.
- Add `protocol: 'sc1'` to existing Claude module control traffic. New compact Claude deliveries require both the watcher header and a matching module capability seen within the existing 2,500ms control freshness window; idle capability still counts. Missing/expired capability selects legacy for new deliveries only. Do not add a heartbeat.
- Runtime records may add `ownerAlias`; keep their canonical `ownerKey`, `instanceId` and native validation. This lets Claude match aliases against its verified runtime without loading the entire registry. CLI aliases resolve to canonical owner/entity IDs before the existing authenticated call. Commands with full owner keys retain their existing maintenance path.

- [x] **Step 1: Add failing end-to-end and projection tests.** Extend the existing fixtures rather than starting real agents. Name/assert:

  - `compact event keeps context without marker definitions`: type `sc.request`, aliased owner/request/document/thread/previous/coverage, unchanged text, no `stream`, exact instruction. Include batches, document quotes, cross-thread message quotes and file quotes.
  - `compact capture failure uses explicit fallback`: a prepared event with capture failure includes `streamError`; complete-reply fallback saves it once using aliases. A normal complete compact event has neither `stream` nor `streamError` and needs no fetch; an oversized ID-only event still hydrates its question and retains its original delivery format.
  - `context aliases every documented reference without changing prose`: short request/batch/answeredBy/recovery IDs, message and selection identities, quote versions, proposal identities/source/applied versions; preserve canonical-looking strings in text/path/source. Suppress internal native turn, submission/client-deduplication and transaction IDs.
  - `CLI short and full handles reach the same owner and document`: open/browse return the bound alias; full browser URL stays canonical; request/name-thread/reply/stream/status work with aliases and legacy IDs; wrong-owner/unknown aliases fail before mutation.
  - `Claude capability combinations preserve delivery format`: neither capability, watcher only, module only and both; expired capability; frozen legacy and compact deliveries after capability changes/restart; new watcher talking to an older viewer returns legacy. No new model/tool round trip.
  - `compact queue reset cannot withdraw another owner's or ordinary terminal input`: use the existing paginated queue mock and retain exact ordering/start-once assertions.
  - `registry failure prevents native delivery`: inject failed publication, assert zero native sends, retained request and visible error; recovery does not replay already accepted work.

Parameterize existing native interruption, Stop before output, same-thread coverage, concurrent finalization/recovery, and Monitor truncation tests for both formats. Explicitly assert that known request aliases survive deletion while their live-record lookup fails. Inspect every `startServer` caller so all test state roots are temporary.

- [x] **Step 2: Run `node --import tsx --test test/agent-protocol.test.ts test/direct-delivery.test.ts test/batching.test.ts test/mid-turn.test.ts test/recovery.test.ts test/codex-queue.test.ts test/agent.test.ts`.** Record expected compact-format failures, without weakening existing legacy expectations.

- [x] **Step 3: Implement the coordinated boundary change.** Keep `ownerKey`, `parseOwner`, runtime/token lookup and canonical store records as internal identity. Initialize the explicit registry root; resolve CLI aliases before canonical calls. Compact open output includes the short owner/document plus a one-time `nativeOwnerKey` binding; never put full registries in responses. Ordinary model-facing status omits private transport IDs while internal status retains identity checks.

Prepare canonical context, allocate aliases and persist the chosen format before publishing. Reuse its format for hydration, ID-only fallback, retries, recovery, explicit stream commands and reconstruction after a native turn ends. Existing claimed/previously handed-off requests without a registry format are legacy; new eligible requests use compact-v1. Oversized inputs retain the existing ID-only fallback. Normalize alias-bearing CLI routes/bodies before request/document/thread equality checks; return aliases only to negotiated model-facing clients. Keep normal browser endpoints canonical.

Codex queue parsing must recognize both type families and mechanically resolve owner/request aliases to its exact native session before starting/deleting submissions. Update both queue reconciliation call sites. Claude must match its runtime owner alias, hydrate `sc` events without marker fields, and report canonical validated receipts. Register capability on existing control traffic; distinguish main-session prompts from quoted/file content and subagent output. Compact `sc`/`scp` output still binds the correct native turn. Use Task 2's shared boundary extraction in `nativeEnded`, terminal partial recovery and Reset final-answer capture as well as ordinary streaming.

Update the shared skill in the same task: complete `sc.request` inputs need no fetch or marker lookup; form `sc`/`scp` markers from the supplied request alias, use `sc-meta`, preserve coverage and owner checks, and use `streamError`/ID-only/recovery fallback when explicitly indicated. Legacy inputs still use their supplied markers. Update all normal/error/proposal examples and README; keep authentication, user authorization and unsolicited-highlight constraints intact.

- [x] **Step 4: Run the focused tests above, `node --import tsx --test test/hooks.test.ts test/terminal-interrupt.test.ts test/reset.test.ts test/codex-stream.test.ts test/library.test.ts`, and `pnpm typecheck`.** Inspect results individually. Verify the scratch roots contain the registries and the real user registry was not accessed. Correct failures at the shared boundary; do not replace old assertions with new assertions where both paths need coverage.

- [x] **Step 5: Commit the coherent integration, tests and shared guidance** with `feat: deliver compact agent events across Codex and Claude`.

## Task 4: Acceptance and plan completion

**Files:** Extend `test/browser.spec.ts` with focused compact-delivery cases; annotate the spec and this plan with actual results. Record non-reproducible native acceptance in `docs/2026-10-08-compact-protocol-acceptance.md` using the actual execution date if different. Do not invent evidence or update installed plugins.

**Interfaces:** Consumes the registry, marker formatter, negotiated notifications, shared skill, and existing browser test harness. Produces verified acceptance evidence and a reviewable local branch.

- [x] **Step 1: Add browser regressions named `compact replies preserve message UI and hide protocol metadata` and `compact interrupted replies retain progress and Stop state`.** Feed compact native output through the fixture's real capture endpoints. Assert ordinary progress/final text, saved title/highlight/proposal behavior, no visible `sc-meta` line, and preserved partial output after an exact-turn interrupt. Keep the existing canonical browser IDs/URLs. Ensure current legacy/manual-delivery tests still select their intended format explicitly.

- [x] **Step 2: Run `pnpm exec playwright test --grep 'compact replies|compact interrupted'` and fix any demonstrated integration failure.** Then run `pnpm test`, `pnpm typecheck`, and `git diff --check`; collect every exit/result before claiming success. No token benchmark or downgrade suite.

- [x] **Step 3: Verify disposable native Codex and Claude sessions.** Follow the known native setup constraints in `docs/2026-10-06-mid-turn-acceptance.md`; inspect installed CLI help before selecting actual launch options. Use a session-local Claude plugin built from this worktree, separate temporary `SIDECAR_STATE_DIR`, toy files, and the real original-session APIs. Supply the revised shared skill. Verify a direct answer without a fetch command, marked interim output, same-thread correction plus another thread during CLI work, quoted-message continuity, reply-only recovery, and Stop before any output. Check saved results rather than only terminal text. Do not touch user viewers, send to inherited Herdr panes, or install globally. If native tooling blocks a case, report that exact gap; mock results do not substitute for it.

- [x] **Step 4: Record actual results and self-review the diff against every spec requirement.** Include native versions, scratch evidence paths, saved reply/state verification and any unverified case. Annotate the approved spec with `As built` deviations/results without erasing its decisions. No multi-PR `active-projects` entry is required for this single-PR task.

- [x] **Step 5: Commit acceptance coverage and documentation** with `test: verify compact protocol with both native agents`, then follow the user-selected execution method's final review gate. Present the final local result. PR creation, merge, installation and other-session upgrades require their own user authorization. If a Claude review prompts edits, leave those edits uncommitted after verification until the user approves them, as required by personal instructions.

## Execution choice

Recommend **Native**: implement in this session, followed by one independent whole-branch review. The registry, native receipt handling and stream capture share interfaces closely; a single implementer can keep those changes consistent. The alternative is per-task subagent implementation/review if the user prefers the extra independent checkpoints.

## As built — 2026-10-08

Tasks 1–3 are implemented and verified, including the user-added progress-only recovery fix and native Claude inbox replacing truncated Monitor delivery. Shared boundary tests live in dedicated `agent-protocol`, `compact-stream`, and `claude-inbox` test files rather than expanding only the original test files. Full backend gate: 253 passed. Focused browser gate: 2 passed. Server/browser typechecks and diff whitespace checks passed.

Native acceptance and exact un-repeated cases are recorded in [the acceptance report](../../2026-10-08-compact-protocol-acceptance.md). The real runs exercised the changed transport with both agents; automated tests cover additional legacy, recovery, quoted-message and interruption combinations. Task commits were deferred until coherent integration/final review instead of splitting intermediate incompatible wire changes. One independent review completed; all three reproduced findings were fixed and regression-tested; no publishing or installation is part of this execution.

Local task commits: e1948b9 (registry), f671089 (capture), and 194e091 (integration). Acceptance coverage and this completed record form the final task commit. All scoped implementation work is complete. The native cases listed as unverified in the acceptance report were not repeated live.
