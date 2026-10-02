# Selections belong to messages

Proposed on 2026-10-02, after Sidecar PR 17 (`fba8bf5`) was merged and installed. As built on 2026-10-02 in the combined progress-updates branch: the behavior below is implemented. Native compatibility and release checks are recorded in the implementation plan.

## Agreed behavior

The user wants a conversation to discuss different passages over time. Each user message can carry **one optional selection**. A thread can therefore contain multiple selections across its messages, plus messages with no selection.

- Selecting text while a conversation is visible on the right attaches it to that conversation's next input. Selecting another passage replaces the pending selection.
- Show a compact, removable selection badge above the composer. Clicking away to dismiss the selection clears both its visible highlight and pending attachment, including the badge. Attachment and removal preserve the typed message.
- **Comment** in the floating selection menu, including its existing C shortcut, still starts a new thread. Move that selection into the new-thread composer; do not leave the same newly attached selection on the previous thread's draft. Preserve that draft's text.
- After sending, show the selection badge and bounded excerpt with that user message, following Plannotator's Ask AI presentation. Later messages do not automatically inherit the selection.
- Remove the thread-wide selected-passage header, changed-passage indicator, and general/annotation distinction in the thread list. Keep the title-edit pencil, resolve action, unread/queued/working indicators, search, and status filter.

Reference: the user's Plannotator HTML review at `http://localhost:61076/`, inspected on 2026-10-02. The installed `@plannotator/ui` 0.47.0 source has the relevant `DocumentQAPair` markup in `components/ai/DocumentAIChatPanel.tsx`: a small Selection badge followed by a quoted excerpt above the prompt. Reuse that visual treatment with Sidecar's existing right-aligned user bubbles and two-line excerpt limit. No Plannotator AI transport or independent model session is needed.

## Ownership and routing

Store `quote?: Quote` on user `Message` records. Reuse the existing exact text, prefix/suffix, UTF-16 offsets, version hash, and optional mechanically captured sentence. Agent messages do not own selections. Thread identity, title, resolution, and message order remain unchanged.

`submit` accepts a quote with either an existing thread ID or a new-thread request. It validates and copies the supplied selection onto the new user message and its request snapshot. It never looks up a thread selection to supply implicit context. Keep submission deduplication sensitive to both the message text and selection.

Prepared events for Codex and Claude retain the compact contract introduced in PR 17. Derive the optional quote from the request being answered, not the thread. `thread.lastRequestId`, exact reply markers, fallback context retrieval, and original-agent ownership stay intact. Update the shared skill to explain message-local selections and the absence of automatic selection carryover.

An independent selection table would add lookup and lifecycle work without benefiting the requested one-selection-per-message flow. Keeping selection authority on threads would continue the ambiguity this feature removes. Message ownership with a request snapshot fits the existing storage and delivery paths.

## Drafts and interaction

Extend the existing per-thread draft with an optional quote; legacy text-only browser drafts remain valid. A draft containing a selection counts as nonempty even before text is typed. Save attachment changes using the existing draft persistence, keeping the established 100 ms text debounce. Preserve the selection and retry identity across reloads, thread switches, failed submissions, and lost responses. Successful sends clear only the submitted draft, preserving any newer one.

Clicking away to dismiss the native selection clears its highlight, floating toolbar, and the active draft's pending attachment together. Removing the badge also clears the pending selection; neither action erases typed text or selections on already-sent messages. Interacting with the composer or choosing Comment is not a dismissal: keep the attachment so the user can type and submit it. Switching threads preserves each draft's selection with its own thread. With the conversation pane closed or showing the thread list, selection retains the existing floating Comment behavior.

## Highlights and document history

Paint saved highlights per user message, using message IDs rather than thread IDs. Clicking a highlight opens its owning thread and scrolls to the corresponding input. Clicking a message's selection badge finds and emphasizes that exact passage. Overlapping selections remain individually addressable, including two messages in the same thread. Only the currently targeted passage gets the distinct active emphasis.

Resolving a thread hides every highlight belonging to its messages. Reopening restores valid highlights; sending to a resolved thread still reopens it.

Evaluate **Passage changed** separately for each message's selection. Keep **View original document** alongside that indication when the referenced snapshot exists. The original version opens temporarily in the main pane while the conversation stays visible, with **Return to current**. Missing legacy snapshots omit the link. The original-document view remains read-only.

No document contents are copied into messages or threads. Existing snapshots remain shared at `versions/<documentId>/<content-hash>.md`: one saved Markdown file per viewed document version. Each quote refers to the appropriate hash.

## Upgrade and rollback

Introduce a versioned saved-state migration from version 1 to version 2. Validate routing and ownership before changing data. For each legacy annotated thread, copy its quote onto its first user message, then remove thread-level selection/scope ownership in the migrated representation. Preserve document, thread, message and request IDs, titles, resolution, timestamps, answers, and snapshot references.

Preserve already accepted request payloads and their deduplication signatures, including pending legacy requests. They must not be silently reinterpreted or resent. Only newly submitted requests use the new message-local selection rule. Existing crash recovery still changes interrupted claimed requests to uncertain.

Before the first version-2 write, retain an unchanged version-1 state backup. Publish the migrated state with the existing atomic write/rename mechanism. A repeated startup must not duplicate attachments or overwrite the original backup. If a legacy selection cannot be associated unambiguously with a first user message, report the problem and preserve the original state instead of discarding it.

The document library must read both formats without migrating another owner's files. Only the owning app's startup writes its migration. Existing app/lock isolation prevents two versions writing one owner concurrently. Old binaries must reject version 2 rather than silently losing new selections. Rollback means stop Sidecar and restore the retained pre-migration state; restoring that backup excludes later conversations, so it is an explicit recovery operation, never automatic.

Refresh existing browser tabs to load the new UI after restarting their owner app, preserving saved drafts. Do not run the migration on the user's active state during development; prove it with isolated fixtures first.

## Verification and scope

Verify migration preserves legacy first-message anchors, snapshot references, accepted requests, resolution and IDs; repeat it to prove idempotency and exercise failed writes without losing the source. Cover read-only library access to both formats and rejection by older readers.

Exercise both native delivery adapters with selected follow-ups and unselected follow-ups. Browser checks must cover automatic attachment, replacement/removal, clicking away clearing both the highlight and pending attachment while preserving typed text, composer interaction retaining the attachment, normal Comment creating a new thread, draft and retry preservation, two different passages in one thread, overlapping highlights, navigation to the exact message, per-message changed-passage history, missing snapshots, resolve/reopen, and search across selections. Verify the UI in Chrome against the open Plannotator reference.

This feature does not add multiple selections to one message, HTML input support, a new agent transport, per-thread agents, snapshot pruning, or changes to the already merged brightness/header controls.

## As built notes — 2026-10-02

The selection badge markup and excerpt typography are copied from Plannotator's `DocumentQAPair`; the user requested a subtle rounded attachment background and a consistently sized SVG link arrow during visual review. Excerpts retain Sidecar's two-line limit.

Backend and browser changes were committed as two coupled chunks because removing thread-level selection ownership changes all consumers. There is no temporary dual-ownership API. The shared draft hook preserves existing text-only drafts and the 100 ms debounce.

The combined branch also records marked interim replies as ordinary agent messages, shows Working on successful native handoff, and adds highlight intensity. A live Claude check exposed monitor truncation; the existing request command now returns the existing active stream markers for recovery without restarting progress. Ordinary duplicate notifications still do not authorize replay.
