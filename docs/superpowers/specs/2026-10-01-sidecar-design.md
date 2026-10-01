# Sidecar: document conversations with the originating agent

Date: 2026-10-01
Stage: proposed design for user review; transport feasibility investigated

## Purpose and first scope

Sidecar is a local document viewer opened by an existing coding agent. The user selects text, asks questions or requests changes, and receives threaded replies from that same conversation. General questions work without a selection. The original terminal remains usable.

The first build is deliberately barebones: unstyled HTML, browser-default controls, a rendered document, a question textarea, Send, thread messages, and Resolve/Reopen. A plain list of document links and a title input are enough. Plannotator's appearance is a later visual reference; styling is outside this build.

Both Codex and Claude Code are required for the first usable version. Start with Markdown rendered as safe HTML. Support existing files and documents the agent generates, multiple documents per agent, follow-up questions, requested revisions, and manual thread resolution. Standalone HTML-file input is deferred until its rendering, selection, and isolation are separately verified.

The first demo is: open a document from an agent, highlight a passage or ask a general question, receive a reply, request a revision, see the file update, and resolve the thread. Repeat with each agent and with two documents owned by the same conversation.

## Agreed behavior

- Only an agent opens a viewer session or registers a document through the normal workflow.
- One exact native agent conversation owns all documents in that session. Every thread across those documents routes to that owner. Focused terminal panes never determine ownership.
- Passage threads retain the selected quote. Document-wide threads need no quote. Follow-up messages continue their existing thread.
- Only the user resolves or reopens a thread. A reply arriving after resolution remains recorded without reopening it.
- Replies and edits leave the document open. There is no Finish Review or approval-round workflow.
- The agent uses its existing context and tools. The viewer makes no independent model calls.
- Requests can queue while the agent is busy. The UI reports queued, responding, failed, or disconnected in plain text.
- Documents, messages, resolution state, titles, and pending requests survive refresh and app restart.
- Each document gets an automatic browser-tab title: use an agent-supplied title, otherwise its first heading, otherwise its filename. A user edit persists and takes precedence without renaming the file.

## Smallest implementation

Keep one TypeScript package for the local server, agent-facing commands, and plain browser code. Use standard-library HTTP and filesystem facilities where practical, with ordinary Markdown rendering and sanitization libraries chosen during planning. A UI framework and database are unnecessary for this first build.

The server binds to loopback and owns document registrations, threads, the durable request inbox, and browser updates. Use ordinary HTTP commands and server-sent events for browser updates. Store local state in files using atomic replacement. Existing document files remain the source of truth; generated documents get managed backing files.

The browser displays the document and a simple thread list. A native selection supplies the quote for a new passage thread. Asking without a selection creates a general thread. Native controls cover follow-ups, resolution, switching documents, and editing the title.

The normal entry point will be a shared Sidecar skill with agent-specific connection instructions. Local packaging is sufficient; marketplace publishing is outside this build.

## Ownership and delivery

Record the agent type and exact native conversation ID when the agent opens Sidecar. Give every document, thread, and request a stable ID. Validate their ownership relationship on every agent reply; reject a reply addressed to the wrong document or thread.

A notification carries a short request ID. The owning agent fetches the full request: latest user message, relevant thread history, current file reference and version, and any selected quote and surrounding text. This also avoids the Claude Monitor event-length limit observed in the probe.

Persist a request before notifying the agent. A successful notification write or queue-command exit is not proof of receipt or completion. Track the agent's acknowledgement and reply separately, deduplicate by request ID, and retain requests through disconnects. The agent checks the stored request state before acting on a repeated notification. If an interrupted edit has an uncertain outcome, preserve that state and reconcile the current file before attempting it again.

Use the native Codex queue for its registered conversation. For Claude, start a Monitor over the local request stream and re-arm it after expiry while the app is still active. Both integrations use the same fetch and reply commands. Detect missing capabilities and show a connection error instead of silently starting another conversation.

Invoking Sidecar establishes the scope of work the user wants that agent to handle from document threads. Monitor notifications themselves do not grant approval. Existing tool permissions and confirmation requirements continue to apply.

## File changes and passage references

Watch backing files and refresh their rendered content. Before editing, the agent reads the current file so it does not overwrite a newer version from an old copy.

Store a passage's exact quote and surrounding text, with its position as a hint. After an edit, reattach only if the match is unambiguous. Otherwise retain the original quote and thread with a plain notice that the passage changed. A general thread has no passage reference.

## App and watcher lifecycle

Opening Sidecar starts its local app and the owning agent's watcher or queue bridge. All that agent's documents share the connection. Closing a document does not disconnect its siblings.

Stopping Sidecar stops its transport processes and leaves the original agent conversation running. Browser-tab closure is not a reliable shutdown signal; provide an explicit stop command. Reopening from the same agent restores the documents and pending requests. An unavailable owner is shown as disconnected; it is never replaced automatically.

Claude's tested Monitor expires after at most 30 minutes. Its expiry notification can wake an idle conversation and let the agent re-arm it; this uses a model turn. A persistent plugin monitor is a documented alternative, but was not tested and is not required for the first build.

## Boundaries

This is a local, single-user application. Bind only to loopback, use an unguessable capability and origin checks, and serve only registered documents and app assets. Keep capability values out of process arguments. Sanitize Markdown output and reject unsafe links. A later HTML-file renderer must isolate document scripts from Sidecar's controls.

Keep different owners' state separate. The product must not send terminal keystrokes, change Herdr focus or layout, or control unrelated panes to deliver requests.

## Feasibility evidence from 2026-10-01

Disposable HTTP probes established the following on the installed clients; they did not implement or test a browser UI.

| Client | Mechanism | Observed result |
| --- | --- | --- |
| Codex CLI 0.159.3 | `codex queue --thread <native ID> --message <notification>` | Requests queued during an active turn arrived in the original conversation on later turns. Context recall, replies across two documents, and a requested heading edit passed. Body bytes stayed unchanged. |
| Claude Code 2.1.286, claude.ai login, auto permission mode | Monitor over a local event stream | Same-conversation context recall, idle wake-up, busy delivery, terminal coexistence, multi-document replies, a requested heading edit, and controlled watcher reconnect passed. |
| Claude Monitor expiry | A 45-second test timeout followed by one re-arm | Expiry woke the idle conversation without another terminal prompt. The agent restarted the watcher and answered the next document request. |

The probes exposed a delivery race when a server counted a dead stream as delivered; acknowledgement and deduplication are required. Claude events were truncated at about 500 characters, supporting the short-notification/fetch design. The authorized scratch edit passed under existing permissions; other permission modes were not tested.

Codex submission initiated while already idle and its watcher restart were not separately tested. Browser selection, persistent app restart, repeated long-running renewal, expiry while awaiting permission, and owner-session resume remain acceptance checks. Claude Monitor availability depends on provider and configuration. The probe servers and watchers were stopped after the investigation.

Raw probe evidence was retained locally in disposable scratch directories. Private probe paths are omitted from this public copy; the table above records the relevant results.

## Compaction visibility

Both clients document `PreCompact` and `PostCompact` hooks. A hook can report directly to Sidecar so a busy agent does not have to narrate its own compaction. Actual hook registration and delivery still need a separate integration check after the core interaction works.

Show “Compacting context” only when a verified start signal supports it. Do not claim cancellation from a missing completion signal: Claude has no dedicated documented compaction-cancel hook, and cancel-versus-failure remains unresolved. A viewer control to cancel compaction is outside the first build.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude hooks](https://code.claude.com/docs/en/hooks), [Claude plugin monitor configuration](https://code.claude.com/docs/en/plugins/manifest-reference#monitors).

## Verification and development order

1. Implement the durable request/reply loop and both agent connections, using the proven transports.
2. Add the unstyled browser flow: Markdown, selection or general question, thread replies, resolve/reopen, and file refresh.
3. Exercise two documents, generated content, automatic/editable titles, and refresh/restart recovery.
4. Package the local agent entry point and verify startup, shutdown, and connection recovery with actual Codex and Claude sessions.
5. Verify compaction status hooks separately; leave unsupported states explicit.

Use focused automated checks for routing, duplicate delivery, persistence, permission boundaries, and ambiguous passage references. Browser checks cover selection across rendered elements, code blocks, keyboard use, follow-ups, refresh, file revisions, and resolution during an outstanding reply. Real-agent checks must establish that the same conversation answered; a fake responder is only a UI-development aid.

The next artifact after written-spec approval is a short implementation plan for this barebones scope.


## As built — 2026-10-01

The barebones implementation follows the [five-task plan](../plans/2026-10-01-sidecar-barebones.md): one Node app per exact native owner, atomic JSON state, Markdown files as the source, unstyled browser controls, and a shared agent skill. Codex uses its native queue; Claude uses Monitor over short notifications and fetches full requests separately. No independent model calls, terminal injection, styling, or Redline code were added.

Both original conversations passed the live walkthrough: two documents, context recall, general and passage requests, follow-ups, heading-only revisions, resolution/reopening, independent titles, idle/busy delivery, and stop/reopen recovery without duplicate replies. Disposable resume checks preserved each client's exact native UUID and earlier context. See the [dated evidence and limits](../../acceptance.md).

Markdown is rendered with raw HTML disabled and unsafe link schemes rejected. File polling detects atomic replacement. Ambiguous or changed passages retain their original quote instead of reattaching incorrectly. An unavailable backing file is returned as an explicit error in claim context. An interrupted claim becomes uncertain and requires reconciliation before resumption. Rare incomplete owner locks fail closed for manual inspection.

Optional scoped PreCompact/PostCompact hook examples and synthetic tests exist for both clients; native hook delivery remains unverified and no global configuration was changed. Codex Interrupt reports an interrupted turn, not compaction cancellation. Browser reload is needed after app restart because viewer credentials rotate. Claude Monitor availability depends on native provider/configuration and renewal consumes an agent turn.
