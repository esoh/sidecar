# Message Selections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach one optional passage to each user input, preserving earlier selections and document history within the same conversation.

**Architecture:** Move selection ownership from threads to user messages and keep the accepted request's own quote snapshot. Migrate version-1 state once with a backup; share existing document-version files. Reuse the current composer, highlighter, draft storage, and original-document viewer.

**Tech Stack:** TypeScript, Node, React, Plannotator renderer/highlighter, existing Node tests and Playwright; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-message-selections-design.md` (corrected click-away behavior approved on 2026-10-02).

## Global Constraints

- One optional selection per user message; agent messages do not own selections.
- Both Claude and Codex keep the original owner, compact events, sequential requests, and request-local quote context.
- Clicking away to dismiss clears the highlight and pending attachment, preserving typed text; composer interaction keeps the attachment.
- Comment/C starts a new thread and moves the pending selection to it, preserving the previous draft's text.
- Preserve the existing 100 ms draft debounce, retry identity, IDs, titles, resolution, and accepted requests.
- One snapshot per document/content hash; no full Markdown per message or thread.
- Keep existing thread-title editing; remove thread-level passage UI and annotation/general distinction.
- The same PR also contains independently verified progress history, Working after successful handoff, and highlight-intensity settings. Do not regress these.

## Review Focus

- Multiple messages select identical or overlapping text: each must remain independently reachable (Task 4).
- A send succeeds but its response is lost while the user edits a newer draft: retry must not duplicate the input or erase the newer selection (Task 3).
- A migration write fails or a legacy annotated thread has no user input: retain original bytes and report the problem (Task 1).
- Another owner's stopped documents are browsed: understand both versions without modifying that owner's state (Task 1).
- A saved selection is unavailable in the current file and its old snapshot is missing: keep the conversation and omit View original document (Task 4).

## Task 1: Migrate selection ownership safely

**Files:** `src/store.ts`, `src/library.ts`, new `src/quote.ts`; `test/store.test.ts`, `test/library.test.ts`.

**Interfaces:** `Message.quote?: Quote`; version-2 `Thread` removes `scope` and `quote`; `State.version` is 2. `readSavedState(value: unknown): State` validates v1/v2 and returns v2 in memory without filesystem writes. `Quote` and `isQuote(value: unknown): value is Quote` move to the browser-safe `src/quote.ts`; retain store re-exports for existing callers.

- [ ] Add failing tests using literal v1 fixtures. Assert `migrated.version === 2`, `thread.messages[0].quote` equals the legacy quote, later messages have no quote, and all original IDs, accepted requests/signatures, timestamps, answers and snapshot hashes survive. Add malformed/no-user-message cases, existing progress messages, repeated startup, failed write, and read-only library checks.
- [ ] Run `node --import tsx --test test/store.test.ts test/library.test.ts`; confirm the missing migration causes failures.
- [ ] Implement validation and pure normalization in `src/store.ts`. Validate owner/routing and the first user message before mutation. A first general thread is created only when the document has no threads. On owning `openStore`, write original v1 bytes once to `state.v1.backup.json` with exclusive creation before publishing v2 using the existing atomic rename. Never overwrite that backup. Library reads normalize in memory only; old readers reject v2.
- [ ] Run the focused tests and `pnpm typecheck`. Confirm failed migration leaves `state.json` byte-for-byte unchanged and library reads write no files.
- [ ] Commit `feat: migrate passage selections onto user messages`.

## Task 2: Keep selection context local to each submitted input

**Files:** `src/store.ts`, `src/server.ts`, `.agents/skills/sidecar/SKILL.md`, `README.md`; `test/store.test.ts`, `test/server.test.ts`, `test/direct-delivery.test.ts`.

**Interfaces:** Existing `SubmitInput` accepts both `threadId` and optional `quote`; `RequestRecord.quote` remains its accepted snapshot. `createThread` creates a plain conversation without selection ownership. Existing prepared-event routing fields and progress/final markers are unchanged.

- [ ] Add failing assertions for one thread receiving selected, unselected, then differently selected inputs: `messages.map(m => m.quote?.exact)` must be `['first', undefined, 'second']`; request quotes match the respective messages. Assert old accepted payloads/signatures are untouched and retries remain idempotent. Exercise these cases through both native adapter fixtures.
- [ ] Run `node --import tsx --test test/store.test.ts test/server.test.ts test/direct-delivery.test.ts`; confirm the old thread-quote assumptions fail.
- [ ] Allow `threadId` plus `quote`, validate/copy onto the user message and request, and remove thread fallback. Derive prepared-event quote context from the request. Update the canonical shared skill to explain that earlier messages can have different selections; update documentation without altering native hooks.
- [ ] Run the focused tests and `pnpm typecheck`; check legacy interrupted requests still require reconciliation and are not resent by migration.
- [ ] Commit `feat: route message-specific selection context`.

## Task 3: Attach, dismiss, and persist the pending selection

**Files:** `web/conversations.tsx`, `web/app.tsx`, new `web/useQuestionDrafts.ts`, `web/app.css`; `test/browser.spec.ts`.

**Interfaces:** `QuestionDraft` gains `quote?: Quote`. Extract the existing per-thread persistence into `useQuestionDrafts(documentId: string)`, exposing `get(threadId: string): QuestionDraft | undefined`, `set(threadId: string, draft: QuestionDraft): void`, `remove(threadId: string): void`, and `flush(): void`. App and sidebar share that one draft owner. Keep the floating new-comment draft separate until submitted, as today.

- [ ] Add failing browser cases for automatic attachment, replacement, badge removal, outside-click dismissal with text preserved, composer clicks retaining the quote, thread switch/reload recovery, selection-only drafts, and no-selection follow-ups. Cover failed sends, lost responses, and newer draft text/selection created during an in-flight send.
- [ ] Run `pnpm exec playwright test -g 'message selection|selection draft'`; confirm absent message-local behavior fails.
- [ ] Lift shared draft access through the hook and reuse existing validated text/retry loading; accept legacy text-only drafts. Validate saved quotes with `isQuote`. Persist with the existing 100 ms debounce and flush on switches/unload. A selection-only draft is nonempty.
- [ ] Attach a captured quote to the open conversation's next input and paint its pending highlight. Dismissal clears that draft quote and painted selection together. Treat composer interaction and explicit thread navigation separately from outside dismissal. Comment/C transfers the quote into the floating new-thread composer, keeping the prior text. Send text+quote+threadId together, and clear only the submitted draft on success.
- [ ] Run the focused browser cases and `pnpm typecheck`. Confirm existing keyboard, copy, overlap, and empty-thread behaviors still pass.
- [ ] Commit `feat: attach selections to conversation drafts`.

## Task 4: Render message selections and preserve their history

**Files:** `web/conversations.tsx`, `web/app.tsx`, `web/OriginalDocument.tsx`, `web/thread-search.ts`, `web/app.css`; `test/browser.spec.ts`.

**Interfaces:** Highlighter IDs are selected user-message IDs. App tracks `activeMessageId` and `originalMessageId`; `openMessage(threadId: string, messageId: string)` opens the thread, targets its input, and emphasizes only that passage. The original viewer receives that message's quote and uses its ID for the painted anchor.

- [ ] Add failing cases for two selected messages in one thread, identical/overlapping selections, exact-message navigation, badge-to-passage navigation, changed passages, missing snapshots, resolve/reopen, and search matches from earlier message quotes.
- [ ] Run `pnpm exec playwright test -g 'message passage|message history'`; confirm the thread-level implementation fails.
- [ ] Render a compact selection badge plus two-line excerpt with each selected user input using Plannotator Ask AI styling. Put Passage changed and optional View original document on that message. Remove the thread-wide quote header and annotated/general icon distinction; retain title pencil, status indicators and filter.
- [ ] Paint unresolved message quotes and resolve overlapping clicks by message ID, including multiple messages in one thread. Badge clicks navigate to their own quote. Move original-view state to the selected message; preserve Return to current and absence of the link when a snapshot is unavailable. Search each message's text and quote. Do not copy document snapshots.
- [ ] Run these browser cases plus existing renderer, scroll, resolve, original-document and search cases, and `pnpm typecheck`.
- [ ] Commit `feat: show passage context on individual messages`.

## Task 5: Verify and release the combined PR

**Files:** Existing acceptance tests, shared documentation, and the design/plan's implementation notes.

- [ ] Run `pnpm typecheck`, `pnpm test`, `pnpm exec playwright test`, and `git diff --check`. Collect actual exit codes. Fix failures before release.
- [ ] Verify the visible app in Chrome using scratch state: selected/unselected follow-ups, click-away dismissal, an old-version view, dimmed highlights, Working after handoff, and persisted progress plus final messages. Verify both native agents with disposable documents; retain no test changes in production state.
- [ ] Mark the design As built and record concrete verification evidence. Commit documentation with the completed feature.
- [ ] Create the single authorized PR, confirm stable commits/base and green checks, then merge it to main. Do not request an external Claude review unless the user asks.
- [ ] Install the merged app and refresh both Codex and Claude plugin copies. Verify installed revision and shared skill hashes.
- [ ] Back up and upgrade this conversation's Sidecar owner only after pending requests finish; confirm v2 migration preserves documents, requests, messages and snapshots. Verify wG:p74's live native identity, ask that agent to finish/reconcile requests and update its own app, then confirm its installed/running revision and saved counts. Preserve all draft/browser state.
