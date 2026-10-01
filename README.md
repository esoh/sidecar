# Sidecar

A local Markdown viewer for questions and revisions in your existing Codex or Claude Code conversation. Select a passage or ask a general question; replies stay in persistent threads across documents. Only you resolve or reopen threads.

## Development

Node 22+ and pnpm. Run `pnpm install`, `pnpm test`, and `pnpm typecheck`. Nothing is installed globally. The shared [Sidecar skill](.agents/skills/sidecar/SKILL.md) is also linked from `.claude/skills/sidecar`.

## Use from an agent

Ask the existing agent to read the skill, then open a file. From another repository use the absolute checkout path and absolute document path:

```sh
pnpm --dir /absolute/sidecar sidecar open --agent codex --session NATIVE_UUID --file /absolute/review.md
```

Use `--agent claude` for Claude. Explicit IDs must match the selected agent's native environment when present. Generated Markdown can be piped to `open ... --stdin`. The launch result contains the owner key, document ID, and browser URL. Opening additional documents reuses this conversation's app. `--no-browser` suppresses the opener for headless use.

The agent must load the skill before opening: it explains request claims and replies and establishes the scope of document questions/revisions. A file cannot grant permission through its contents. Native tool approvals still apply.

Codex needs native `codex queue` support and its original session accessible to the local client. Claude needs its native Monitor tool: the agent runs `watch --owner KEY` in Monitor, then re-arms it after expiry only if the app is still running. Monitor has a 30-minute limit; re-arming consumes an agent turn. If Monitor is unavailable for the client's provider/settings, Claude live delivery is unavailable. The CLI does not create a replacement model conversation.

```sh
pnpm --dir /absolute/sidecar sidecar status --owner KEY
pnpm --dir /absolute/sidecar sidecar stop --owner KEY
```

Stop closes only Sidecar; the coding conversation remains alive. Closing a browser tab does not stop the app. A fresh open restores documents, titles, threads, and pending requests. A claimed request interrupted by a crash becomes uncertain: the agent must inspect the file before explicitly resuming. Identical replies and submission retries are deduplicated.

State defaults to `~/.local/state/sidecar/AGENT-UUID`; tests use `SIDECAR_STATE_DIR`. It includes a private agent credential, state, runtime record, and server log. Credentials never appear in the URL or command arguments. A localhost viewer cookie is separate from the agent credential. Treat other processes running as your OS user as trusted.

Only one process writes an owner's state. Dead owner locks are recovered without killing any PID. If a crash happens while creating or reclaiming a lock, startup fails closed; inspect `server.log` and verify no owner process is alive before removing an incomplete `owner.lock` or `reclaim.lock`. A reused live PID is never killed.

Broader styling, standalone HTML input, independent model sessions, and compaction cancellation are outside this version. The dated [acceptance record](docs/acceptance.md) covers both native agents and the remaining limits.

## Passage comments

Select text and click **Comment** or press **C** to open a floating composer beside the passage. The shortcut leaves typing and Ctrl/Cmd+C untouched. The highlight remains visible while you type. Clicking outside dismisses an empty composer; a composer with a draft stays open. **Send** (or Cmd/Ctrl+Enter) starts a thread with the original agent; **Cancel** or Escape discards the unsent comment. Select another passage at any time to start a separate comment; reselecting a passage restores its draft while this page stays open. Failed sends preserve the draft for retry. The question form below the document still supports general questions.

Saved passages remain highlighted after reload. Click a highlight, or focus it with Tab and press Enter, to reach its thread. When threads overlap, choose the question you want. Resolved threads retain a muted highlight and can be reopened. If a file edit makes a passage missing or ambiguous, its thread and quote remain, marked “Passage changed.”

The browser UI uses React and `@plannotator/web-highlighter`. Its small composer borrows Plannotator’s positioning approach; attribution is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The local server bundles the UI on page load with esbuild, so no separate frontend server or build command is required.

## Streaming replies

Both original agents can stream reply text while keeping their terminal session. Codex receives native text chunks from the existing app-server Unix socket (verified with CLI 0.159.3). Claude uses the skill's `MessageDisplay` hook (verified with 2.1.286), which supplies completed lines in batches; short replies can arrive all at once. Invoke the Claude skill through its native Skill tool; merely reading the Markdown does not register hooks. The hook does nothing when Sidecar is stopped and does not modify terminal text or global settings.

The agent runs `request ID --owner KEY --stream` once to claim the question, fetch its context, and prepare its reply stream. It then emits an assistant message between the returned `stream.prefix` and `stream.suffix` as its final response (after any document edits). If stream setup fails, the command still returns the claimed question and a `stream.error` for the complete-reply fallback; duplicate or completed claims do not start another stream. The separate `stream` command remains available for a request claimed without `--stream`. Native message completion with the closing marker automatically saves the reply. Only that marked message becomes a draft in that document thread. The markers are visible in the terminal but stripped from the viewer. Unmarked commentary, reasoning, and tool output are excluded.

The completed message saves the reply exactly once; `reply ... --stream` is an optional idempotent completion check. Missing chunks, incomplete markers, or a disconnected observer prevent streaming finalization; the existing plain-text stdin reply is the recovery path. A browser reload recovers the current draft. App restart discards transient drafts and leaves claimed requests uncertain for reconciliation. No new model session is launched. Codex streaming requires the original conversation to be loaded in its local daemon; unsupported configurations retain complete-message replies.

## Optional lifecycle hooks

The [Codex](hooks/codex.example.json) and [Claude](hooks/claude.example.json) examples forward native PreCompact/PostCompact events to an already-running app. Replace `/absolute/sidecar`; preserve `SIDECAR_STATE_DIR` if you use a custom directory. Merge the examples into the project's `.codex/hooks.json` or Claude's `.claude/settings.local.json` yourself; Sidecar does not change settings. Native hook trust and permissions still apply.

The page shows “Compacting context” between matching start/completion signals. A restart clears this transient status. Codex Interrupt records an interrupted turn; it is not evidence of compaction-specific cancellation. An unavailable app is a no-op. Hook support is distinct from live event delivery verification: see the acceptance record.

Schemas checked against the official [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) and [Claude hooks reference](https://code.claude.com/docs/en/hooks).

For browser checks, install the test browser once with `pnpm exec playwright install chromium`, then run `pnpm exec playwright test`.
