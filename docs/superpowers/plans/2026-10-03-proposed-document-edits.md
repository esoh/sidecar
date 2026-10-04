# Proposed Document Edits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let either attached agent propose main-document replacements that the user reviews and accepts without another agent round trip, shipping the verified selection-ambiguity fix in the same PR and upgrade.

**Architecture:** Capture optional proposal metadata with completed replies, persist separate proposal records, and apply accepted replacements through an owner-scoped service with exact source validation and durable write recovery. Reuse Sidecar's snapshots, renderer, selection navigation, viewer authentication and update events. Keep file mutation out of the UI and native adapters.

**Tech Stack:** TypeScript, Node 22+, pnpm 11+, React, existing Plannotator components, installed `@pierre/diffs`, Node test runner and Playwright. No new runtime dependency.

**Spec:** [Approved design](../specs/2026-10-03-proposed-document-edits-design.md), approved by the user on 2026-10-03.

**As built, 2026-10-04:** Tasks 1–5 are implemented and locally committed. Task 6's combined verification passed: 163 backend tests, 89 browser tests, backend/web typechecks and diff checks. Both native fixtures now prove acceptance during another streamed reply. The implemented Chrome preview also demonstrates the original-passage chooser and restored highlight. Release follows the independent whole-branch review; shared review context made separate `PinnedWindows.tsx`/`api.ts` changes unnecessary. Snapshot writing was extracted for reuse, and recovery of an unreadable document defers to its next decision without blocking other documents; see the spec's As built section.

## Global Constraints

- Work only in `/Users/seanoh/ws/pg/sidecar/.claude/worktrees/proposed-document-edits`, branch `feat/proposed-document-edits`. Nested `CLAUDE.md` checks found none during planning; check again before editing a newly reached package.
- `c25cd5e` already contains the verified ambiguity fix; do not recreate it. Its separate preview/worktree can remain open. Setup was invoked once; this repository has no `scripts/worktree-setup.sh`.
- Main registered Markdown document only. No code-window edits, browsed-file edits, other-owner edits or multi-file proposals.
- Per-reply **Accept all**, independent decisions, persistent history, no file change before acceptance, no extra native-agent request on acceptance.
- Proposal metadata: at most 20 highlights, `before` and `after` at most 16,384 UTF-16 code units each, source prefix/suffix at most 512 each. Nonempty `before`; empty `after` deletes; identical before/after is invalid.
- Source matching is literal. Rendered-text matching, smart-quote conversion and fuzzy matching never authorize a file write. Record up to 32 source-context code units per side when the agent did not supply that side.
- State version 4; byte-exact pre-migration backups. Preserve existing message/request/selection identities and snapshot bytes. No automatic downgrade.
- Tests and previews use disposable owners/files. Do not test against AMC documents or claim their requests.
- Ordinary filesystem replacement is not cross-process compare-and-swap. Recheck immediately before atomic publication, preserve recovery evidence, and document the residual race with unrelated external writers.

## Review Focus

- A source anchor may be unique while its rendered heading is ambiguous: keep navigation clarification separate from write authorization. Pin this in Tasks 3–5.
- A deleted target's words can still exist elsewhere: save source context and refuse to move the replacement to that other occurrence. Pin this in Task 2.
- A formatting-only change or empty replacement must remain understandable in the diff. Pin this in Task 5.
- An agent response can complete during Accept all or document close: retain its new proposals and never leave dangling routing or recreate deleted snapshots. Pin this in Tasks 3–4.
- Bytes can include BOM, CRLF or invalid UTF-8: preserve untouched valid bytes and refuse writes that would silently re-encode invalid source. Pin this in Task 2.

## Files and Shared Interfaces

New files:

- `src/proposals.ts`: proposal types, validation and pure literal-target/bulk preparation.
- `src/proposal-writes.ts`: guarded temporary-file preparation, synchronous publication and cleanup.
- `src/proposal-service.ts`: document-operation serialization, decisions and write recovery.
- `web/ProposalReview.tsx`: shared cards, diff popover and review context/controller.
- `web/usePosition.ts`: extract the existing positioning hook; preserve comment-menu behavior while allowing proposal bounds to use the document canvas.
- `test/proposals.test.ts`, `test/proposal-writes.test.ts`, `test/proposal-service.test.ts`: focused domain, file and recovery proof.

Modify existing metadata/store/server/document-reader, conversation/app/pinned-view integration, shared skill, README and the relevant existing test files. Keep `src/library.ts` read-only behavior through the shared saved-state reader.

Freeze these interfaces before dependent tasks:

```ts
type SourceRange = { start: number; end: number }; // UTF-16, end exclusive
type ProposalInput = { before: string; after: string; prefix?: string; suffix?: string };
type ProposalReason = 'missing' | 'ambiguous' | 'context-changed' | 'source-unavailable' | 'overlap' | 'application-unconfirmed';
type PreparedProposal = ProposalInput & {
  prefix: string; suffix: string; baseVersion: string | null;
  baseRange: SourceRange | null; reason?: ProposalReason;
};
type Proposal = PreparedProposal & {
  id: string; documentId: string; threadId: string; messageId: string; selectionId: string;
  status: 'pending' | 'accepted' | 'rejected' | 'outdated'; createdAt: number;
  decidedAt?: number; appliedVersion?: string; appliedRange?: SourceRange;
};
type ProposalWrite = {
  id: string; documentId: string; status: 'prepared' | 'unconfirmed';
  proposalIds: string[]; decidedAt: number; beforeVersion: string; afterVersion: string;
  appliedRanges: Record<string, SourceRange>;
};
type DecisionResult = {
  accepted: string[]; rejected: string[]; outdated: string[]; overlapping: string[];
};
```

`State` adds `proposals: Record<string, Proposal>` and `proposalWrites: Record<string, ProposalWrite>` and becomes v4. A malformed nested proposal yields a bounded `proposalError` on its highlight/selection, rather than a writable record. A source-unavailable selection uses the already-valid empty quote version `''` to mean no snapshot; never substitute a different revision. `ReplyInput` adds index-aligned `proposalTargets?: Array<PreparedProposal | null>`; `selectionVersion: ''` is deliberate, while an omitted selection version remains a programmer error when saving highlights.

## Task 1: Parse proposals and preserve them in compatible state

**Files:** Create `src/proposals.ts`, `test/proposals.test.ts`; modify `src/reply-metadata.ts`, `src/store.ts`, `test/store.test.ts`, `test/library.test.ts`.

**Interfaces:** Export the shared types and `isProposalInput(value: unknown): value is ProposalInput`. Extend `HighlightInput` with `proposal?: ProposalInput` and `proposalError?: string`. Retain the `parseReply(text)` signature. Add proposal/state validators and v4 migration through `readSavedState`/`openStore`; `reply` creates records once alongside response selections when supplied with prepared targets.

- [ ] Install locked dependencies with `pnpm install --frozen-lockfile` in this task worktree; use existing setup evidence rather than invoking the missing setup script again.
- [ ] Add failing parser tests. Assert a valid nested proposal survives, an ordinary highlight is unchanged, invalid/no-op/oversized proposals produce no actionable input, and a bad proposal does not slide `selection-N` links or discard valid highlights. Include partial JSON, invalid full JSON, an array of 21 highlights, 16,384/16,385-character strings and 512/513-character contexts.

  ```ts
  const parsed = parseReply('[[sidecar-meta {"highlights":[{"exact":"Retries","proposal":{"before":"Retries: 3","after":"Retries: 4"}}]}]]\nReview this.');
  assert.equal(parsed.text, 'Review this.');
  assert.deepEqual(parsed.metadata.highlights?.[0]?.proposal, { before: 'Retries: 3', after: 'Retries: 4' });
  ```

- [ ] Add failing migration/routing tests: v1/v2/v3 preserve every existing field and snapshot, add empty maps, save exact backups, retain a prior different backup, and restart v4 without changing decisions. Reject unknown versions and dangling proposal/message/selection/write relationships without rewriting the input. Library reads of older owners must not migrate their files on disk.
- [ ] Run `node --import tsx --test test/proposals.test.ts test/store.test.ts test/library.test.ts`; confirm new expectations fail before implementation.
- [ ] Implement the types/parser/migration. Reject malformed proposal records, enforce finite timestamps/ranges and same-document routing, and keep user/agent text unchanged. In `reply`, derive server UUIDs and links from its newly created message/selections; repeated completed replies return before creating records. Malformed nested proposal text becomes the fixed diagnostic “This proposed change could not be prepared.”
- [ ] Run the same tests and `pnpm typecheck`; expect all green. Commit the task as `feat: persist proposed document edits with replies`.

## Task 2: Prepare literal replacements and guard file publication

**Files:** Extend `src/proposals.ts`, `src/documents.ts`, `test/proposals.test.ts`; create `src/proposal-writes.ts`, `test/proposal-writes.test.ts`.

**Interfaces:**

- `prepareProposal(markdown: string | null, version: string | null, input: ProposalInput): PreparedProposal` captures a unique literal target plus source context or an outdated reason.
- `planReplacements(markdown: string, proposals: Proposal[]): { markdown: string; applied: Array<{id: string; range: SourceRange}>; outdated: Array<{id: string; reason: ProposalReason}>; overlapping: string[] }` accepts pending records and returns one prepared result. Applied ranges refer to the resulting source.
- Extract `readSourceFile(path: string): Promise<SourceFile>` into `src/documents.ts`; `SourceFile` contains canonical path, bytes, markdown, hash/version and `{dev, ino, mode}` identity. Existing `readDocument` delegates to it but keeps its public response shape without exposing raw buffers or identity.
- `prepareFileWrite(source: SourceFile, markdown: string): Promise<PreparedFileWrite>` creates a sibling temporary file preserving permissions; `publishFileWrite(write: PreparedFileWrite): void` rechecks path, identity and byte hash synchronously then atomically renames; `discardFileWrite(write: PreparedFileWrite): Promise<void>` cleans unused temporary files. Prepared data contains before/after versions and the source needed for snapshots.

- [ ] Add failing literal-match tests for Markdown formatting, quotes, emoji, shifted targets, empty replacement, insertion via replacement, repeated passages with and without context, and removed targets whose words remain elsewhere. Assert smart quotes and whitespace differences do not qualify a source replacement.

  ```ts
  const target = prepareProposal('Intro\nRetries: **3**\nEnd', 'v1', { before: 'Retries: **3**', after: 'Retries: **4**' });
  assert.deepEqual(target.baseRange, { start: 6, end: 20 });
  assert.equal(target.prefix, 'Intro\n');
  assert.equal(target.suffix, '\nEnd');
  ```

- [ ] Add bulk tests: disjoint replacements of different lengths yield correct resulting ranges; every intersecting range is excluded; adjacent ranges are allowed; identical duplicates conflict; one stale member does not prevent independent members from applying. Compare actual resulting text, not only counts.
- [ ] Add file tests using temporary files: untouched BOM/CRLF/Unicode bytes and mode survive; invalid UTF-8 fails before publication; symlink/nonregular target fails; an external edit or inode replacement between preparation/publication is preserved; a publication error does not report success and leaves no temporary sibling after cleanup.
- [ ] Run `node --import tsx --test test/proposals.test.ts test/proposal-writes.test.ts test/server.test.ts`; confirm failures for the new code, then implement the interfaces. Preserve existing strict path handling through the shared reader.
- [ ] Apply disjoint changes from highest to lowest old offset; compute final ranges using cumulative deltas in ascending order. Use literal saved source context for later validation, never old offsets alone. Read failure gives null version/range; missing/ambiguous text retains the real version with null range.
- [ ] Run the same tests plus `pnpm typecheck`; expect green. Commit `feat: validate and prepare exact document replacements`.

## Task 3: Capture complete proposals through both agent paths

**Files:** Modify `src/server.ts`, `src/store.ts`, `.agents/skills/sidecar/SKILL.md`, `README.md`, `test/stream.test.ts`, `test/direct-delivery.test.ts`, `test/server.test.ts`.

**Interfaces:** Existing `saveReply(input: ReplyInput)` reads and snapshots once, supplies aligned `proposalTargets`, and persists response/metadata together. Full `/agent/requests/:id/claim` context adds `proposals: Proposal[]` for that request's thread; compact native request events remain unchanged. Both native adapters still use the existing stream markers and metadata parser.

- [ ] Add failing tests to the existing Codex/Claude parameterized native-delivery fixture: a completed marked reply creates one pending proposal and leaves the file byte-identical; progress and incomplete/stopped metadata create none; duplicate completion and complete-reply recovery preserve the same proposal IDs.
- [ ] Add capture tests for a malformed nested proposal beside a valid ordinary highlight, a missing backing file, ambiguous source, and unique source with ambiguous rendered heading. Assert answers complete normally for source-read failures, show an outdated/diagnostic record, and never invent an original snapshot. Snapshot persistence failure retains the existing reply-recovery path.
- [ ] Run `node --import tsx --test test/direct-delivery.test.ts test/stream.test.ts test/server.test.ts` and confirm the new expectations fail.
- [ ] Wire capture to Task 2's preparation and Task 1's state. Capture proposals only after complete final metadata, never from progress or partial text. Preserve request batching and one final response; no hook or notification schema change. Add read-only proposal context to the full context response without enlarging native events.
- [ ] Update shared guidance with one nested-proposal example, source/rendered context distinction, exact limits, acceptance while the agent is busy, and rereading before subsequent direct edits. Explicit proposal requests use this flow; direct-edit requests still use Edit/apply_patch. Preserve the incorporated ambiguity guidance.
- [ ] Run the focused tests and `pnpm typecheck`; expect green for both adapters. Commit `feat: capture document proposals from Codex and Claude replies`.

## Task 4: Apply decisions with recovery and ownership checks

**Files:** Create `src/proposal-service.ts`, `test/proposal-service.test.ts`; modify `src/server.ts`, `src/store.ts`, `test/server.test.ts`.

**Interfaces:** `createProposalService({store, directory, changed})` returns:

- `withDocument<T>(documentId: string, operation: () => Promise<T>): Promise<T>`: serializes by the registered canonical path, checks registration again after obtaining the queue.
- `decide(proposalId: string, decision: 'accept' | 'reject'): Promise<DecisionResult>`.
- `acceptReply(threadId: string, messageId: string): Promise<DecisionResult>`: selects pending proposals from that one reply, never a caller-supplied text/path.
- `recover(documentId?: string): Promise<void>` and `drain(): Promise<void>`.

Viewer-only endpoints: `POST /api/proposals/:id/decision` with `{decision}` and `POST /api/threads/:threadId/messages/:messageId/proposals/accept` with `{}`. Return `DecisionResult`, then publish existing change events. Agent credentials alone cannot call viewer decision routes. `GET /api/state` includes durable records but not filesystem mutation capabilities.

- [ ] Add failing decision tests using an injected test Store that can fail selected persistence operations. Cover double Accept, Accept-versus-Reject, bulk-versus-individual, one stale member, every overlapping member, wrong-owner/response IDs, rejecting outdated entries, terminal idempotence, and proposals arriving during an unrelated active stream.

  ```ts
  // In the fixture, publish one pending replacement and record the initial bytes.
  assert.equal((await f.view(`/api/proposals/${proposal.id}/decision`, { decision: 'accept' })).status, 200);
  assert.equal(await readFile(file, 'utf8'), expectedAfter);
  assert.equal((await f.view(`/api/proposals/${proposal.id}/decision`, { decision: 'accept' })).status, 200);
  assert.equal(await readFile(file, 'utf8'), expectedAfter); // No second application.
  ```

- [ ] Add failure/restart tests at each boundary: before snapshots, after journal save/before publish, after publish/before accepted-state save. On restart, after-hash finalizes without rewriting; before-hash leaves pending for explicit retry; neither-hash preserves the external file, marks affected proposals outdated and retains an `unconfirmed` record. Do not later reinterpret already-unconfirmed evidence as a successful write.
- [ ] Add concurrency tests for external modification during preparation, document close during acceptance, final reply completion during close/acceptance, and shutdown while a decision is saving. Assert no dangling records or post-close snapshot recreation. Preserve partial native output and queue status throughout.
- [ ] Run `node --import tsx --test test/proposal-service.test.ts test/server.test.ts`; confirm new tests fail.
- [ ] Implement serialization and decision/recovery logic. Save both version snapshots and a `prepared` write record before publication; then publish synchronously, save accepted decisions/result ranges, and delete the journal entry. For a conflict, never write the stale preparation. Unconfirmed entries remain evidence but do not block later independent operations after fresh validation.
- [ ] Wire `saveReply` and close-document through the same document queue; keep existing tracked reads outside that queue to avoid close waiting on a reader queued behind itself. Lock order is document operation then `store.update`; never await native capture while holding the document queue. Startup recovers before accepting viewer writes, and shutdown drains document operations before reporting completion. Close deletes proposals/write evidence with the document after serialization.
- [ ] Recheck other pending document proposals after accepted writes and during source refresh on a version change. Keep this idempotent; do not rewrite state on every poll. Transient I/O errors show an actionable error without falsely claiming a write or decision succeeded.
- [ ] Run focused tests plus `pnpm test` and `pnpm typecheck`; expect green. Commit `feat: apply and recover user-approved document changes`.

## Task 5: Add reply cards and the document review popover

**Files:** Create `web/ProposalReview.tsx`, `web/usePosition.ts`; modify `web/app.tsx`, `web/conversations.tsx`, `web/PinnedWindows.tsx`, `web/api.ts`, `web/app.css`, `test/browser.spec.ts`.

**Interfaces:** Export `ProposalCard({proposal, selection})`, `ReplyProposalActions({proposals})`, and the controller below. `ProposalCard` takes `Proposal` and existing `MessageSelection`; `ReplyProposalActions` takes that reply's `Proposal[]`. A shared review context lets normal and pinned message cards use the same controller/decision state; no duplicated pin-specific behavior.

```ts
useProposalReview(options: {
  documentId: string; proposals: Proposal[]; selections: MessageSelection[];
  article: RefObject<HTMLElement | null>; version: string; isHistorical: boolean;
  onShowSelection: (selection: MessageSelection) => void;
  onShowOriginal: (selectionId: string) => void;
  onReturnToCurrent: () => void;
}): {
  context: ProposalReviewContextValue; popover: ReactNode;
  open: (selectionId: string, invoker: HTMLElement | null) => boolean;
};
```

`ProposalReviewContextValue` is private to the review module's provider/components; expose its inferred return type to the caller without duplicating its internal state in App. `open` returns false for an ordinary selection so the caller continues its existing navigation behavior.

Extract `usePosition(ref, anchor, width, preferAbove?, bounds?)` without changing existing call behavior. Optional bounds restrict proposal popovers to `.canvas`; existing comment menus keep viewport bounds. Current-document annotation activation calls `open` before the normal thread-jump path; ordinary annotations continue unchanged. Reply links to proposal selections open review without scrolling the thread.

- [ ] Add failing browser tests for annotation-click, reply-link and card entry points; verify no backing-file change before Accept, real file change after Accept, Reject preserving bytes, and decisions retained after reload. Test per-reply Accept all with another reply untouched, mixed stale/valid items, and overlapping proposals with an individual-review explanation.
- [ ] Add tests for keyboard opening/closing, focus restoration, outside click, scroll/reflow, narrow viewport, sidebar resizing, hidden/resolved selections, pinned windows and unsent drafts. Historical view has no enabled write action. A source-unavailable or invalid proposal has explanatory copy and no enabled Accept.
- [ ] Add formatting-only and deletion tests that inspect visible removed/added text and the raw source difference. Include untrusted HTML/links to verify existing sanitization; no proposal preview executes markup. Clarifying an ambiguous navigation highlight must not enable an ambiguous source proposal.
- [ ] Run `pnpm exec playwright test --grep 'proposal'`; confirm new tests fail.
- [ ] Implement the approved compact cards and one document-anchored nonmodal popover. Reuse the existing selection visibility row rather than duplicating controls. Show rendered before/after fragments with `−`/`+` and an expandable exact-source diff using installed `parseDiffFromFile`/`FileDiff` in read-only unified mode; automatically expose source for formatting-only differences. Do not add a full editor or fullscreen mode.
- [ ] Keep **Accept all (N)** above that response's proposals. Show result counts and per-item reasons. Accepted/rejected records show **View change**; pending records show **Review change**. An unavailable rendered range anchors the read-only review to its invoking card instead of inventing a document location. The server alone decides whether source acceptance qualifies.
- [ ] Clear active popovers on document close/switch; refresh decision state from existing events. Disable repeated clicks while their operation is pending, preserve errors for retry, and do not toggle highlight visibility, resolve threads, submit agent questions or edit drafts as side effects.
- [ ] Run proposal browser tests, incorporated ambiguity regressions, existing selection/pinned/navigation tests, and `pnpm typecheck`; expect green. Commit `feat: review proposed edits beside document annotations`.

## Task 6: Verify the combined branch and perform one release

**Files:** Update README and both design/plan documents with implementation evidence; product/test fixes only where final verification finds a task-relevant failure.

**Interfaces:** Existing `install.sh`, shared plugin packaging, Herdr agent-owned app upgrade workflow. No new deployment or migration service.

- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm exec playwright test`, and `git diff --check` from this worktree; collect each real exit code. Background independent long checks. Any pre-existing browser failure needs a same-base reproduction before exemption; do not assume an old failure still applies.
- [ ] Exercise disposable Codex and Claude owners through the native adapter fixtures, proposing the same replacement and accepting it while a separate reply is active. Confirm one source write, independent proposal history, preserved captured reply output and no extra native request.
- [ ] Open a disposable browser preview of the completed feature. Show a document popover, accepted/rejected history, mixed-validity Accept all, and the incorporated **Choose passage** fix. Preserve the user's real tabs/drafts. Check usable viewport layout and inspect browser errors.
- [ ] Obtain the final whole-branch review required by the chosen execution workflow. Reproduce findings before changing code; verify the affected path after fixes. Do not request a GitHub Claude review or spend its Actions usage without separate authorization. Honor the user's rule requiring approval before committing any Claude-review-driven changes if such a review is explicitly requested later.
- [ ] Annotate the spec with **As built** facts, completed verification and the optimistic external-writer limitation. Commit final docs and task-relevant fixes. No `active-projects` index exists for this single-PR task.
- [ ] Push the combined branch, create one draft PR covering proposed edits and ambiguity recovery, then ready and merge it only after checks and review are clean and the delivered behavior matches the approved design. The user authorized this combined PR, merge and upgrade; do not create a separate ambiguity PR. Use a body file for multiline `gh` descriptions.
- [ ] Update local main safely and run `bash install.sh`; verify `sidecar --version` matches the merge revision. Refresh both installed native plugins and verify their actual shared skill contents rather than trusting an “up to date” message from an unchanged plugin version. Preserve unrelated plugin settings and hooks.
- [ ] Use the Herdr skill and fresh process/session evidence to identify currently active Sidecar owners. The earlier user-approved viewer was child Codex `01a104c4-58ec-71b0-b477-ef691205fca3` in `wG:p79`; verify it again instead of trusting inherited pane IDs or `--current`. Do not resurrect a closed viewer in `wG:p74`.
- [ ] Send each verified, still-active original agent an upgrade handoff: finish/save pending replies, back up exact owner state/snapshots/backing Markdown, reload the shared skill, stop/reopen only its app with the existing file/workspace/port and `--no-browser`, and report migrated v4 counts plus byte/history preservation. Do not restart native agents or refresh their browsers and drafts. Handle requests arriving during maintenance through the existing recovery protocol without repeating document edits.
- [ ] Verify the returned revision/state/connection reports, report the merged PR and upgrade result, and retain recovery backups and old releases. Any owner that cannot safely upgrade remains running its prior version with a concrete explanation.

## Plan Self-Review

- Metadata, both adapters, exact matching, migration, guarded writes, crash recovery, UI and release each have an owner task and a regression gate.
- Navigation ambiguity and source replacement use independent matchers; no clarification can bypass source checks.
- Existing requests and transport remain independent of proposal decisions. The plan adds no agent round trip, editor dependency or multi-file mode.
- Execution recommendation: **Native in this session**, followed by a fresh whole-branch review. The tasks share state/capture/write interfaces and benefit from one implementer retaining that context; the final review remains independent.
