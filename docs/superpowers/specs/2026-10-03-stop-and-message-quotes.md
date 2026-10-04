# Stop and message quotes

User-approved scope, 2026-10-03:

- An empty thread composer offers Stop only for that thread's identified, active Sidecar request. Typing restores Send. Never interrupt unrelated terminal work or merely queued delivery.
- Stop targets the exact native turn, disables repeated clicks while stopping, and waits for native interruption confirmation. Keep progress and partial output as Stopped, even without a closing reply marker. Do not undo edits or retry automatically.
- Completed replies win a completion race. Stale clicks cannot interrupt another turn. Disconnection/rejection/timeouts report failure to confirm; they do not invent successful cancellation.
- Support both Codex and Claude. Disposable checks on 2026-10-03 confirmed Codex `turn/interrupt` plus `turn/completed` and Claude `$.turn.abort` plus `turn.complete` with `isAborted` during streamed output. Claude native controls require mods support (2.1.287+).
- Selecting text in a sent message, in the conversation or a pinned window/dock, quotes it in the next reply. Preserve one attachment per input and draft persistence. A message quote is not a document highlight.
- Attach to the open conversation, or the source conversation if none is open. Preserve the source thread/message IDs. Reuse the current badge styling and composer.

Verification must cover stale/wrong turn IDs, late output, completion races, partial replies, disconnection, both native agents, saved drafts, Markdown text, and both message surfaces. No new dependencies.

As built on 2026-10-03: both installed native agents confirmed interruption through the app and retained partial text. Claude's control module identifies the native turn by the exact Sidecar output marker because its display hook uses a different turn ID. Shared message rendering captures quote context for conversation, floating-window and dock surfaces; hidden drafts are preserved when another source thread opens.

Terminal interruption correction on 2026-10-03: a confirmed interruption of the matching native turn also marks its request Stopped when initiated outside Sidecar. Completed progress and partial replies are retained without duplicating progress if a follow-up is queued, and later requests can be delivered. Complete final snapshots still take precedence; idle/disconnected status and stale or unrelated turn IDs do not stop requests. Disposable Codex transport and Claude native-module tests cover interruption between messages and during a second message.

User-approved Reset extension, 2026-10-03:

- Add **Reset** inside the attached Claude/Codex label's session popover. This explicit control may interrupt any work in that native session, including unrelated terminal work. The composer's Stop remains limited to the current Sidecar request.
- Recheck native state when clicked. Codex queries its exact loaded session and latest native turn; Claude's control module answers a fresh Reset identifier. An idle badge, old heartbeat, disconnected socket or missing process is not confirmation.
- Idle confirmation reconciles unfinished claimed/uncertain batches. An active session is interrupted by exact turn ID and reconciliation waits for native completion. Unknown/unreachable state, an identity change or timeout reports failure and keeps work recoverable.
- Preserve captured output and saved history, mark reconciled requests Stopped, and release later queued messages without replaying the interrupted task. Complete replies win races. Pause new Sidecar delivery during Reset, reject overlapping resets, and keep draft text intact.
- Claude's native module remains reachable while idle. A fresh/reloaded module starts with unknown activity until it observes a native turn. After reconnecting a killed session, use Reset once native state is known. No force-reset based on silence.

As built for this extension: backend tests exercise fresh verification, unrelated-work interruption, stale IDs, complete snapshots, uncertain batches and reordered idle/completion hooks. Browser coverage opens Reset from the session popover and checks output and draft preservation. A read-only query of the installed Codex daemon confirmed that its latest-turn endpoint returns the active `inProgress` turn; no live agent was interrupted for that query.
