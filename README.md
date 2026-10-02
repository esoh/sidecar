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

The agent must load the skill before opening: it explains request claims and replies and establishes the scope of document questions/revisions. A file cannot grant permission through its contents. Native tool approvals still apply.

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

Click the **Claude/Codex** label in a viewer or the library to see and copy its original session ID. Session IDs identify the owning conversation; an active Sidecar viewer does not by itself prove its agent is online.

## Passage comments

Select text and click **Comment** or press **C** to open a floating composer beside the passage. The shortcut leaves typing and Ctrl/Cmd+C untouched. The highlight remains visible while you type. Clicking outside dismisses an empty composer; a composer with a draft stays open. **Send** (or Enter) starts a thread with the original agent; **Cancel** or Escape discards the unsent comment. Select another passage at any time to start a separate comment; reselecting a passage restores its draft while this page stays open. Failed sends preserve the draft for retry. Shift+Enter adds a new line. Textboxes grow with their contents and then scroll.

Saved passages remain highlighted after reload. Click a highlight, or focus it with Tab and press Enter, to reach its thread. The active thread’s passage has a violet highlight and outline; other passages stay amber. Clicking the quote in the conversation scrolls to its passage and briefly emphasizes it (unless reduced motion is enabled). When threads overlap, choose the question you want. Resolving a thread removes its highlight while keeping its conversation in the Resolved list. Reopening restores the highlight if the passage still exists. Overlapping unresolved threads remain highlighted. If a file edit makes a passage missing or ambiguous, its thread and quote remain, marked “Passage changed.”

Click **View original document** on a changed passage to temporarily show the saved Markdown in the main pane, with its original passage highlighted. The conversation and draft stay available. **Return to current** restores the latest document. Sidecar saves versions as they are viewed, so versions from before this feature may be unavailable; their quoted text is still kept and the original-document link is hidden. Saved Markdown lives under `versions/` in the owner’s state directory and survives app restarts. Linked images are loaded from their current locations, not archived.

## Document conversations

The document sits beside a conversation sidebar. The top-right panel button hides or reopens it without losing the selected thread or draft. On desktop, drag the pane’s left edge to resize it with Plannotator’s resize handle; the width is saved in this browser. Clicking the edge, its collapse arrow, or dragging it nearly shut collapses the pane. Reopening restores its saved width. Clicking a saved annotation or submitting a new comment reopens its conversation. The pane starts open on desktop and closed on narrow screens. Use the back arrow for the thread list, **+** for another general conversation, and the status dropdown to switch between unresolved (default) and resolved threads. The checkmark resolves a thread and returns to the unresolved list. Reopening a resolved thread keeps its conversation open. Sending a new message also reopens it, restores its passage highlight, and switches the list filter to Unresolved; late agent replies and retries of already accepted messages preserve resolution. Threads sort by latest message activity and have separate general/annotation icons. Beside the message preview, a dot marks an unread agent reply, a clock marks queued work, and a spinner marks a claimed request. The spinner replaces the clock while work is in progress. Opening a visible conversation marks its replies read; read state is kept in this browser across reloads. Clicking a saved highlight opens its conversation; submitting an annotation selects the new conversation automatically.

Each document starts with an **Unnamed** general conversation. The original agent names a thread once its question/history has enough context, using `name-thread THREAD_ID --owner KEY --title "Short name"`. Vague openings stay unnamed until a later message. Names are stable once assigned. This instruction is shared by Codex and Claude; it does not create another model session.

Your messages use compact right-aligned bubbles; agent replies use the full width without bubbles or author labels. Both render rich Markdown using the document renderer, including replies while they stream. Heading links in a message stay within that message. A small Queued or Working… placeholder appears below a pending message in the response area and disappears when that request’s reply starts arriving, including streamed replies. Other unanswered messages keep their own status.

Back discards a conversation with no messages or unsent draft. Threads with messages, drafts, or a submission in progress are kept. Each thread’s unsent message is saved in this browser after a 100 ms pause, at least every two seconds during continuous typing, and immediately when leaving the field, switching threads, or leaving the page. Drafts restore after a reload or reopening the same local app URL and clear only after a successful send or when you erase them. Failed submissions retain their retry ID across reloads to avoid duplicate requests. Conversation scroll positions survive switching threads while the page stays open. Background replies do not change the selected conversation. The quote above an annotated conversation shows at most two lines; hover for the full quote or click to find its passage. Removed or ambiguous passages keep the quote and history, labeled **Passage changed**.

Click the pencil beside the document name to edit it inline. Enter or clicking away saves, Escape cancels. Failed saves preserve the draft. The browser title follows the saved name. Unsent selection comments that have not yet created a thread stay in memory only. Saved thread drafts belong to this browser and local origin; they do not sync between devices or different server ports.

The browser UI uses React, `@plannotator/ui` (pinned to 0.47.0), and `@plannotator/web-highlighter`. Document components, typography, colors, and spacing come from Plannotator; its Inter, Geist Mono, and KaTeX fonts are served locally. The compact comment popover follows Plannotator’s styling. Attribution is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The local server bundles the UI on page load with esbuild, so no separate frontend server or build command is required.

The Settings gear beside the panel toggle has separate **Document** and **Conversation** text-size sliders (80–150%). Changes apply immediately; conversation sizing also adjusts the message composer. Reset restores both to 100%. Preferences are saved in this browser across new Sidecar sessions and ports. The Settings footer shows the running app’s version and, for installed builds, its Git revision (matching `sidecar --version` from that release).

## Rich Markdown

Documents render syntax-highlighted code with copy buttons, Mermaid and Graphviz diagrams with source/zoom/expand controls, inline and display math, tables, task lists, callouts, images, and sanitized HTML within Markdown. Heading links navigate within the document. Click a Markdown image to enlarge it; Escape closes the image. Local images must be within the registered document’s directory (including subdirectories); symlinks escaping that directory are rejected. HTTPS and data images are also supported. Responsive HTML images use their fallback `img` source.

Passage comments work on rendered text, including code and tables. Diagram controls, SVGs, and math are excluded from text anchors; image-region and diagram-node annotations are outside this version. A renderer change can make an old passage’s text context differ; the existing thread and original quote remain available as “Passage changed.” This does not add standalone HTML-document mode.

The renderer allows inline styles for syntax highlighting, math, and diagrams, plus WebAssembly for Graphviz and HTTPS/data images. Inline document scripts remain blocked; raw HTML is sanitized. Local image responses have a sandbox policy, and fonts/images require the viewer cookie. Both agents retain their existing request, revision, and reply flow.

## Streaming replies

Both original agents can stream reply text while keeping their terminal session. Codex receives native text chunks from the existing app-server Unix socket (verified with CLI 0.159.3). Claude uses the skill's `MessageDisplay` hook (verified with 2.1.286), which supplies completed lines in batches; short replies can arrive all at once. Invoke the Claude skill through its native Skill tool; merely reading the Markdown does not register hooks. The hook does nothing when Sidecar is stopped and does not modify terminal text or global settings.

The agent runs `request ID --owner KEY --stream` once to claim the question, fetch its context, and prepare its reply stream. It then emits an assistant message between the returned `stream.prefix` and `stream.suffix` as its final response (after any document edits). If stream setup fails, the command still returns the claimed question and a `stream.error` for the complete-reply fallback; duplicate or completed claims do not start another stream. The separate `stream` command remains available for a request claimed without `--stream`. Native message completion with the closing marker automatically saves the reply. Only that marked message becomes a draft in that document thread. The markers are visible in the terminal but stripped from the viewer. Unmarked commentary, reasoning, and tool output are excluded.

The completed message saves the reply exactly once; `reply ... --stream` is an optional idempotent completion check. Missing chunks, incomplete markers, or a disconnected observer prevent streaming finalization; the existing plain-text stdin reply is the recovery path. A browser reload recovers the current draft. App restart discards transient drafts and leaves claimed requests uncertain for reconciliation. No new model session is launched. Codex streaming requires the original conversation to be loaded in its local daemon; unsupported configurations retain complete-message replies.

## Agent activity

The top-right header shows the original agent’s name with a small status dot: green for idle, a glowing amber dot for busy, a glowing violet dot for compacting, an amber outline for waiting/reconnecting, and a gray outline for unknown/disconnected. Connection errors use red. Hover or keyboard-focus the dot for a tooltip such as “Status: Unknown.” The status also remains available to screen readers, so color is never the only signal. It shows the original agent's last reported activity across all documents: Busy, Idle, Waiting for input, Compacting, Disconnected, or Unknown. The queue count is separate; queued questions and completed Sidecar replies never imply that the terminal agent is busy or idle.

Codex status is sampled once a second from its existing local daemon while a viewer is connected, using read-only `thread/read` without resuming the conversation. Claude registers activity hooks alongside streaming when the updated Sidecar skill is invoked through its native Skill tool. Existing Claude sessions must invoke the updated skill to register these hooks. Missing/unsupported signals show Unknown. Claude user interrupts do not fire Stop; its last reported status may remain until the next activity or idle notification. Subagent hooks never overwrite the original owner's status.

## Lifecycle hooks

The Codex plugin bundles activity/compaction hooks. Claude's shared skill registers its streaming and activity hooks when invoked through the native Skill tool. Both call the installed `sidecar` command and only forward events to an already-running matching app. Do not also configure the examples below when using the plugin; that would duplicate events.

The [Codex](hooks/codex.example.json) and [Claude](hooks/claude.example.json) examples forward native activity and PreCompact/PostCompact events to an already-running app. Replace `/absolute/sidecar`; preserve `SIDECAR_STATE_DIR` if you use a custom directory. Merge the examples into the project's `.codex/hooks.json` or Claude's `.claude/settings.local.json` yourself; Sidecar does not change settings. Native hook trust and permissions still apply.

The header shows “Compacting” between matching start/completion signals. A restart clears this transient status. Codex Interrupt records an interrupted turn; it is not evidence of compaction-specific cancellation. An unavailable app is a no-op. Hook support is distinct from live event delivery verification: see the acceptance record.

Schemas checked against the official [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) and [Claude hooks reference](https://code.claude.com/docs/en/hooks).

For browser checks, install the test browser once with `pnpm exec playwright install chromium`, then run `pnpm exec playwright test`.

The document library shows last-opened times. Documents sort newest first, and agent groups sort by the latest open among their documents. Legacy entries show an unknown time until next opened.
