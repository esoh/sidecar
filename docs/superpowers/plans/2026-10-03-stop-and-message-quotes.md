# Stop and Message Quotes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved scope inline, task by task.

**Goal:** Safely stop a Sidecar request and quote sent-message text in the next reply.

**Architecture:** Reuse reply capture, the existing store transaction, and shared message/composer rendering. Cancel by native turn ID, gated by marked Sidecar output and an available control channel. Store message quotes separately from document anchors.

**Tech Stack:** Existing TypeScript, React, node:test and Playwright; native Codex WebSocket and Claude plugin module.

**Spec:** [Approved scope](../specs/2026-10-03-stop-and-message-quotes.md).

## Global constraints

- Both Codex and Claude; no unrelated-turn interruption, rollback or automatic retry.
- One attachment per input; no new dependencies.
- Work in `.claude/worktrees/request-cancellation`; live user sessions are not probe targets.

## Review focus

- A stale browser tab must not interrupt a newer native turn (task 1).
- Native completion can race cancellation and Claude display-hook delivery (task 1).
- Unmarked terminal output must never enter the reply or enable Stop (task 1).
- Quotes from a different pinned conversation must retain their source IDs (task 2).
- Selecting rendered Markdown across inline formatting must capture readable text (task 2).

### Task 1: Native request cancellation

Files: `src/{codex-stream,stream,server,store}.ts`, `hooks/{hooks.json,control.js}`, `web/{api,conversations}.tsx` (API is `.ts`), `test/{codex-stream,stream}.test.ts`, `test/browser.spec.ts`, README.

Interfaces: `CodexObserver` remains callable for cleanup and adds `canInterrupt(turnId)` and `interrupt(turnId)`. Optional `onTurnEnd(turnId,status)` receives the native event. `ReplyStream.turnId` records only a matching marker. Viewer stream exposes `turnId`, `canStop`, `stopping`, `stopError`. `POST /api/requests/:id/stop` takes `turnId`; authenticated Claude `POST /agent/control` polls and reports completion/interruption.

- [x] Correct the Codex `turn/completed` fixture to `params.turn.id`; observe red, fix, run observer tests green.
- [x] Verify both installed native APIs in disposable sessions, including mid-output interruption.
- [x] Add failing integration checks: no Stop before matching output/control, stale IDs reject, interruption saves partial text once, completed replies win, late output cannot reopen the request.
- [x] Implement exact-turn controls, transient stopping/error state, durable stopped result, and Claude plugin control polling while a turn runs.
- [x] Add composer Stop gating and Stopped display; Enter on empty input must not interrupt.
- [x] Verify focused tests, both native end-to-end paths, and browser Stop behavior.

### Task 2: Quote a sent message

Files: `src/{quote,store,server}.ts`, `web/{conversations,app,PinnedWindows}.tsx`, `web/useQuestionDrafts.ts`, shared Sidecar skill, `test/{store,delivery}.test.ts` and `test/browser.spec.ts` (use existing delivery test filename).

Interfaces: `MessageQuote = {threadId:string,messageId:string,exact:string}` is optional `messageQuote` on input/request/user message/draft. It is mutually exclusive with document `quote`. `MessageContent` reports selection through `onQuoteMessage(quote)`; App chooses the next-reply thread.

- [x] Add failing store/delivery checks for source ownership, attachment exclusivity, idempotency, persistence and compact event context.
- [x] Add the optional quote field, source validation, shared selection capture and removable quote badge. Never paint message quotes on the document.
- [x] Verify conversation, floating window and dock selection, keyboard selection, drafts/reload, formatted text, replacement/removal and sent history.
- [x] Update shared skill and README; typecheck and run relevant backend/browser checks.

### Completion

- [x] Fresh review of the combined diff; fix material issues with regression proof.
- [x] Show the user a working preview. No live pane upgrade is needed before this feature is reviewed.

Execution record: baseline 68 tests passed; Codex event regression failed with the real schema and then passed (5 observer tests). Disposable Claude 2.1.288 and Codex 0.160.0 returned native interrupted status with partial marked output; scratch evidence is under `/private/tmp/sidecar-stop-native.95wqWf` for this session only.

As built: native Claude and display hooks use different turn IDs in 2.1.288. The plugin binds native control to the exact reply marker in `turn.step`. Complete native answers racing interruption go through ordinary reply/metadata persistence. The final review also caught a hidden conversation draft attachment being removed when quoting from another pinned thread; the shared selection cleanup now preserves it. Both fixes have regressions observed failing before passing.

Additional user-authorized fix: normalize straight/curly quote characters in shared passage matching, retaining UTF-16 offsets and ambiguity checks. This resolves the two unchanged admission highlights that incorrectly showed “Passage changed”; genuine changes and historical previews remain covered. Queue batching was discussed but is outside this implementation.
