# Same-thread follow-ups during an active reply

## Intent and scope

The user approved sending Sidecar follow-ups into ongoing agent work, like typing a message and pressing Enter in the native terminal. Both Codex and Claude Code are required. A follow-up in the active Sidecar thread can affect the answer underway; a different thread stays queued. If the native turn finishes before delivery, the follow-up runs next without being submitted twice.

This extends the existing original-session transport. No second answering agent, model API, polling model calls, new settings, or concurrent work across different Sidecar threads. Existing plain terminal input must remain usable. Initial Sidecar delivery during unrelated terminal work retains its existing behavior; this feature is specifically for following up on active Sidecar work.

## What the current implementation guarantees

`store.ts` freezes a batch when it is claimed. `server.ts` permits one active request/batch and one `ReplyStream` per owner. Codex delivery uses `codex queue`; Claude delivery uses the existing Monitor watcher. Each prepared event supplies unique final/progress markers. Those markers route native output into a saved thread without a reply tool call.

The single-request guard cannot simply be removed: replacing its stream would lose the original reply, while appending new messages to an already-delivered batch could mark unseen messages answered.

The installed Codex 0.160.1 schema exposes `turn/steer` with required `threadId`, `expectedTurnId`, and `input`, plus optional `clientUserMessageId`. Sidecar's historical Claude acceptance test observed a Monitor message arriving after a busy tool completed. Neither establishes acceptance of the new end-to-end flow; fresh checks on both agents are required.

## Delivery and reply boundaries

Keep each delivered batch immutable. A same-thread follow-up becomes another batch linked to the active reply group, with its own request ID and unique reply markers. Pending messages collected before that delivery can still use the existing same-thread batching. The event includes its relationship to the earlier request and the IDs of earlier unanswered batches it covers; selections stay attached to their individual inputs. The normal short skill reminder remains.

The shared skill tells either agent to incorporate corrections in order and answer all still-unanswered inputs using the newest received event's markers. No extra acknowledgment or naming tool call is required. A reply with those markers is evidence that the agent received that delivery; transport acceptance alone is not that evidence.

A final reply completes its own immutable batch and the earlier still-unanswered batches explicitly associated with it. It never completes a later delivery. Save one answer in history, with metadata applied once. A completed older answer is never overwritten. An older final arriving after a newer reply already covered it has no further effects.

Retain capture for earlier delivered markers until they are settled. If an older answer was already being generated when a follow-up was sent, save that answer normally and leave the newer input pending. The later answer uses the newer markers. Keep one owner-level native observer and one active Sidecar conversation; support the outstanding reply boundaries within that conversation instead of starting an observer or answering agent per message.

Queued messages remain in the existing queue-preview UI until handed off. Preserve all captured progress and partial output. The visible stream must follow the message actually being emitted; merely preparing a follow-up must not erase or replace text currently streaming.

## Native adapters and delivery races

- **Codex:** steer only the exact active native turn already bound to this Sidecar reply. Supply a stable native message ID. Never interrupt to send, and never steer a different turn after a mismatch. A definitive no-active-turn/mismatched-turn rejection leaves the message available for normal next-turn delivery. A timeout/disconnect is uncertain, not permission to enqueue the same content again; reconcile native evidence using its identity before retrying.
- **Claude:** use the existing Monitor notification route to inject the same prepared follow-up event while the original turn is active. Keep display capture and native control hooks behaviorally aligned with the multiple outstanding boundaries. Validate arrival at a tool boundary in a disposable real session. Do not claim Monitor output itself proves the model read it.
- Serialize preparation, native handoff, and capture decisions using the existing dispatch/capture seams. Associate each delivery with the exact native turn where known. A stale acknowledgment cannot change a completed/stopped request or move it to another thread.
- Different-thread requests remain queued until the active reply group has no unfinished work. Terminal input remains governed by the native client; Sidecar does not reorder or withdraw unrelated input.

## Completion, interruption, recovery

A completed marked answer wins a race with interruption. Confirmed Stop/native interruption applies to the unfinished delivered batches attached to that exact turn, preserving progress and partial output; queued inputs never handed off remain queued. Existing Reset may interrupt any attached-agent work as previously authorized and must reconcile every affected Sidecar delivery without resurrecting it.

A native turn ending with a delivered follow-up still unanswered invokes the existing bounded reply-recovery concept for those inputs. Recovery asks the same agent to reconcile already-performed work and finish the answer; it is not blind replay of the edit request. Idle or disconnect alone never proves interruption or successful completion.

Persist reply-group associations and handoff state with requests. App restart preserves inputs and history and marks ambiguous deliveries for recovery, as today. Do not infer an unsent message was delivered from its presence in the group. Older saved records remain ordinary single-batch requests; use an explicit state migration/version guard if necessary so an older viewer cannot silently mishandle new grouped state.

## Verification and finish condition

Automated tests must cover both adapter paths and the shared state/capture logic:

1. A same-thread follow-up reaches a busy agent; another thread remains queued.
2. Multiple follow-ups preserve input/selection order; the newest marked answer completes exactly the covered inputs with one saved answer.
3. An old final racing with a follow-up saves the old answer without completing the new input; reverse capture order causes no duplicate answer or metadata effects.
4. Native end before steering, rejected steering, lost acknowledgment, disconnect, and duplicate notifications never lose or blindly resend an input.
5. Terminal and viewer Stop between messages and mid-output preserve captured text and stop only the matching delivered work; Reset/restart recover without reviving stopped requests.
6. Existing single-message replies, batch completion, progress, highlights/proposals, thread naming, and queue-preview behavior remain compatible.

Use disposable Codex and Claude sessions/documents for live checks: hold a tool open, send a correction in the same thread, verify the final answer reflects it, verify another thread waits, and exercise completion/Stop boundaries. Record versions and observed delivery timing. Do not test by manipulating the user's AMC conversations or live review documents.

Completion requires focused tests, typecheck, the repository backend suite, relevant browser checks, and successful live evidence for both agents. If an adapter cannot deliver reliably in the installed native client, report that limitation instead of shipping one-agent behavior as complete. No installation, viewer restart, PR, or merge is part of this design approval.
