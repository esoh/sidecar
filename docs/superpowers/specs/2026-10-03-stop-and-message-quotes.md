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
