# Mid-turn input implementation plan

> Execute inline using superpowers:executing-plans. User approved implementation; later cross-thread, CLI-work and bandwidth requirements amend the original same-thread-only plan.

**Goal:** Deliver Sidecar inputs during any attached-agent work, route replies continuously by thread and receipt, and stop that agent before output, for both Codex and Claude.

**Architecture:** Immutable input batches; same-thread completion coverage; one owner observer; existing native transport, viewer SSE and recovery. No new dependency or answering agent.

**Spec:** [Approved design](../specs/2026-10-06-mid-turn-followups-design.md).

Worktree: `/Users/seanoh/ws/pg/sidecar/.claude/worktrees/mid-turn-followups`, branch `feat/mid-turn-followups`. All edits/checks run here. Shared skill source `.agents/skills/sidecar/SKILL.md`. No live AMC changes, installation or PR during implementation.

## Preparation

- [x] User approved design and execution, including later scope amendments.
- [x] Dedicated worktree; no nested instructions. Required setup script was attempted but does not exist in Sidecar.
- [x] Frozen install, baseline 204 backend tests and server/web typecheck pass.

### Task 1: Durable batch coverage

Files: `src/store.ts`, store/batching/proposals/library tests.

- [x] Red tests for simultaneous same/cross-thread claims, combined/older-first completion and exact v4 backup.
- [x] Add request `covers`, `answeredBy`, native turn/handoff fields. Remove global claim exclusion; keep immutable batches. Coverage includes only earlier accepted unfinished same-thread leaders. No separate group manager.
- [x] Settle only persisted coverage; preserve independent prior answers; late superseded finals have no effects. Validate routing and cycles through backward-only coverage.
- [x] Migrate to state v5 using existing backup and validation paths.
- [x] Focused 50 tests and typecheck pass.
- [ ] Commit `feat: persist reply coverage across concurrent thread inputs`.

### Task 2: Native input/control and reply routing primitives

Files: `src/codex-stream.ts`, `src/codex-queue.ts`, `src/stream.ts` and their tests.

- [ ] Red regressions for exact-turn steering, lost acknowledgment, pre-output Stop and stale clicks.
- [ ] Extend existing observer/control with native steer and independent exact-turn interruption. Preserve idle queue/start behavior and retain started turn identity.
- [ ] Stable thread tag plus generated request receipt in prefix; preserve legacy parser callers. Route multiple marked blocks in one native message with existing limits/order validation.
- [ ] Focused native/parser tests and typecheck; commit `feat: steer native input and retain tagged reply boundaries`.

### Task 3: Both transports, capture, UI and recovery

Files: `src/server.ts`, `src/agent.ts`, `hooks/control.js`, `web/api.ts`, `web/conversations.tsx` and relevant integration/browser tests.

- [ ] Red tests for busy delivery across threads/CLI work; every batch keeps its own receipt and capture. New preparation cannot erase streaming output.
- [ ] Replace owner-wide single-request guard with outstanding deliveries and one continuous observer. Preserve compact events/oversized fallback, serialized handoff/capture and bounded reply-only recovery.
- [ ] Publish independent agent control state and authenticated exact-turn Stop. Empty composer shows Stop agent from any thread before output; typed input keeps Send.
- [ ] Interrupted/completed native turns settle only matching deliveries. Completed answers win; uncertain handoffs are not replayed. Keep Reset and restart safe.
- [ ] Add measured interleaved-output bandwidth regression using lightweight SSE; no full history/document with chunks.
- [ ] Focused tests, typecheck, backend and browser checks; commit `feat: deliver cross-thread inputs during active agent work`.

### Task 4: Shared guidance and live verification

Files: `.agents/skills/sidecar/SKILL.md`, README, relevant tests and dated acceptance evidence.

- [ ] Shared Codex/Claude guidance: receipt-tagged replies, same-thread coverage, separate cross-thread replies, progress/recovery/Stop. No extra tool calls for normal prepared events.
- [ ] Disposable real Codex and Claude: hold tool busy, send correction and different-thread question; verify native receipt and final routing. Stop before output and from another thread, preserving partial/completed work and queued input.
- [ ] Record client versions, timing and bandwidth evidence. No live user/AMC documents touched.
- [ ] Final focused checks and whole-branch fresh reviewer; resolve reproduced findings and verify.
- [ ] Update spec as built; commit `docs: document mid-turn delivery and agent-wide stop`; report result and concrete limitations. PR/merge/install remain outside this approval.
