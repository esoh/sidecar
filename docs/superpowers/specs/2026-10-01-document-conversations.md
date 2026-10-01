# Document conversations — approved design, 2026-10-01

Implement the reviewed scratch prototype in the existing React viewer. Use the existing original-agent queue for both Codex and Claude. No new model session, styling library, or dependency.

- Dark document card over Plannotator’s grid, solid right sidebar. Preserve attribution.
- Per-document threads: general or passage-linked, sorted by latest message activity, with type icons. Default Unnamed general conversation; additional general conversations via +.
- Compact list header: Unresolved/Resolved dropdown (default Unresolved), count, +. No redundant labels or status footer.
- Conversation header: back, title, resolve/reopen icon. Passage quote below, clamped to two lines, full text on hover, click to locate. Missing/ambiguous passage keeps original quote and history, with Passage changed.
- Preserve drafts and conversation scroll when switching threads. Replies never switch the selected thread. Newly submitted annotations select their thread; retain the existing floating annotation composer and its cancellation/draft semantics.
- Textareas grow with content, then scroll. Enter sends; Shift+Enter adds a line; IME composition never sends. No keyboard hints.
- Document name has small centered pencil; inline edit, Enter/blur save, Escape cancel; browser title follows saved name.
- Agent names an Unnamed conversation once context is sufficient, retrying on later questions if necessary; assigned names remain stable. Both agents use the shared skill and endpoint.
- Keep document navigation, live streaming, error/queue/compaction signals, safe retries and file refresh. Idle status and decorative placeholder labels are omitted.

No production dummy data. This is a separate scoped change from selection comments. Leave changes local for review; no push or merge is authorized by design approval.

## As built — 2026-10-01

Implemented the approved UI with the existing React/CSS stack and shared original-agent routing. Empty general threads and stable optional names persist in the version-1 store, including legacy state upgrades. Thread switching retains drafts and scroll in the current viewer; reload retains the selected thread, but not unsent drafts. Verification and review fixes are recorded in the [implementation plan](../plans/2026-10-01-document-conversations.md).

### Approved refinements — 2026-10-01

The user subsequently requested actual original-agent activity in the top-right header, including terminal work. Native activity is separate from the Sidecar queue. Codex uses read-only native runtime status sampling; Claude uses the shared skill's lifecycle hooks. Unavailable signals show Unknown. The earlier omission of idle status is superseded by this request.

Thread previews now carry a small unread dot and either a queued clock or an in-progress spinner. Reading a visible conversation clears its unread marker, persisted in local browser storage. Claimed requests take visual precedence over queued requests in the same thread. Repeated queued sentences were removed from the conversation; distinct failure/interruption notices remain.
