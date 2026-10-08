# Compact protocol acceptance — 2026-10-08

Implemented in the dedicated `feat/compact-agent-protocol` worktree. All test viewers and registries used temporary state roots. Existing user viewers, documents, queues, tunnels and installed plugins were untouched.

## Native evidence

- **Claude Code 2.1.293, medium effort:** a session-local copy of the updated native module and the real MessageDisplay hook received a 10,187-character input after a foreground Bash tool returned. The answer preserved random head/middle/tail values and the original tool result in the same native turn. Only one main-session tool call occurred; no context-fetch command was needed. A subsequent idle input used native prompt submission. A third input ended its turn with only a progress reply, remained claimed without recovery, retained that progress in history, and completed on a later terminal prompt. Evidence: `/private/tmp/sidecar-integrated-native-iw9i63qh/verification.json`, `native-events.json`, and its isolated saved state.
- **Codex CLI 0.161.0:** three compact inputs arrived during a foreground CLI tool wait. A same-thread correction covered the earlier unanswered input; another thread received its own answer in the same turn. The saved corrected answer contained `cobalt` and the original tool result; the other reply was `42`. No context-fetch command ran. A later unrelated CLI tool was interrupted through Sidecar before any Sidecar output. Evidence: `/private/tmp/sidecar-codex-compact-MEj1MX/verification.json`, `events.json`, and `state.json`.

Earlier native checks exposed limitations that mock tests did not: one hook module per plugin; no duplicate unqualified handler for an event; and native `$` APIs cannot be inspected as values for feature detection. The first two were test-harness mistakes. The last required replacing the module's `typeof $.prompt` checks with supported direct calls. Claude's native prompt-suggestion helpers attempted separate commands during testing; these were denied by the scratch permissions and were not main-session request processing.

The pre-change shared-skill baseline answered an `sc.request` without compact markers because it expected a supplied stream object. The updated shared guidance produced the marked, durably captured native replies above.

## Automated coverage

All 253 backend tests pass. The two focused browser checks pass for compact progress/final text, title/highlight/proposal metadata, hidden protocol syntax, partial output, Stop and reload. Server/browser TypeScript checks pass. The backend regressions cover registry concurrency/non-reuse/failure, capability negotiation, immutable delivery format, alias ownership, compact and legacy framing, native inbox deduplication, submission failure, progress-only completion, real incomplete-final recovery, interruption and queue reconciliation.

A full run exposed two existing test timing assumptions made more visible by additional I/O: Reset waited for only the first of two intended deliveries, and its deliberately held HTTP completion could deadlock fixture teardown. The tests now wait for both deliveries and release the held completion in the test body’s finally block, before teardown closes the server. Claude interruption fixtures now exercise the native inbox instead of expecting a suppressed legacy Monitor to deliver.

## Scope and remaining limits

Normal Claude busy delivery waits for the next main-session tool result; while generating an answer with no tool calls, it waits until idle. The module must be loaded at native session startup; reloading skill prose alone cannot replace an old module. Large inputs retain the existing 48 KiB context-fetch fallback. The viewer still makes no model calls and native delivery stays host-local, with existing lightweight SSE to browsers.

Both adapters have automated interruption, stale-turn, recovery and cross-thread coverage. The native runs above are the actual cases exercised: live reply-only recovery, quoted-message continuity, and Claude same-turn cross-thread/Stop cases were not repeated in this acceptance run. No downgrade checks, token benchmark, full browser suite, installation or other-session upgrade was performed.

## Independent review

One independent whole-change review reproduced three handoff/capture defects. Each was independently reproduced, fixed and retained as a regression: a turn ending after inbox reservation now exposes the undelivered input as uncertain; a failed recovery submission marks the exact recovery attempt failed so manual retry works; and an incomplete later final block in a native completion snapshot preserves its partial output and receives the correct recovery/Stopped outcome before delayed display capture. Completed replies and stale-turn/attempt protections remain intact.

A separate API-boundary check caught native `prompt.submit` returning `{drop: reason}` without throwing. That refusal now takes the same visible, non-replaying failure path. The final Claude acceptance run above used the reviewed hook including these fixes.
