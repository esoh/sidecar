# Document Conversations Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the bare thread list with the approved document conversation UI.
**Architecture:** Persist empty threads and optional stable names in the existing store; reuse question/reply/stream routes and the shared agent skill. React owns list/selection state and retains draft/scroll state per thread.
**Tech Stack:** Existing React, CSS, Node/TypeScript, web-highlighter, node:test, Playwright.
**Spec:** ../specs/2026-10-01-document-conversations.md

## Global Constraints

- Both Codex and Claude use their original session; no transport replacement or dependencies.
- Existing version-1 state remains readable; existing thread history is never dropped.
- Edits and verification stay in conversation-sidebar worktree; no push/merge.

## Review Focus

- Lost create/send responses must not duplicate conversations or questions.
- Delayed replies/saves must not erase drafts or move the active thread.
- Existing state without thread metadata must reopen normally.
- Deleted/ambiguous passages preserve discussion without jumping to a wrong quote.
- Narrow viewport, keyboard/IME, and simultaneous file/stream updates preserve usable controls.

### Task 1: Persist empty conversations and stable agent names

**Files:** src/store.ts, src/server.ts, src/cli.ts, .agents/skills/sidecar/SKILL.md, test/store.test.ts, test/server.test.ts, test/agent.test.ts.
**Interfaces:** POST /api/threads {id, documentId} returns an idempotently-created empty general Thread. Thread adds optional title/createdAt for legacy compatibility. POST /agent/threads/:id/title sets a valid title once. CLI name-thread ID --owner KEY --title TEXT uses that route for either agent.
- [x] Add failing tests for default general thread, empty creation/retry routing, persisted legacy upgrade, stable naming and invalid title inputs; run focused node tests and confirm failure.
- [x] Implement creation/naming in the existing store/routes, add the CLI command and shared skill instruction to name after claim when context allows, before emitting final stream markers.
- [x] Run node tests and typecheck; verify both CLI owner types exercise the same naming path.

### Task 2: Implement approved viewer and preserve existing behavior

**Files:** web/app.tsx, web/app.css, web/api.ts, web/conversations.tsx, test/browser.spec.ts, README.md, THIRD_PARTY_NOTICES.md.
**Interfaces:** Use Task 1 Thread metadata and create API; keep existing request idempotency, selection, stream and title APIs. Sidebar receives real threads, pending requests and stream state; selection changes only by explicit navigation or successful send.
- [x] Adapt browser assertions to the approved UI; add failing coverage for list filtering, multiple general threads, switching drafts/scroll, background reply isolation, auto names, growing composers, Enter/Shift+Enter/IME and inline title save/cancel/failure.
- [x] Keep selection capture/highlighting in App; put sidebar/form/title presentation in conversations.tsx. Adapt approved prototype CSS and preserve safe React rendering.
- [x] Run full node tests, typecheck and browser tests. Inspect the real viewer through Chrome against isolated fixture state. Verify no regressions in popup placement, failed retries, overlaps, file replacement or late resolved replies.
- [x] Update usage/attribution, review the complete local diff, and leave changes uncommitted for user review.

## As built — 2026-10-01

- Implemented in the `conversation-sidebar` worktree, left uncommitted for review. No dependencies added and no agent transport changes.
- Kept the thread naming route as POST to reuse the existing agent CLI helper for both Codex and Claude. The shared Sidecar skill tells either owner to name an unnamed thread when context is sufficient.
- Extracted the existing viewer API helper/types into `web/api.ts` so App and the conversation components share the same request behavior.
- Read-only local review reproduced three delayed-response problems: an old send clearing a newer draft, title saves stealing focus/dropping a later blur-save, and a create response overwriting newer messages. Four regression tests first failed, then passed after conditional draft clearing, serialized title saves, focus ownership checks, and insertion-only handling of create responses.
- Final checks: `pnpm test` (36 passed), `pnpm typecheck`, `pnpm exec playwright test` (21 passed), and `git diff --check` passed. Both owner types exercise naming and streamed request handling through the actual CLI in isolated adapter tests; no new live original-agent probe was run.
- Inspected the real React viewer in Chrome using isolated sample state. Existing original-agent viewers and the Plannotator reference remained untouched. Browser automation covered a narrow viewport; physical mobile keyboards and non-Chromium textarea sizing were not exercised.

### Status and thread-indicator refinement — 2026-10-01

- Added native original-agent status in the top-right header, kept separately from the queued-message count. Added unread/queued/in-progress indicators beside previews and browser-local read markers.
- Extended the existing lifecycle endpoint/CLI, shared Claude skill hooks, and optional hook examples. Added read-only Codex status sampling using its existing socket; it issues only initialize/initialized/thread/read and stops with the app. No new dependencies, sessions, prompts, or global settings changes.
- Verified a live read-only status lookup against the current Codex session: Busy. Claude event forwarding and owner isolation passed synthetic tests; a newly invoked native Claude skill is needed to register the updated hooks. Native Claude interruption still lacks a Stop event, so status can lag until its next native notification.
- All 37 backend/adapter tests, 23 browser tests, typecheck, hook-frontmatter YAML parsing, and diff whitespace checks passed. Browser checks cover native status separate from queues, cross-document activity, unread persistence, and queued → claimed → replied indicator transitions.
- Corrected a pre-existing smooth-scroll race in thread position restoration by making conversation scrolling immediate. A browser assertion was also narrowed to the message log so it waits for a saved message rather than matching unsent textarea text.
- Refreshed the isolated sample viewer, retained its existing messages, and added a clearly named in-progress sample row for visual review. That viewer has no live agent, so its native status correctly remains Unknown.

### Submission follow-up — 2026-10-01

- User authorized submission and merge once ready, superseding the initial local-review-only constraint.
- A final local review reproduced cross-document tabs overwriting shared read markers. Per-thread localStorage keys now preserve independent markers and synchronize reads across tabs. The two-tab browser regression first failed, then passed.
- At the user's request, ported Plannotator's quick-menu click-away deselection, including its double/triple-click guard. Existing nonempty comment drafts retain their prior behavior.
- Actual overlapping mouse drags reproduced a selection lifecycle bug: repainting all marks and dismissing an empty composer on pointerdown destroyed the drag anchor. Adapted Plannotator's per-source cleanup; in-document dismissal now waits until mouseup. Tests cover both drag directions, empty/nonempty draft switching, and first-click navigation to saved highlights.
- Copied Plannotator's toolbar icon row, above-selection positioning, 150ms entrance animation, yellow pending selection, amber comment highlights, and native clipboard handling. Retained reduced-motion support and readable saved-highlight text.
- Final submission verification: all 37 backend/adapter tests remained current and passing; all 26 browser tests, typecheck, and whitespace checks passed after the selection changes. A final focused local review found no remaining blockers. Inspected the copied popup and highlight colors against the open Plannotator reference in Chrome.
