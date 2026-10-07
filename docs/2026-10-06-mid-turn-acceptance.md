# Mid-turn delivery acceptance — 2026-10-06

Verified in the dedicated `feat/mid-turn-followups` worktree with Codex 0.160.1 and Claude Code 2.1.292. Disposable native conversations, temporary Sidecar state and toy documents were used. No existing user viewer, document, native conversation, tunnel or installed plugin was changed.

## Native checks

Both native agents received three inputs during a CLI-originated tool wait: a color question, a same-thread correction, and arithmetic in another thread. All three deliveries bound to the existing native turn. The correction's reply completed the earlier unanswered input through `covers`; the other thread received its own answer. The final Claude terminal run explicitly checked that normal completion needed no reply-recovery attempt.

After those replies completed, each agent started unrelated CLI work. With no Sidecar output or active reply stream, the app exposed the exact native turn and successfully interrupted it. Tests also cover stale Stop clicks, interruptions between messages and during partial output, completed-answer precedence, and preserving unsent inputs.

Codex was exercised through its real shared daemon. Claude was exercised through its interactive terminal with a session-local plugin. An earlier Claude check exposed two native differences that mocks had missed:

- Version 2.1.292 requires helpers receiving `$` to be declared at module top level. The previous nested helper was rejected when loading the plugin.
- Monitor truncates long stdout lines. Busy notifications enter through `prompt.attachment`, not just `prompt.submit`. The module now restores a known prepared event from the local app before the model receives it, and records the native receipt. This adds no model/tool turn and sends no document history over a tunnel.

An earlier scripted Claude run omitted literal marked answers before continuing tools; the bounded reply-only recovery subsequently saved the answers. Recovery does not repeat document edits. Capturing a reply still requires the agent to emit its supplied markers as visible assistant text.

## Automated verification

- Backend: 221 tests passed, including concurrent coverage, state-v5 backup migration, native transport/control, recovery and interruptions.
- Server and browser TypeScript checks passed.
- Ten focused Playwright checks passed: queued previews, uncertain delivery, streaming/history races, partial output, Stop and Reset.
- Fresh whole-branch review found two issues: a first oversized Codex input bypassed steering, and interrupted native buffers could accumulate. Both were reproduced, fixed and rechecked. The retained regressions exercise oversized delivery/interruption and 70 interrupted display messages while another turn remains live.
- Shared-skill baseline followed the old owner-wide sequential rule; a fresh check with the updated guidance instead produced independent replies, applied the correction using the latest receipt, and required no fetch/claim/naming commands.

## Traffic and limits

The interleaved-output regression used a roughly 260 KB document, substantial saved history and 50 chunks across two outstanding replies. The final full-suite run measured 11,031 SSE bytes; focused runs varied with event coalescing. The test enforces less than 32 KiB, rejects document/history sentinels in streamed events, and verifies no repeated runtime events during its idle sample. The existing five-second keepalive remains. Files and documents continue to load on demand; native observation and control remain host-local.

This is a local traffic measurement, not an internet throughput guarantee. Normal state changes and initial page loading still transfer data. Codex requires the original session loaded in its daemon; Claude requires the updated native plugin module loaded at session startup. Reinvoking the skill alone cannot replace that module. Earlier state receives an exact migration backup; older apps must not write state v5. No deployment was part of this acceptance run.
