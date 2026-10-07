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

`--workspace /absolute/worktree` records the checkout the agent is working in; it defaults to the Git top-level of the command's working directory. It roots the document's Files panel and repository/branch badge. Reopening the same file with a different `--workspace` updates it.

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

## Open on a phone or another computer

In the Mac's viewer, open **Settings → Open on phone → Allow access on local network**. Open the displayed address on another device connected to the same network and enter the generated passphrase. It uses the same documents, threads, and attached Codex or Claude conversation. Change the passphrase in the same settings (8–128 characters); saving it signs out network browsers, including connected streams, without affecting localhost access or the agent.

Network access is off by default and turns off when Sidecar stops or restarts. The setting opens a separate IPv4 listener; turning it off disconnects network viewers without restarting the local app or interrupting the agent. Keep the Mac awake and allow Node through the firewall if macOS asks. Guest Wi-Fi isolation can prevent devices from connecting.

Trusted browsers stay signed in with no Sidecar time limit, including after app restarts. Sidecar renews its persistent cookie on visits; browsers may still expire or clear their own storage. Changing the passphrase revokes all remembered browsers. Credentials are saved privately per owner in `network-auth.json`; localhost access does not require the passphrase.

Anyone with the passphrase can use the viewer, including sending requests to the agent, editing documents through proposals, browsing files, and closing saved documents. Use it on a trusted network. The agent credential and agent-only endpoints remain local; viewer cookies and same-origin checks also apply over the LAN. HTTP traffic, including the passphrase, is not encrypted.

The phone's document library opens this agent's documents normally. Other agents' documents use read-only previews; enable access from their own viewer to interact with those agents. Unsent drafts and reading preferences stay in each browser. Rich-text copying falls back to plain text when the browser requires HTTPS.

### Over the internet with ngrok or Cloudflare

Ask the attached Codex or Claude agent: **“Open Sidecar over the internet.”** The shared skill reads your selected provider, checks its setup and existing connectors, starts or reuses a matching tunnel, and returns the public document URL and Sidecar passphrase. The provider must already be installed and authenticated. Ordinary `open`/`browse` commands never publish your viewer automatically.

ngrok is the default. To use a locally managed named Cloudflare Tunnel, create `~/.config/sidecar/config.json`:

```json
{
  "tunnel": {
    "provider": "cloudflare",
    "publicUrl": "https://sidecar.example.com",
    "configPath": "~/.cloudflared/sidecar.yml"
  }
}
```

`configPath` points to your existing Cloudflare YAML, which holds its tunnel ID, credentials-file path, and ingress rules. It must be absolute or start with `~/` and live outside Git checkouts so worktree cleanup cannot claim a shared connector. Sidecar does not copy credentials into this config. Follow the [own-domain Cloudflare setup guide](docs/cloudflare-tunnel.md) to prepare it.

For ngrok, omit the file or use `{"tunnel":{"provider":"ngrok"}}`. You can add `publicUrl` for a reserved HTTPS address configured in your ngrok account. An explicit request to use another provider overrides the choice for that request without changing the file. Provider-specific settings do not carry over. For a one-off Cloudflare request, the skill uses a private temporary `SIDECAR_CONFIG` file with the supplied Cloudflare settings and leaves your saved preferences unchanged.

`sidecar config` prints the effective preferences and source path without starting an app or tunnel. `SIDECAR_CONFIG` can select another JSON file; otherwise Sidecar respects `XDG_CONFIG_HOME` and falls back to `~/.config`. Invalid settings produce an error instead of silently choosing ngrok. The file stores preferences only; creating or editing it does not enable remote access. Reopen Settings to read changes; no app restart is needed. Keep personal values in this local file, outside Git.

**Settings → Open on phone** shows the provider and configured address. The active public URL remains separate until the agent verifies and enables the tunnel. Settings does not launch connectors. For manual ngrok setup, enable local-network access, run the displayed command, and save the resulting HTTPS address. For Cloudflare, follow the linked guide and verify its ingress first.

The owner-scoped commands remain:

```sh
sidecar config                               # read provider preferences
sidecar network --owner KEY                  # inspect current network settings
sidecar network on --owner KEY               # returns protected tunnelTarget
ngrok http http://127.0.0.1:PROTECTED_PORT --inspect=false
sidecar network on --owner KEY --public-url https://sidecar.example.com # ngrok
sidecar cloudflare --owner KEY                # configured Cloudflare: start/reuse and allow origin
sidecar network on --owner KEY --public-url '' # remove public access; keep LAN
sidecar network off --owner KEY               # close remote access
```

Expose only the returned **passphrase-protected `tunnelTarget`**, never the normal localhost viewer. Preserve Host/Origin and `X-Forwarded-Proto: https`; do not use header rewrites. The allowed public URL is an exact HTTPS origin. Passphrase login, same-origin checks, Secure HTTPS cookies, and local-only agent endpoints still apply. Your tunnel provider terminates public TLS and carries traffic to the Mac.

Keep Sidecar, its native agent, the connector, and the Mac running. Disabling network access or restarting Sidecar clears its active public URL and may change the protected port. Ask the agent to reconnect the tunnel; it must recheck the target before reuse. Each active owner needs its own hostname/endpoint. Cloudflare can share a connector with other local services when its live route matches. The launcher uses a generic startup lock and leaves that connector running when Sidecar exits. Missing/stale routes or unknown replicas produce repair instructions; nothing rewrites shared ingress or restarts another service. Connector shutdown is a separate coordinated action.

For traffic totals, compare the same period in [ngrok Usage](https://dashboard.ngrok.com/usage) and [Billing](https://dashboard.ngrok.com/billing), or follow the [Cloudflare monitoring steps](docs/cloudflare-tunnel.md#monitor-traffic). Provider dashboards can lag. Browser DevTools' Network **Transferred** total measures the current browser session (including local access); it is not account-wide traffic or tunnel overhead. Keep ngrok inspection disabled for Sidecar; account usage does not require request-body capture. See [ngrok's plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits).

## Browse all documents

Ask Codex or Claude to “open Sidecar’s document library,” or run `sidecar browse` inside an agent’s native session environment. The explicit form is `sidecar browse --agent codex|claude --session NATIVE_UUID`; `--no-browser` prints its URL. No file path is needed. **Settings → View all documents** opens the same library in a new tab, preserving the current viewer and draft.

The library groups saved documents across all local Codex and Claude sessions. Live entries open their original Sidecar viewer. Stopped sessions have a read-only Markdown preview, including local images; return to the original agent to resume questions and revisions. Browsing never creates a coding conversation, starts another agent, claims its requests, or reassigns documents. The library reads the existing state directory and does not create a second database. Use **Refresh** to update the list.

The document library shows shorthand relative last-opened times (such as `5m ago` or `2d ago`), with the exact date and time on hover. Documents sort newest first, and agent groups sort by the latest open among their documents. Legacy entries show an unknown time until next opened.

Click the **Claude/Codex** label in a viewer or the library to see and copy its original session ID. Session IDs identify the owning conversation; an active Sidecar viewer does not by itself prove its agent is online.

## Workspace files

The small folder tab on the left edge, below the app bar, opens **Files**. It starts at the document's workspace — the worktree its agent declared with `--workspace`, or the Git top-level it opened from. **Up** changes the visible root to its parent; click the displayed path to enter another absolute directory; **Reset visible root** returns to the workspace. Browsing does not change the document's workspace, repository badge, or agent's working directory.

The panel uses Plannotator's file tree, filter box, excluded folders (such as `node_modules` and `.claude`) and Git change badges, extended to list source-code files too. Listing is capped at 5,000 files and 5,000 directories; changed and untracked files get priority. **Refresh** reloads the tree; it does not watch for changes. Click a file window's path (**Show in file browser**) to open the panel, expand the necessary folders, scroll to and highlight the file. If it is outside the visible root, the browser switches to its containing directory.

Selecting a file opens a read-only, draggable and resizable window while the main document stays visible. File windows share the bottom dock with pinned messages, including **Dock**, **Minimize**, tab reordering and the **One at a time / Multiple** setting. Reopening a file focuses its existing window or dock tab and reloads its contents. Markdown and text render as documents, code/JSON/YAML use Plannotator's Pierre renderer with syntax highlighting and line numbers, Mermaid and Graphviz render as diagrams, and HTML uses a static sandboxed frame. Opening a file never registers a document or contacts the agent. Relative images inside previewed files are not loaded. The panel's width and open state are saved in this browser. Documents without a recorded workspace hide the button; reopen them from the agent to add one.

Select text in a file window or the dock to attach it to the current conversation's next reply, just like quoting a message. From the thread list, selection opens a new conversation. The attachment retains its file path, exact text and code line numbers, survives draft reloads, and replaces any other selection on that input. Submit a question or revision request to send it to the same attached Codex or Claude agent. Clicking a sent attachment reopens the file; file quotes do not create highlights in the main document or archive file revisions. Static HTML frames and rendered diagrams do not expose text selections to the app.

Links to local files in documents and replies open the same windows. Code links such as `src/server.ts:42` show highlighted source for the whole file rather than jumping to the line. Relative document links follow the linking file; repository-style code paths start at the workspace root. You can explicitly choose directories or click files outside the workspace. Those actions grant a browsing root for this document and running server only; passive hover previews cannot grant access. Reads still require the viewer cookie and Host/Origin checks, stay within the selected real root, reject unsupported types and symlink escapes, and enforce the 2 MiB limit. Closing the document or restarting the app clears the additional grants.

## Passage comments

Select text and click **Comment** or press **C** to open a floating composer beside the passage. The shortcut leaves typing and Ctrl/Cmd+C untouched. The highlight remains visible while you type. Clicking outside dismisses an empty composer; a composer with a draft stays open. **Send** (or Enter) starts a thread with the original agent; **Cancel** or Escape discards the unsent comment. Select another passage at any time to start a separate comment; reselecting a passage restores its draft while this page stays open. Failed sends preserve the draft for retry. Shift+Enter adds a new line. Textboxes grow with their contents and then scroll.

Saved passages retain their visibility after reload. Click a highlight, or focus it with Tab and press Enter, to reach its thread and selection card. The active selection has a violet highlight and outline; other passages stay amber. Clicking the quote in the conversation scrolls to its passage and briefly emphasizes visible highlights (unless reduced motion is enabled). When selections overlap, choose the reference you want. Resolving a thread hides all its selections while keeping its conversation in the Resolved list. Reopening leaves them hidden; use **Show** beside a selection or **Show all selections** to display them again. Other threads' visible selections remain highlighted. Missing or changed passages retain their message and quote with **Passage changed**. Ambiguous references show **Multiple matching passages** instead: **Choose passage** opens the saved original with nearby context for each occurrence. Choosing one saves its location and highlights it in that original. Later document versions still require matching text and context; an old offset cannot silently select a different passage.

Click **View original document** on a changed passage to temporarily show the saved Markdown in the main pane, with its original passage highlighted. The conversation and draft stay available. **Return to current** restores the latest document. Sidecar saves versions as they are viewed, so versions from before this feature may be unavailable; their quoted text is still kept and the original-document link is hidden. Saved Markdown lives under `versions/` in the owner’s state directory and survives app restarts. Linked images are loaded from their current locations, not archived.

## Closing a document

The **Close document** button in the top bar asks for confirmation before permanently deleting that document’s threads, messages, highlights, proposals, and saved revisions. The Markdown file (including agent-generated files), other documents, text sizes, and panel settings remain. There is no undo. Browser drafts are cleared on the current local origin; a small closed-document marker prevents suspended tabs from saving an old draft again.

You can also close a document from its row in **Browse all documents**, after the same confirmation. This works for the current agent and other Codex or Claude sessions, whether their Sidecar app is running or stopped; closing never restarts the app or coding agent.

Queued, running, or interrupted requests must finish or be reconciled before closing; the agent-label popover's **Reset** can release stuck in-progress work after native verification. The viewer shows **Document closed** with **Browse all documents**. The app remains available for browsing even after closing its last document; use `sidecar stop --owner KEY` to stop it explicitly. The coding agent keeps running. Last-opened metadata for the closed document is removed. Other open viewers receive the closure. A disk or browser cleanup failure is reported explicitly.

## Document conversations

The document sits beside a conversation sidebar. The top-right panel button hides or reopens it without losing the selected thread or draft. On desktop, drag the pane’s left edge to resize it with Plannotator’s resize handle; the width is saved in this browser. Clicking the edge, its collapse arrow, or dragging it nearly shut collapses the pane. Reopening restores its saved width. Clicking a saved annotation or submitting a new comment reopens its conversation. The pane starts open on desktop and closed on narrow screens. Use the back arrow for the thread list, **+** for another general conversation, and the status dropdown to switch between **Unresolved** (default), **Resolved**, and **All** threads. Search matches titles, selected passages, labels, and messages; each result shows its first matching excerpt with the match highlighted in a two-line preview. The checkmark resolves a thread and returns to the unresolved list. Reopening a resolved thread keeps its conversation open. Sending a new message also reopens it and switches the list filter to Unresolved, leaving previously hidden selections off; late agent replies and retries of already accepted messages preserve resolution. Threads sort by latest message activity. Beside the message preview, a dot marks an unread agent reply, a clock marks queued work, and a spinner marks a claimed request. The spinner replaces the clock while work is in progress. Opening a visible conversation marks its replies read; read state is kept in this browser across reloads. Clicking a saved highlight opens its conversation; submitting an annotation selects the new conversation automatically.

Each document starts with an **Unnamed** general conversation. The original agent names a thread once its question/history has enough context, using an optional metadata line in the same final reply. Vague openings stay unnamed until a later message. Agents do not rename assigned titles. You can edit a title with the pencil beside it in the open conversation; Enter or blur saves and Escape cancels. This instruction is shared by Codex and Claude; it does not create another model session or require a naming command.

Your messages use compact right-aligned bubbles; agent replies use the full width without bubbles or author labels. Both render rich Markdown using the document renderer, including replies while they stream. Heading links in a message stay within that message. A small Queued or Working… placeholder appears below a pending message in the response area and disappears when that request’s reply starts arriving, including streamed replies. Other unanswered messages keep their own status.

Hover over a sent message or focus its controls to **Copy** or **Pin** it. Pinning opens a reference window immediately. Pins are saved with the conversation and listed below its title: up to three show in full; longer lists start with two and an expand button. Click a pin's text to reopen its window; click its icon to choose a line icon, capital letter, number, or one of twelve colors. Typing a letter or digit while that menu is focused selects it directly. The menu also offers **Go to message**, with **Unpin** separated at the bottom. Each window is draggable and resizable from its edges; closing it keeps the pin. Attached selections keep their **Show/Hide**, passage navigation, and original-document controls. **Go to message** in the pin menu, window, or dock focuses the exact message, reopening its source thread when needed, without closing any reference.

Drag a window into the bottom dock to make it a tab. Drop near a tab gap to choose its position, drag tabs to reorder, or pull a tab out to restore its window. **Dock** moves the window into the dock and opens it; **Minimize**, beside it, docks the window and collapses the dock. Each tab has close and pop-out buttons. Resize the expanded dock from its top edge. A collapsed dock accepts drops within its bottom bar and briefly previews the incoming message; it collapses again after the drop. The dock remembers its expanded state even when empty. An expanded empty dock shows a compact **Drop a window here** target at its minimum height; dropping restores the normal or remembered dock height. Open windows and their positions last for this viewer tab; saved pins survive reloads and app restarts.

**Settings** opens a modal with reading controls, **Copy messages as** (Raw Markdown, Rich text, or Plain text), and **Windows** (Multiple or One at a time). Switching to one window keeps the most recently opened file or pinned reply without removing any pins. Copy includes only the message text; internal selection links become their labels. Rich copying includes HTML and plain text, falling back to plain text if the browser cannot write rich content. Dock tabs support arrow-key navigation and Alt+Arrow reordering; a focused window title supports arrow-key movement and Shift+Arrow resizing.

Back discards a conversation with no messages or unsent draft. Threads with messages, drafts, or a submission in progress are kept. Each thread’s unsent message is saved in this browser after a 100 ms pause, at least every two seconds during continuous typing, and immediately when leaving the field, switching threads, or leaving the page. Drafts restore after a reload or reopening the same local app URL and clear only after a successful send or when you erase them. Failed submissions retain their retry ID across reloads to avoid duplicate requests. Conversation scroll positions survive switching threads while the page stays open. Background replies do not change the selected conversation. Each message's selection shows at most two lines; hover for the full quote or click to find its passage. Removed or ambiguous passages keep the quote and history with their matching-status explanation.

Click the pencil beside the document name to edit it inline. Enter or clicking away saves, Escape cancels. Failed saves preserve the draft. The browser title follows the saved name. Unsent selection comments that have not yet created a thread stay in memory only. Saved thread drafts belong to this browser and local origin; they do not sync between devices or different server ports.

The browser UI uses React, `@plannotator/ui` (pinned to 0.47.0), and `@plannotator/web-highlighter`. Document components, typography, colors, and spacing come from Plannotator; its Inter, Geist Mono, and KaTeX fonts are served locally. The compact comment popover follows Plannotator’s styling. Attribution is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The local server bundles the UI on page load with esbuild, so no separate frontend server or build command is required.

The Settings gear beside the panel toggle has separate **Document** and **Conversation** text-size sliders (80–150%). Changes apply immediately; conversation sizing also adjusts the message composer. Reset restores both to 100%. A shared **Text brightness** slider dims document and conversation text from 100% (the original colors) down to 50%, preserving syntax colors and leaving media and controls unchanged. It has its own Reset. Preferences are saved in this browser across new Sidecar sessions and ports. The Settings footer shows the running app’s version and, for installed builds, its Git revision (matching `sidecar --version` from that release).

The document card shows the repository and branch captured from the working directory when the agent opens it, including linked worktrees. Older documents gain this context when reopened from their project; non-repository opens omit the badges. **Copy file** copies the current raw Markdown. The badges reuse Plannotator’s component and preserve its heading spacing.

## Rich Markdown

Documents render syntax-highlighted code with copy buttons, Mermaid and Graphviz diagrams with source/zoom/expand controls, inline and display math, tables, task lists, callouts, images, and sanitized HTML within Markdown. Heading links navigate within the document. Click a Markdown image to enlarge it; Escape closes the image. Local images must be within the registered document’s directory (including subdirectories); symlinks escaping that directory are rejected. HTTPS and data images are also supported. Responsive HTML images use their fallback `img` source.

In the main document, click a heading or its chevron to fold the section through the next heading of equal or higher level. Nested sections fold independently. A trailing group of dividers and empty HTML break spacers stays between sections when the next heading closes the preceding section; internal dividers and spacer-only tails stay inside their section. Expanded sections show their chevron on section hover or keyboard focus; collapsed sections always show it. Manual toggles animate over 120 ms in supporting browsers, unless reduced motion is enabled. Fold state is saved per document in this browser using heading anchors, surviving reloads and body edits; new or renamed headings start expanded. Heading and annotation links immediately open the necessary enclosing sections fully before scrolling, including existing HTML disclosure blocks and selections in saved originals. Opened heading sections update the saved fold state too. Selecting across folded content reveals it before attaching the passage. Closing a document clears its saved heading folds. Replies and file windows keep their existing rendering.

Passage comments work on rendered text, including code and tables. Diagram controls, SVGs, and math are excluded from text anchors; image-region and diagram-node annotations are outside this version. A renderer change can make an old passage’s text context differ; the existing thread and original quote remain available as “Passage changed.” This does not add standalone HTML-document mode.

The renderer allows inline styles for syntax highlighting, math, and diagrams, plus WebAssembly for Graphviz and HTTPS/data images. Inline document scripts remain blocked; raw HTML is sanitized. Local image responses have a sandbox policy, and fonts/images require the viewer cookie. Both agents retain their existing request, revision, and reply flow.

## Streaming replies

Both original agents can stream reply text while keeping their terminal session. Codex receives native text chunks from the existing app-server Unix socket (verified with CLI 0.159.3). Claude uses the skill's `MessageDisplay` hook (verified with 2.1.286), which supplies completed lines in batches; short replies can arrive all at once. Invoke the Claude skill through its native Skill tool; merely reading the Markdown does not register hooks. The hook does nothing when Sidecar is stopped and does not modify terminal text or global settings.

Sidecar prepares requests before delivering them: the compact native event includes the question, selected passage when present, routing IDs, `thread.lastRequestId` (null for the first message), exact reply markers, and the reminder “Follow the Sidecar skill.” It omits the document body, automatic thread history, repeated IDs, timestamps, and internal status fields. The preceding request ID helps the agent recognize context it already has; if needed, it can retrieve the thread again. For a partial-sentence highlight, the viewer mechanically captures its surrounding sentence (up to 512 characters); a whole-sentence or multi-sentence selection needs no extra sentence. Older highlights remain valid without sentence context. The agent uses selection context only when relevant, answers simple questions directly, and can retrieve the file path/content or full saved anchors with `sidecar request ID --owner KEY` when needed. For that optional context read, `already-claimed` is expected because the request was prepared before delivery. Codex's app dispatcher and Claude's watcher own the claim and stream setup; the agent can answer an existing named thread without a preliminary tool command. Questions or selections over 48 KiB keep the ID-only event and `request ID --owner KEY --stream` fallback so native delivery limits cannot silently truncate a question. The agent emits an assistant message between the supplied `stream.prefix` and `stream.suffix` as its final response (after any document edits). If stream setup fails, delivery still includes the prepared question and a `stream.error` for the complete-reply fallback; duplicate or completed claims do not start another stream. The separate `stream` command remains available for a request claimed without `--stream`. Native message completion with the closing marker automatically saves the reply. Requests show Queued until the native handoff succeeds, then Working. Before tool work, the agent uses the supplied `stream.progress` markers for brief interim updates; each update streams into the thread and remains in its history. The existing `stream.prefix` and `stream.suffix` are reserved for the final answer that completes the request. The markers are visible in the terminal but stripped from the viewer. Unmarked commentary, reasoning, and tool output are excluded. Both Codex and Claude share this progress/final contract; no extra agent command is required.

Messages already queued in the same thread are delivered together, in order, without an added batching delay. The event uses `messages[]`, with each input's text and optional selection; single-message events retain `text`. Inputs remain separate in the conversation, with one combined reply and one Working/Stopped indicator. Other threads are not combined. Batch membership is saved before handoff; later arrivals get their own delivery, including during an active native turn. Stop, failure, completion, and restart recovery apply to that saved batch together. Large batches use the existing ID-only fetch path without dropping inputs. Update/reload the shared Sidecar skill in existing agents so they recognize this format.

Before handoff, inputs appear in **Queued · N** above the composer, with one-line previews and links to their attached selections. They enter chat together when delivery succeeds; preparing a batch alone does not move them. Each delivered batch stays with its replies, so a later queued follow-up appears after the previous answer. Saved queue items, selections and delivery receipts survive reloads and app restarts; an interrupted handoff without a receipt remains outside chat until reconciled.

The completed message saves the reply exactly once; `reply ... --stream` is an optional idempotent completion check. Missing chunks or incomplete markers cannot finalize a reply. While the observer remains connected, a later complete assistant message using the same request markers can replace the interrupted capture; it saves once and releases the next queued request without rerunning any edits. A disconnected observer still needs the existing plain-text stdin reply recovery path. A browser reload recovers the current draft. Successful native delivery shows Working; it does not prove the agent has started processing. App restart discards transient drafts and leaves prepared/claimed requests uncertain for reconciliation; it never silently repeats a possible document edit. Watcher reconnects suppress already prepared requests. The agent reads the current backing file before revisions; a saved selection can refer to an older document revision. Sidecar does not launch a new model session. The shared skill answers quick questions directly and delegates extended work to temporary native subagents when available, with results relayed by the original agent to the same thread. One owner listener routes outstanding replies across threads using stable thread tags and exact request receipts. If a later same-thread input supplies `covers`, its answer also completes those still-unanswered inputs; other threads stay independent. Exhausted subagent capacity falls back to direct work or waiting. Codex streaming requires the original conversation to be loaded in its local daemon; unsupported configurations retain complete-message replies.

When a marked Sidecar turn finishes without a saved final reply, Sidecar checks its native final output after earlier capture/save operations finish. If the answer is still missing, it makes one **reply-only recovery** attempt through the original Codex queue or Claude watcher. The recovery event supplies the current markers and asks for the existing answer; it does not resend the task or authorize repeating edits. A valid late reply saves once and cancels any recovery that has not been handed off. Duplicate completion events cannot create extra attempts. Unrelated idle events, waiting questions, and user interruptions do not start automatic recovery.

The viewer shows **Reply wasn’t saved; recovering…**, then **Retry saving reply** if the recovery turn fails or delivery reports an error. Attempts are recorded before handoff. Restarting never resends an ambiguous recovery: it leaves the request for an explicit retry, preserving its batch and history. Claude requires its native control module for this turn-completion check, just as it does for Stop; generic activity hooks alone are not evidence that a particular request finished.

## Agent activity

An empty conversation composer shows **Stop agent** whenever the attached native agent is working and its exact turn is known, even before output or while it is answering another thread or doing terminal work. Typing restores Send; Enter on an empty composer never interrupts. Unsent messages remain queued. The click targets the displayed native turn; a stale click cannot interrupt a later turn. Stop waits for native confirmation, keeps progress and partial output as **Stopped**, and does not roll back file edits or retry the question. Confirmed terminal interruptions also mark all deliveries bound to that turn Stopped and release later queued messages. A reply already completed wins the race. A failed or unconfirmed interruption leaves the request recoverable and shows an error.

Click the **Claude/Codex label → Reset** to reconcile a stuck request, including an idle agent with a thread still showing Working. Reset verifies the original session afresh. If it is working, Reset can interrupt **any work in that session**, including unrelated terminal work, and waits for the identified turn to end. It preserves saved messages and captured partial output, marks unfinished claimed/uncertain batches **Stopped**, and releases later queued messages. It pauses new Sidecar deliveries while checking; already completed replies win. Reset does not undo edits, restart an agent, delete history, or replay the interrupted task. If native verification fails, state remains recoverable; reconnect the original session and retry. A killed or unreachable process is not treated as idle merely because it stopped reporting.

Busy Codex input uses native `turn/steer` at the next safe boundary. Claude’s native Monitor supplies input during ongoing work; its control module records which native turn received it. Neither transport waits for another thread to finish. Lost handoff acknowledgments remain uncertain instead of resending possible edits. Native observation stays on the host: browser SSE carries only lightweight status and current reply text, without repeatedly sending document bodies or saved history.

For Codex, Reset also withdraws the exact stopped Sidecar submissions from the native queue before releasing another request. It leaves unrelated terminal messages alone. Successful `codex queue` delivery does not itself start a turn: Sidecar starts its existing submission when the original session is idle and that submission is first in the native queue. It checks again after busy terminal work becomes idle, including when the viewer is not connected. Starting never re-enqueues a message or jumps ahead of unrelated input. A failed native queue check remains recoverable and is reported instead of claiming Reset succeeded. This uses the native experimental queue API verified with Codex 0.160.0.

If a final answer arrives after its recovery was queued, Sidecar withdraws the obsolete recovery after any in-flight delivery settles. Completed answers remain saved, later questions can proceed, and cleanup does not require another agent turn or an open browser.

Codex uses its existing daemon's turn-specific interrupt API. Claude requires native plugin modules (Claude Code 2.1.287+); load the updated plugin when starting/resuming the session. Re-invoking the skill alone cannot load that module into an already-running session. The module binds delivered inputs to native turns before reply output, reports native completion, and polls while active or idle so explicit Reset can request a fresh check. A freshly loaded module reports Unknown until it has observed a native turn; it never assumes idle from a missing start event. Ordinary streaming replies remain available without this control channel. Full Stop paths were checked on 2026-10-03 with Codex 0.160.0 and Claude 2.1.288.

Select text in a sent message to quote it in your next reply, including messages in floating pinned windows and the bottom dock. The quote attaches to the open conversation, or opens its source conversation if none is open. The removable **Quote** badge survives draft saves and reloads. Each input has one attachment: a message quote or a document selection. Sent quotes retain their source link and never create document highlights.

The top-right header shows the original agent’s name with a small status dot: green for idle, a glowing amber dot for busy, a glowing violet dot for compacting, an amber outline for waiting/reconnecting, and a gray outline for unknown/disconnected. Connection errors use red. Hover or keyboard-focus the dot for a tooltip such as “Status: Unknown.” The status also remains available to screen readers, so color is never the only signal. It shows the original agent's last reported activity across all documents: Busy, Idle, Waiting for input, Compacting, Disconnected, or Unknown. The queue count is separate; queued questions and completed Sidecar replies never imply that the terminal agent is busy or idle.

Codex status is sampled once a second from its existing local daemon while a viewer is connected, using read-only `thread/read` without resuming the conversation. Claude registers activity hooks alongside streaming when the updated Sidecar skill is invoked through its native Skill tool. Existing Claude sessions must invoke the updated skill to register these hooks. Its native control module also reports observed active/idle state, including after terminal interruption. Missing/unsupported signals show Unknown. Subagent hooks never overwrite the original owner's status.

## Lifecycle hooks

The Codex plugin bundles activity/compaction hooks. Claude's shared skill registers its streaming and activity hooks when invoked through the native Skill tool. Both call the installed `sidecar` command and only forward events to an already-running matching app. Do not also configure the examples below when using the plugin; that would duplicate events.

The [Codex](hooks/codex.example.json) and [Claude](hooks/claude.example.json) examples forward native activity and PreCompact/PostCompact events to an already-running app. Replace `/absolute/sidecar`; preserve `SIDECAR_STATE_DIR` if you use a custom directory. Merge the examples into the project's `.codex/hooks.json` or Claude's `.claude/settings.local.json` yourself; Sidecar does not change settings. Native hook trust and permissions still apply.

The header shows “Compacting” between matching start/completion signals. A restart clears this transient status. Codex Interrupt records an interrupted turn; it is not evidence of compaction-specific cancellation. An unavailable app is a no-op. Hook support is distinct from live event delivery verification: see the acceptance record.

Schemas checked against the official [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) and [Claude hooks reference](https://code.claude.com/docs/en/hooks).

For browser checks, install the test browser once with `pnpm exec playwright install chromium`, then run `pnpm exec playwright test`.

The Settings menu includes **Highlight intensity** (20–100%) to dim selection and saved-passage backgrounds independently of text brightness. The preference is saved across documents and app ports; Reset restores the original intensity.

Selections belong to individual messages: one optional selection per user input, and multiple selections per agent reply when you ask the agent to identify passages or it reports where it edited the document. Edit summaries that name a section or passage include a clickable selection link. For navigation, agents prefer the shortest unique existing heading or label and describe the location under, before, or after it; longer selections are for discussing the wording itself. Each saved selection has a **Show/Hide** button for its highlight in the current document. Resolving hides all selections in that thread; reopening or sending another message leaves the old selections hidden. The thread's **⋯** menu offers **Show all selections** and **Hide all selections**, independently of resolution. Hidden selections retain their excerpts and original-document history; original previews always highlight their passage. Agent labels are optional, and inline selection links navigate without switching visibility.

“Where?”, “show me where”, and “which passage?” count as requests to identify document text; you do not need to name the highlight feature. For insertion points, both agents use a short existing anchor and say under/before/after it, without editing the document just to point at it. Other routine explanations and edits do not add unrelated highlights.

The final reply may start with `[[sidecar-meta {"threadTitle":"Retry settings","highlights":[{"exact":"The retry limit is three.","label":"Retries"}]}]]` on its own line, inside the existing reply markers. The answer can link to `[Retries](#selection-1)`. Metadata is hidden during streaming and saved with the completed answer; invalid optional fields are ignored. `isError: true` marks a failed request without a separate command. Assigned titles remain unchanged. Both native adapters and complete-reply fallback share the same format, documented in the shared Sidecar skill. Highlights never edit the backing Markdown, and only the user changes visibility/resolution.

### Proposed document edits

Ask the attached Codex or Claude agent to propose a change for approval. It can attach a literal Markdown replacement to a highlight in its normal final reply, using `proposal: {before, after}` (and optional source `prefix`/`suffix`) inside that highlight's metadata. The file stays unchanged until you accept. This covers the registered main document only; direct requests to edit still use the agent's ordinary editing tools.

Click its annotation, inline selection link, or **Review change** card to open the document popover. It shows removed/added Markdown and an expandable exact **Source diff**; formatting-only edits expose that diff automatically. **Accept** writes the current file after validating the exact source and surrounding context. **Reject** changes only the saved decision. **Accept all (N)** applies the valid, disjoint proposals in that one reply; stale or overlapping items remain unapplied with an explanation. These actions work while the attached agent is busy and do not submit another request. Accepted/rejected changes remain available through **View change**, including from pinned messages. Original-document views cannot apply changes.

The review window is draggable, resizable, and scrollable, stays open while you type elsewhere, and remembers its own **Text size** independently of Document and Conversation settings.

Sidecar serializes its own decisions and rechecks file identity/content immediately before atomic replacement, preserving permissions and bytes outside the changes. This is optimistic coordination, not a filesystem transaction with unrelated editors: another process can still write after that last check. Shared before/after snapshots and a durable write record support restart recovery without applying twice. A file matching neither saved version is preserved and the affected proposal becomes outdated with an unconfirmed-application explanation.

The completed reply stores each proposal separately with its source snapshot, selection and decision history. Invalid proposal metadata keeps the answer and shows a diagnostic; an unavailable or ambiguous source makes the proposal outdated. Rendered-text navigation and literal source replacement are independent: choosing a navigation occurrence never authorizes an ambiguous replacement. Both agents use the [shared Sidecar skill](.agents/skills/sidecar/SKILL.md); no extra proposal tool call or larger native request event is needed. Progress and interrupted replies cannot create actionable proposals.

Saved state upgrades to version 5 on the owning app's next startup, retaining an exclusive byte-exact `state.v1.backup.json`, `state.v2.backup.json`, `state.v3.backup.json`, or `state.v4.backup.json` before publication. If a prior migration backup already exists with different contents, a hash-suffixed backup preserves the newer source too. Existing message IDs, request history, and snapshots are retained; resolved legacy threads migrate with hidden selections, other selections stay visible. Snapshots are shared by document/version rather than copied per message or proposal. Browsing another owner's documents reads older state without modifying it. Older app versions reject version-5 state, which records concurrent deliveries and completion coverage. There is no automatic downgrade: keep newer state separately before considering a backup restore, which rolls history back to that backup's contents.

A truncated native notification can recover its active reply markers with `sidecar request REQUEST_ID --owner KEY`; this reuses the reserved reply stream and does not reset progress or replay the request.
