# Mid-turn input and continuous thread reply capture

## Approved scope

The user approved native mid-turn input for both Codex and Claude, then expanded it to every Sidecar thread and to turns started from the CLI. Busy agents receive input at the native safe boundary without an interrupt; idle agents start normally. One owner-level listener continuously captures tagged outputs, independent of which thread the browser displays. No second answering agent, model API, new dependency or setting.

Stop is agent-wide and available before any output: with an empty composer, show **Stop agent** while native control identifies active work. With a draft, retain Send. Stop can interrupt terminal work or another document/thread. Recheck the exact native turn at click time; a stale click must never interrupt a newer turn.

## Input and reply boundaries

Keep delivered batches immutable. Each new delivery freezes its queued same-thread inputs and records earlier accepted, unfinished batch leaders from that same thread in `covers`. Other threads can be delivered independently but cannot be covered by that reply. Selections remain per input. Queue previews disappear on successful handoff, as today.

Use a stable thread tag with a generated request receipt line inside the supplied stream prefix. The agent copies that prefix and suffix verbatim. Receipt IDs identify exactly which delivery is answered, even when several replies share a native turn or native message. The shared skill explains how to combine unanswered inputs in the same thread using its newest received receipt, and how to reply separately to different threads. No extra acknowledgment, naming or reply tool call is needed.

A final completes its own batch and the still-unanswered batches in its immutable coverage. It cannot complete a later delivery or another thread. Apply metadata once and preserve completed older answers. A late final already covered by a newer answer has no effects. Preparing a new input must not clear an older reply still streaming.

## Native delivery and control

Codex uses the original loaded session's `turn/steer` with its exact active turn and stable client message ID. When idle, retain the existing native queue/start path, respecting unrelated terminal input. A proven rejection before submission can fall back to the queue; lost acknowledgment is uncertain, never permission to replay edits.

Claude uses the existing Monitor watcher and native control hooks. Display IDs may differ from native turn IDs. A Monitor handoff means sent, not proof that the model read it; valid tagged output proves receipt. Both adapters retain native turn association before first output where native evidence permits it.

One owner listener routes outstanding tagged blocks. It does not start one native subscription per thread. Native completion/interruption reconciles only deliveries bound to that exact turn. Completed answers win races with Stop. Preserve partial/progress text and unsent queued inputs. Unknown delivery remains recoverable rather than inferring success or interruption from idle/disconnect. Keep existing bounded reply-only recovery, explicit Reset and restart behavior.

State v5 preserves new coverage and handoff records and creates exact backups of earlier saved formats. Earlier requests remain ordinary single batches; older viewers must reject the new version.

## Tunnel and bandwidth

Native observation, handoff and control remain host-local. Reuse the viewer's lightweight SSE runtime/change events, compressed state responses and on-demand document/file loading. Do not add browser polling or send full documents/history with output chunks. Add a regression measurement covering interleaved thread replies and idle traffic.

## Verification

- Same-thread corrections, cross-thread questions and CLI-originated busy work accept input in both adapters.
- Immutable batches and coverage settle only seen inputs; old/new finals in either order preserve history and metadata exactly once.
- Multi-block/multi-thread capture preserves progress, partial output and completed answers with one observer.
- Native turn end, precondition mismatch, disconnect and lost acknowledgment never blindly resend.
- Stop works before output, from another thread, and during terminal work; stale turns, duplicate clicks and delayed native callbacks are safe.
- Existing progress, highlights/proposals, thread naming, queue previews, Reset and migration remain compatible.
- Disposable live Codex and Claude sessions demonstrate busy delivery and pre-output Stop. No AMC documents or user sessions are test fixtures.

Finish with focused regressions, typecheck, backend/browser checks, measured bandwidth and whole-branch review. This approval does not include installation, PR or merge.

## As built — 2026-10-06

The approved behavior is implemented. Claude native queued attachments restore prepared notifications after Monitor truncation and bind the receipt before model output. Runtime updates retain outstanding reply text per thread. Native completion retires partial capture buffers and also reconciles delivered ID-only inputs that have not yet been fetched. [Acceptance evidence](../../2026-10-06-mid-turn-acceptance.md) records verification and remaining native-client requirements.
