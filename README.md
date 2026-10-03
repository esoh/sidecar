# Sidecar

A local Markdown viewer for questions and revisions in your existing Codex or Claude Code conversation. Select a passage or ask a general question; replies stay in persistent threads across documents. You control thread resolution; sending a new message automatically reopens a resolved thread.

## Install (macOS / Linux)

Sidecar has two parts: the local `sidecar` app and a native plugin for each coding agent. Install the app first. It requires **Node 22+, pnpm 11+, and Git**; the installer installs the app's locked production dependencies, without needing a development checkout.

```sh
curl -fsSL https://raw.githubusercontent.com/esoh/sidecar/main/install.sh | bash
sidecar --version
```

The command is installed at `~/.local/bin/sidecar`. If that directory is not on your shell's `PATH`, add it to your shell configuration and restart the terminal before starting your agents:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Then install the integration for each agent you use:

**Codex** (requires a CLI with `codex plugin add`):

```sh
codex plugin marketplace add esoh/sidecar
codex plugin add sidecar@sidecar
```

**Claude Code:**

```sh
claude plugin marketplace add esoh/sidecar
claude plugin install sidecar@sidecar
```

Restart the agent. Invoke Sidecar's skill from the plugin's commands/skills menu (Claude: `/sidecar:sidecar`; Codex: select the Sidecar skill with `$`). Ask it to open an existing Markdown file or generate and open a document. Claude still requires its native Monitor tool, and Codex still requires native queue delivery, as described below. Codex may ask you to review/trust the bundled hooks; installing the plugin does not bypass native hook trust.

If you previously installed Sidecar with personal skill symlinks, remove those **Sidecar-only links** before enabling the plugin to avoid duplicate commands. The source-checkout workflow below remains available for development.

### Update

Rerun the installer above to update the local app to the latest `main`. Then refresh the plugin in each host you use:

```sh
codex plugin marketplace upgrade sidecar
codex plugin add sidecar@sidecar

claude plugin marketplace update sidecar
claude plugin update sidecar@sidecar
```

Restart the agent to load the updated skill/hooks. Ask the original agent to stop and reopen its Sidecar app to load the updated app code; closing the browser alone does not stop it. Documents and threads are kept in `~/.local/state/sidecar`.

The installer prepares each Git revision in `~/.local/share/sidecar/releases/` and switches `current` only after dependencies and the launcher pass a startup check. A failed install leaves the current app selected. Old releases are retained so running viewers can continue using their files. It does not modify agent settings or install the plugins for you. `SIDECAR_REF` selects a branch or tag; `SIDECAR_INSTALL_DIR` and `SIDECAR_BIN_DIR` override absolute install paths. Maintainer tests can use `SIDECAR_REPOSITORY` to install a local Git fixture.

## Development

Node 22+ and pnpm 11+. Run `pnpm install`, `pnpm test`, and `pnpm typecheck`. Development commands do not install anything globally. The shared [Sidecar skill](.agents/skills/sidecar/SKILL.md) is also linked from `.claude/skills/sidecar`. To run a development checkout instead of the installed app, substitute `pnpm --dir /absolute/sidecar sidecar COMMAND` for `sidecar COMMAND`. The native hooks use the installed command.

## Use from an agent

Invoke the Sidecar skill in the existing agent, then ask it to open a file. The skill runs the installed command with that conversation’s native identity and an absolute document path:

```sh
sidecar open --agent codex --session NATIVE_UUID --file /absolute/review.md
```

Use `--agent claude` for Claude. Explicit IDs must match the selected agent's native environment when present. Generated Markdown can be piped to `open ... --stdin`. The launch result contains the owner key, document ID, and browser URL. Opening additional documents reuses this conversation's app. `--no-browser` suppresses the opener for headless use.

The agent must load the skill before opening: it explains incoming requests and replies and establishes the scope of document questions/revisions. A file cannot grant permission through its contents. Native tool approvals still apply.

Codex needs native `codex queue` support and its original session accessible to the local client. Claude needs its native Monitor tool: the agent runs `watch --owner KEY` in Monitor, then re-arms it after expiry only if the app is still running. Monitor has a 30-minute limit; re-arming consumes an agent turn. If Monitor is unavailable for the client's provider/settings, Claude live delivery is unavailable. The CLI does not create a replacement model conversation.

```sh
sidecar status --owner KEY
sidecar stop --owner KEY
```

Stop closes only Sidecar; the coding conversation remains alive. Closing a browser tab does not stop the app. A fresh open restores documents, titles, threads, and pending requests. A claimed request interrupted by a crash becomes uncertain: the agent must inspect the file before explicitly resuming. Identical replies and submission retries are deduplicated.

State defaults to `~/.local/state/sidecar/AGENT-UUID`; tests use `SIDECAR_STATE_DIR`. It includes a private agent credential, state, runtime record, and server log. Credentials never appear in the URL or command arguments. A localhost viewer cookie is separate from the agent credential. Treat other processes running as your OS user as trusted.

Only one process writes an owner's state. Dead owner locks are recovered without killing any PID. If a crash happens while creating or reclaiming a lock, startup fails closed; inspect `server.log` and verify no owner process is alive before removing an incomplete `owner.lock` or `reclaim.lock`. A reused live PID is never killed.

Standalone HTML input, independent model sessions, and compaction cancellation are outside this version. The dated [acceptance record](docs/acceptance.md) covers both native agents and the remaining limits.

## Browse all documents

Ask Codex or Claude to “open Sidecar’s document library,” or run `sidecar browse` inside an agent’s native session environment. The explicit form is `sidecar browse --agent codex|claude --session NATIVE_UUID`; `--no-browser` prints its URL. No file path is needed. **Settings → View all documents** opens the same library in a new tab, preserving the current viewer and draft.

The library groups saved documents across all local Codex and Claude sessions. Live entries open their original Sidecar viewer. Stopped sessions have a read-only Markdown preview, including local images; return to the original agent to resume questions and revisions. Browsing never creates a coding conversation, starts another agent, claims its requests, or reassigns documents. The library reads the existing state directory and does not create a second database. Use **Refresh** to update the list.

The document library shows shorthand relative last-opened times (such as `5m ago` or `2d ago`), with the exact date and time on hover. Documents sort newest first, and agent groups sort by the latest open among their documents. Legacy entries show an unknown time until next opened.

Click the **Claude/Codex** label in a viewer or the library to see and copy its original session ID. Session IDs identify the owning conversation; an active Sidecar viewer does not by itself prove its agent is online.

## Passage comments

Select text and click **Comment** or press **C** to open a floating composer beside the passage. The shortcut leaves typing and Ctrl/Cmd+C untouched. The highlight remains visible while you type. Clicking outside dismisses an empty composer; a composer with a draft stays open. **Send** (or Enter) starts a thread with the original agent; **Cancel** or Escape discards the unsent comment. Select another passage at any time to start a separate comment; reselecting a passage restores its draft while this page stays open. Failed sends preserve the draft for retry. Shift+Enter adds a new line. Textboxes grow with their contents and then scroll.

Saved passages retain their visibility after reload. Click a highlight, or focus it with Tab and press Enter, to reach its thread and selection card. The active selection has a violet highlight and outline; other passages stay amber. Clicking the quote in the conversation scrolls to its passage and briefly emphasizes visible highlights (unless reduced motion is enabled). When selections overlap, choose the reference you want. Resolving a thread hides all its selections while keeping its conversation in the Resolved list. Reopening leaves them hidden; use **Show** beside a selection or **Show all selections** to display them again. Other threads' visible selections remain highlighted. If a file edit makes a passage missing or ambiguous, its message and quote remain, marked “Passage changed.”

Click **View original document** on a changed passage to temporarily show the saved Markdown in the main pane, with its original passage highlighted. The conversation and draft stay available. **Return to current** restores the latest document. Sidecar saves versions as they are viewed, so versions from before this feature may be unavailable; their quoted text is still kept and the original-document link is hidden. Saved Markdown lives under `versions/` in the owner’s state directory and survives app restarts. Linked images are loaded from their current locations, not archived.

## Closing a document

The **Close document** button in the top bar asks for confirmation before permanently deleting that document’s threads, messages, highlights, browser drafts, and saved revisions. The Markdown file (including agent-generated files), other documents, text sizes, and panel settings remain. There is no undo. Browser cleanup applies to the current local origin; a small closed-document marker prevents suspended tabs from saving an old draft again.

Queued, running, or interrupted requests must finish or be reconciled by the original agent before closing. The viewer shows **Document closed** with **Browse all documents**. The app remains available for browsing even after closing its last document; use `sidecar stop --owner KEY` to stop it explicitly. The coding agent keeps running. Last-opened metadata for the closed document is removed. Other open viewers receive the closure. A disk or browser cleanup failure is reported explicitly.

## Document conversations

The document sits beside a conversation sidebar. The top-right panel button hides or reopens it without losing the selected thread or draft. On desktop, drag the pane’s left edge to resize it with Plannotator’s resize handle; the width is saved in this browser. Clicking the edge, its collapse arrow, or dragging it nearly shut collapses the pane. Reopening restores its saved width. Clicking a saved annotation or submitting a new comment reopens its conversation. The pane starts open on desktop and closed on narrow screens. Use the back arrow for the thread list, **+** for another general conversation, and the status dropdown to switch between **Unresolved** (default), **Resolved**, and **All** threads. Search matches titles, selected passages, labels, and messages; each result shows its first matching excerpt with the match highlighted in a two-line preview. The checkmark resolves a thread and returns to the unresolved list. Reopening a resolved thread keeps its conversation open. Sending a new message also reopens it and switches the list filter to Unresolved, leaving previously hidden selections off; late agent replies and retries of already accepted messages preserve resolution. Threads sort by latest message activity. Beside the message preview, a dot marks an unread agent reply, a clock marks queued work, and a spinner marks a claimed request. The spinner replaces the clock while work is in progress. Opening a visible conversation marks its replies read; read state is kept in this browser across reloads. Clicking a saved highlight opens its conversation; submitting an annotation selects the new conversation automatically.

Each document starts with an **Unnamed** general conversation. The original agent names a thread once its question/history has enough context, using an optional metadata line in the same final reply. Vague openings stay unnamed until a later message. Agents do not rename assigned titles. You can edit a title with the pencil beside it in the open conversation; Enter or blur saves and Escape cancels. This instruction is shared by Codex and Claude; it does not create another model session or require a naming command.

Your messages use compact right-aligned bubbles; agent replies use the full width without bubbles or author labels. Both render rich Markdown using the document renderer, including replies while they stream. Heading links in a message stay within that message. A small Queued or Working… placeholder appears below a pending message in the response area and disappears when that request’s reply starts arriving, including streamed replies. Other unanswered messages keep their own status.

Hover over a sent message or focus its controls to **Copy** or **Pin** it. Pinning opens a reference window immediately. Pins are saved with the conversation and listed below its title: up to three show in full; longer lists start with two and an expand button. Click a pin's text to reopen its window; click its icon to choose a line icon, capital letter, number, or one of twelve colors. Typing a letter or digit while that menu is focused selects it directly. The menu also offers **Go to message**, with **Unpin** separated at the bottom. Each window is draggable and resizable from its edges; closing it keeps the pin. Attached selections keep their **Show/Hide**, passage navigation, and original-document controls. **Go to message** in the pin menu, window, or dock focuses the exact message, reopening its source thread when needed, without closing any reference.

Drag a window into the bottom dock to make it a tab. Drop near a tab gap to choose its position, drag tabs to reorder, or pull a tab out to restore its window. **Dock** moves the window into the dock and opens it; **Minimize**, beside it, docks the window and collapses the dock. Each tab has close and pop-out buttons. Resize the expanded dock from its top edge. A collapsed dock accepts drops within its bottom bar and briefly previews the incoming message; it collapses again after the drop. The dock remembers its expanded state even when empty. An expanded empty dock shows a compact **Drop a window here** target at its minimum height; dropping restores the normal or remembered dock height. Open windows and their positions last for this viewer tab; saved pins survive reloads and app restarts.

**Settings** opens a modal with reading controls, **Copy messages as** (Raw Markdown, Rich text, or Plain text), and **Pinned windows** (Multiple or One at a time). Switching to one window keeps the most recently opened reference without removing any pins. Copy includes only the message text; internal selection links become their labels. Rich copying includes HTML and plain text, falling back to plain text if the browser cannot write rich content. Dock tabs support arrow-key navigation and Alt+Arrow reordering; a focused window title supports arrow-key movement and Shift+Arrow resizing.

Back discards a conversation with no messages or unsent draft. Threads with messages, drafts, or a submission in progress are kept. Each thread’s unsent message is saved in this browser after a 100 ms pause, at least every two seconds during continuous typing, and immediately when leaving the field, switching threads, or leaving the page. Drafts restore after a reload or reopening the same local app URL and clear only after a successful send or when you erase them. Failed submissions retain their retry ID across reloads to avoid duplicate requests. Conversation scroll positions survive switching threads while the page stays open. Background replies do not change the selected conversation. The quote above an annotated conversation shows at most two lines; hover for the full quote or click to find its passage. Removed or ambiguous passages keep the quote and history, labeled **Passage changed**.

Click the pencil beside the document name to edit it inline. Enter or clicking away saves, Escape cancels. Failed saves preserve the draft. The browser title follows the saved name. Unsent selection comments that have not yet created a thread stay in memory only. Saved thread drafts belong to this browser and local origin; they do not sync between devices or different server ports.

The browser UI uses React, `@plannotator/ui` (pinned to 0.47.0), and `@plannotator/web-highlighter`. Document components, typography, colors, and spacing come from Plannotator; its Inter, Geist Mono, and KaTeX fonts are served locally. The compact comment popover follows Plannotator’s styling. Attribution is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The local server bundles the UI on page load with esbuild, so no separate frontend server or build command is required.

The Settings gear beside the panel toggle has separate **Document** and **Conversation** text-size sliders (80–150%). Changes apply immediately; conversation sizing also adjusts the message composer. Reset restores both to 100%. A shared **Text brightness** slider dims document and conversation text from 100% (the original colors) down to 50%, preserving syntax colors and leaving media and controls unchanged. It has its own Reset. Preferences are saved in this browser across new Sidecar sessions and ports. The Settings footer shows the running app’s version and, for installed builds, its Git revision (matching `sidecar --version` from that release).

The document card shows the repository and branch captured from the working directory when the agent opens it, including linked worktrees. Older documents gain this context when reopened from their project; non-repository opens omit the badges. **Copy file** copies the current raw Markdown. The badges reuse Plannotator’s component and preserve its heading spacing.

## Rich Markdown

Documents render syntax-highlighted code with copy buttons, Mermaid and Graphviz diagrams with source/zoom/expand controls, inline and display math, tables, task lists, callouts, images, and sanitized HTML within Markdown. Heading links navigate within the document. Click a Markdown image to enlarge it; Escape closes the image. Local images must be within the registered document’s directory (including subdirectories); symlinks escaping that directory are rejected. HTTPS and data images are also supported. Responsive HTML images use their fallback `img` source.

Passage comments work on rendered text, including code and tables. Diagram controls, SVGs, and math are excluded from text anchors; image-region and diagram-node annotations are outside this version. A renderer change can make an old passage’s text context differ; the existing thread and original quote remain available as “Passage changed.” This does not add standalone HTML-document mode.

The renderer allows inline styles for syntax highlighting, math, and diagrams, plus WebAssembly for Graphviz and HTTPS/data images. Inline document scripts remain blocked; raw HTML is sanitized. Local image responses have a sandbox policy, and fonts/images require the viewer cookie. Both agents retain their existing request, revision, and reply flow.

## Streaming replies

Both original agents can stream reply text while keeping their terminal session. Codex receives native text chunks from the existing app-server Unix socket (verified with CLI 0.159.3). Claude uses the skill's `MessageDisplay` hook (verified with 2.1.286), which supplies completed lines in batches; short replies can arrive all at once. Invoke the Claude skill through its native Skill tool; merely reading the Markdown does not register hooks. The hook does nothing when Sidecar is stopped and does not modify terminal text or global settings.

Sidecar prepares requests before delivering them: the compact native event includes the question, selected passage when present, routing IDs, `thread.lastRequestId` (null for the first message), exact reply markers, and the reminder “Follow the Sidecar skill.” It omits the document body, automatic thread history, repeated IDs, timestamps, and internal status fields. The preceding request ID helps the agent recognize context it already has; if needed, it can retrieve the thread again. For a partial-sentence highlight, the viewer mechanically captures its surrounding sentence (up to 512 characters); a whole-sentence or multi-sentence selection needs no extra sentence. Older highlights remain valid without sentence context. The agent uses selection context only when relevant, answers simple questions directly, and can retrieve the file path/content or full saved anchors with `sidecar request ID --owner KEY` when needed. For that optional context read, `already-claimed` is expected because the request was prepared before delivery. Codex's app dispatcher and Claude's watcher own the claim and stream setup; the agent can answer an existing named thread without a preliminary tool command. Questions or selections over 48 KiB keep the ID-only event and `request ID --owner KEY --stream` fallback so native delivery limits cannot silently truncate a question. The agent emits an assistant message between the supplied `stream.prefix` and `stream.suffix` as its final response (after any document edits). If stream setup fails, delivery still includes the prepared question and a `stream.error` for the complete-reply fallback; duplicate or completed claims do not start another stream. The separate `stream` command remains available for a request claimed without `--stream`. Native message completion with the closing marker automatically saves the reply. Requests show Queued until the native handoff succeeds, then Working. Before tool work, the agent uses the supplied `stream.progress` markers for brief interim updates; each update streams into the thread and remains in its history. The existing `stream.prefix` and `stream.suffix` are reserved for the final answer that completes the request. The markers are visible in the terminal but stripped from the viewer. Unmarked commentary, reasoning, and tool output are excluded. Both Codex and Claude share this progress/final contract; no extra agent command is required.

The completed message saves the reply exactly once; `reply ... --stream` is an optional idempotent completion check. Missing chunks or incomplete markers cannot finalize a reply. While the observer remains connected, a later complete assistant message using the same request markers can replace the interrupted capture; it saves once and releases the next queued request without rerunning any edits. A disconnected observer still needs the existing plain-text stdin reply recovery path. A browser reload recovers the current draft. Successful native delivery shows Working; it does not prove the agent has started processing. App restart discards transient drafts and leaves prepared/claimed requests uncertain for reconciliation; it never silently repeats a possible document edit. Watcher reconnects suppress already prepared requests. The agent reads the current backing file before revisions; a saved selection can refer to an older document revision. Sidecar does not launch a new model session. The shared skill answers quick questions directly and delegates extended work to temporary native subagents when available, with results relayed by the original agent to the same thread. Requests remain sequential per owner, and exhausted capacity falls back to direct work or waiting. Codex streaming requires the original conversation to be loaded in its local daemon; unsupported configurations retain complete-message replies.

## Agent activity

An empty conversation composer shows **Stop** for that thread's active Sidecar request once its marked output identifies a native turn and the control channel is available. Typing restores Send; Enter on an empty composer never interrupts. Queued messages and unrelated terminal work cannot be stopped here. Stop waits for native confirmation, keeps progress and partial output as **Stopped**, and does not roll back file edits or retry the question. A reply already completed wins the race. A failed or unconfirmed interruption leaves the request recoverable and shows an error.

Codex uses its existing daemon's turn-specific interrupt API. Claude requires native plugin modules (Claude Code 2.1.287+); load the updated plugin when starting/resuming the session. Re-invoking the skill alone cannot load that module into an already-running session. The module binds the native turn to the exact Sidecar marker, polls only during an active turn, and reports native completion. Ordinary streaming replies remain available without this control channel. Full Stop paths were checked on 2026-10-03 with Codex 0.160.0 and Claude 2.1.288.

Select text in a sent message to quote it in your next reply, including messages in floating pinned windows and the bottom dock. The quote attaches to the open conversation, or opens its source conversation if none is open. The removable **Quote** badge survives draft saves and reloads. Each input has one attachment: a message quote or a document selection. Sent quotes retain their source link and never create document highlights.

The top-right header shows the original agent’s name with a small status dot: green for idle, a glowing amber dot for busy, a glowing violet dot for compacting, an amber outline for waiting/reconnecting, and a gray outline for unknown/disconnected. Connection errors use red. Hover or keyboard-focus the dot for a tooltip such as “Status: Unknown.” The status also remains available to screen readers, so color is never the only signal. It shows the original agent's last reported activity across all documents: Busy, Idle, Waiting for input, Compacting, Disconnected, or Unknown. The queue count is separate; queued questions and completed Sidecar replies never imply that the terminal agent is busy or idle.

Codex status is sampled once a second from its existing local daemon while a viewer is connected, using read-only `thread/read` without resuming the conversation. Claude registers activity hooks alongside streaming when the updated Sidecar skill is invoked through its native Skill tool. Existing Claude sessions must invoke the updated skill to register these hooks. Missing/unsupported signals show Unknown. Claude user interrupts do not fire Stop; its last reported status may remain until the next activity or idle notification. Subagent hooks never overwrite the original owner's status.

## Lifecycle hooks

The Codex plugin bundles activity/compaction hooks. Claude's shared skill registers its streaming and activity hooks when invoked through the native Skill tool. Both call the installed `sidecar` command and only forward events to an already-running matching app. Do not also configure the examples below when using the plugin; that would duplicate events.

The [Codex](hooks/codex.example.json) and [Claude](hooks/claude.example.json) examples forward native activity and PreCompact/PostCompact events to an already-running app. Replace `/absolute/sidecar`; preserve `SIDECAR_STATE_DIR` if you use a custom directory. Merge the examples into the project's `.codex/hooks.json` or Claude's `.claude/settings.local.json` yourself; Sidecar does not change settings. Native hook trust and permissions still apply.

The header shows “Compacting” between matching start/completion signals. A restart clears this transient status. Codex Interrupt records an interrupted turn; it is not evidence of compaction-specific cancellation. An unavailable app is a no-op. Hook support is distinct from live event delivery verification: see the acceptance record.

Schemas checked against the official [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) and [Claude hooks reference](https://code.claude.com/docs/en/hooks).

For browser checks, install the test browser once with `pnpm exec playwright install chromium`, then run `pnpm exec playwright test`.

The Settings menu includes **Highlight intensity** (20–100%) to dim selection and saved-passage backgrounds independently of text brightness. The preference is saved across documents and app ports; Reset restores the original intensity.

Selections belong to individual messages: one optional selection per user input, and multiple selections per agent reply when you explicitly ask the agent to identify passages. Each saved selection has a **Show/Hide** button for its highlight in the current document. Resolving hides all selections in that thread; reopening or sending another message leaves the old selections hidden. The thread's **⋯** menu offers **Show all selections** and **Hide all selections**, independently of resolution. Hidden selections retain their excerpts and original-document history; original previews always highlight their passage. Agent labels are optional, and inline selection links navigate without switching visibility.

The final reply may start with `[[sidecar-meta {"threadTitle":"Retry settings","highlights":[{"exact":"The retry limit is three.","label":"Retries"}]}]]` on its own line, inside the existing reply markers. The answer can link to `[Retries](#selection-1)`. Metadata is hidden during streaming and saved with the completed answer; invalid optional fields are ignored. `isError: true` marks a failed request without a separate command. Assigned titles remain unchanged. Both native adapters and complete-reply fallback share the same format, documented in the shared Sidecar skill. Highlights never edit the backing Markdown, and only the user changes visibility/resolution.

Saved state upgrades to version 3 on the owning app's next startup, retaining an exclusive byte-exact `state.v1.backup.json` or `state.v2.backup.json` before publication. If a prior migration backup already exists with different contents, a hash-suffixed backup preserves the newer source too. Existing message IDs, request history, and snapshots are retained; resolved threads migrate with hidden selections, other selections stay visible. Snapshots are shared by document/version rather than copied per message. Browsing another owner's documents reads older state without modifying it. Older app versions reject version-3 state; restoring a backup rolls back to its pre-upgrade history.

A truncated native notification can recover its active reply markers with `sidecar request REQUEST_ID --owner KEY`; this reuses the reserved reply stream and does not reset progress or replay the request.
