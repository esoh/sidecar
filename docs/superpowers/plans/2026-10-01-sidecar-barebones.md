# Barebones Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open an unstyled Markdown viewer from either an existing Codex or Claude conversation, exchange document-thread messages with that same conversation, and see requested edits refresh.

**Architecture:** One local Node process per owner holds a durable inbox and serves plain HTML/JavaScript. Codex receives short native queue notifications; Claude receives short Monitor notifications; both use the same local request/claim/reply commands. Files remain the document source of truth.

**Tech Stack:** TypeScript, Node standard library, pnpm, `markdown-it@15.0.2`, plain browser JavaScript, Node's test runner through `tsx`, and Playwright for browser behavior. Planning environment: Node 23.1.0 and pnpm 11.0.3; do not change global installations. Use Node 22-compatible APIs and types.

**Spec:** [Approved Sidecar design](../specs/2026-10-01-sidecar-design.md), approved by the user on 2026-10-01.

## Global Constraints

- Both Codex and Claude Code are required for the first usable version.
- The first build is deliberately barebones: unstyled HTML, browser-default controls, a rendered document, a question textarea, Send, thread messages, and Resolve/Reopen.
- The agent uses its existing context and tools. The viewer makes no independent model calls.
- Only the user resolves or reopens a thread. A reply arriving after resolution remains recorded without reopening it.
- Documents, messages, resolution state, titles, and pending requests survive refresh and app restart.
- Keep capability values out of process arguments.
- Work in an isolated Sidecar task worktree. Do not use another repository’s setup or dependencies. There is no worktree setup script in Sidecar.
- Use real originating conversations for acceptance. Success on one agent is not completion; neither a fake responder nor a new conversation substitutes for the other agent.
- No styling, UI framework, database, standalone HTML renderer, marketplace publication, terminal injection, or compaction-cancel button.

## Review Focus

1. A crash after an agent starts an edit must not cause that edit to be blindly repeated: Task 1 tests uncertain claims and duplicate replies.
2. Multiple documents and agents must not cross-route a reply, including forged IDs and a foreign web origin: Tasks 1 and 2 test these boundaries.
3. An atomic file replacement, a missing file, or repeated selected text must preserve threads without attaching them to the wrong passage: Tasks 2 and 4 test these inputs.
4. An event longer than Claude's observed limit or a dropped connection must retain the full request: Task 3 tests short notifications, fetching, replay, and deduplication.
5. A user resolving a thread or editing a title while a reply/file update is pending must retain that choice: Tasks 1 and 4 test these interleavings.

## File map and shared contract

| File | Responsibility |
| --- | --- |
| `src/store.ts` | Persistent owner/documents/threads/requests; atomic state transitions and exported data types |
| `src/documents.ts` | Registered-file reads, versions, safe Markdown rendering, automatic titles |
| `src/server.ts` | Loopback HTTP, capabilities, request validation, browser and agent event streams, shutdown |
| `src/agent.ts` | Codex notification dispatch and Claude event-stream client |
| `src/cli.ts` | Open/status/request/reply/watch/stop/hook commands and local process lifecycle |
| `web/index.html`, `web/app.js` | Native controls, selection capture, thread display, file updates |
| `.agents/skills/sidecar/SKILL.md` | Shared invocation and request-handling workflow for both agents |
| `.claude/skills/sidecar` | Symlink to the shared skill; never edit through this link |
| `test/*.test.ts`, `test/browser.spec.ts` | Focused state, HTTP, transport, and actual DOM checks |
| `README.md`, `docs/acceptance.md` | Usage and dated real-agent results |

Use these exported data types in `src/store.ts`: `Owner = { agent: 'codex' | 'claude'; sessionId: string }`; `Quote = { exact: string; prefix: string; suffix: string; start: number; end: number; version: string }`. Positions are UTF-16 offsets in the rendered document's `textContent`, not Markdown source offsets. Store documents by stable ID and canonical absolute path, threads by document ID, and requests by document/thread IDs. Request status is `queued | claimed | completed | failed | uncertain`. Each browser submission also carries a stable `clientMessageId` for retry deduplication.

State lives beneath `SIDECAR_STATE_DIR`, defaulting to `~/.local/state/sidecar`, in an owner directory named `<agent>-<native UUID>`. Validate the UUID; never use arbitrary input as a path. Tests always supply a temporary state directory. State directories are private, credentials are mode 0600, and one process owns each directory.

CLI contract (`pnpm sidecar` runs `node --import tsx src/cli.ts`):

- `open --agent codex|claude --session UUID --file PATH [--title TEXT]`, or `--stdin` instead of `--file` for generated Markdown; returns `{ ownerKey, documentId, url }` and opens the local page using a platform opener without a shell.
- `status --owner KEY` returns app/connection state, without credentials.
- `request ID --owner KEY` atomically claims and returns full context with `claimStatus: claimed|already-claimed|completed|uncertain`. An explicit `--resume` may reclaim an uncertain request after reconciliation.
- `reply ID --owner KEY --document ID --thread ID` reads reply text from stdin; `--error` records a failure instead.
- `watch --owner KEY` prints short NDJSON notifications for Claude; credentials are read from the owner directory.
- `stop --owner KEY` stops only that app and its transport work.
- `hook --agent codex|claude` reads native hook JSON from stdin, identifies the existing owner, and forwards a recognized lifecycle signal. A missing/stopped app is a successful no-op; hooks must not open one.

---

### Task 1: Durable documents, threads, and request state

**Files:** Create `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `src/store.ts`, `test/store.test.ts`; modify `.gitignore`.

**Interfaces:** Produce `createState(owner: Owner): State`, `openStore(directory: string, owner: Owner): Promise<Store>`, and `Store.read(): State (a detached snapshot)` / `Store.update<T>(change: (draft: State) => T): Promise<T>`. Export domain functions `registerDocument(state, {path, title, generated})`, `submit(state, {documentId, threadId?, text, quote?, clientMessageId})`, `claim(state, requestId, {resume?: boolean})`, `reply(state, {requestId, documentId, threadId, text, isError?})`, `resolveThread(state, threadId, isResolved)`, and `setTitle(state, documentId, title)`. Registration and submission return the stored document/request. Claim returns `{claimStatus, request}`; mutators return void unless specified. Export their input/result types with these exact property names.

- [ ] Add only the configuration this task needs: strict TypeScript, dev dependencies `typescript`, `tsx`, and `@types/node@22`; scripts `test` = `node --import tsx --test test/*.test.ts`, `typecheck` = `tsc --noEmit`, and `sidecar` as above. Ignore dependencies, local test output, and build output.
- [ ] Write failing state tests using temporary directories. Pin the central assertions:

  ```ts
  assert.equal(submit(state, input).id, submit(state, input).id);
  assert.equal(claim(state, request.id, {}).claimStatus, 'claimed');
  assert.equal(claim(state, request.id, {}).claimStatus, 'already-claimed');
  assert.throws(() => reply(state, { ...answer, documentId: otherDocument.id }));
  resolveThread(state, thread.id, true);
  reply(state, answer);
  reply(state, answer);
  assert.equal(state.threads[thread.id].isResolved, true);
  assert.equal(state.threads[thread.id].messages.filter(m => m.role === 'agent').length, 1);
  ```

  Fixtures register two documents in one owner. Add separate owner-isolation, title-override, concurrent update, and reopen tests: queued requests survive; claims from a terminated app reopen as uncertain; no automatic re-execution is authorized. A failed write must leave the previous in-memory and on-disk snapshot usable.
- [ ] Run `node --import tsx --test test/store.test.ts`; confirm failure is the missing state behavior.
- [ ] Implement the state transitions. Serialize updates, change a copy, write/rename a same-directory temporary file, then publish the new state. Fail visibly on malformed persisted state; never replace it with empty state. Preserve the last valid snapshot on failure. A duplicate identical reply is a no-op; a conflicting duplicate or conflicting reuse of a clientMessageId fails. Keep user title overrides separate from automatic titles.
- [ ] Run the focused tests and `pnpm typecheck`; require zero failures.
- [ ] Commit only this task's files: `feat: persist Sidecar documents and request lifecycle`.

### Task 2: Local document server and safe browser boundary

**Files:** Create `src/documents.ts`, `src/server.ts`, `test/server.test.ts`; modify `package.json`, `pnpm-lock.yaml`.

**Interfaces:** Consume Task 1. Produce `readDocument(path: string): Promise<{markdown: string; html: string; version: string; heading: string | null}>`, using a content hash for `version`; and `startServer({owner, directory, port?: number, pollMs?: number}): Promise<{url: string; close(): Promise<void>}>`. Default port is OS-assigned; registered-file polling defaults to 1000 ms. Export `startServer` for temporary test instances.

- [ ] Add `markdown-it@15.0.2`. Write failing HTTP tests for a native-client registration and a browser submission/claim/reply round trip. Assert a foreign Origin, wrong capability, arbitrary file path, crossed owner, and crossed thread cannot access or mutate state. Verify missing documents are reported without deleting threads.
- [ ] Run `node --import tsx --test test/server.test.ts`; confirm expected failures.
- [ ] Implement only explicit routes: viewer state/document reads, question submission, resolution, title changes, and `/events`; agent document registration, request claim, reply, status, `/agent/events`, lifecycle signal, and stop. No generic filesystem or shell endpoint. Limit JSON bodies to 256 KiB and return clear 400/413 errors for invalid input. Agent routes require a secret from a private file; browser routes use a distinct HttpOnly, SameSite=Strict viewer cookie issued by the landing page. Check the exact bound Host and browser mutation Origin; disable CORS. The launch URL contains no capability, keeping secrets out of opener arguments. Protect the page against framing and use a self-only script policy.
  Route contract: viewer `GET /api/state`, `GET /api/documents/:id`, `POST /api/questions`, `POST /api/threads/:id/resolution`, `PATCH /api/documents/:id/title`, and SSE `GET /api/events`. Agent `POST /agent/documents`, `POST /agent/requests/:id/claim`, `POST /agent/replies`, `GET /agent/status`, NDJSON `GET /agent/events`, `POST /agent/lifecycle`, and `POST /agent/stop`. Viewer bodies use the matching Task 1 input shapes; resolution uses `{isResolved}` and title uses `{title}`. `/api/events` sends a `change` notification prompting a fresh snapshot. `/api/state` includes documents, threads, requests, and transient `activity: unknown|responding|compacting`, but no credentials. The claim response adds the current document `{id, path, version, markdown}` and thread history to the Task 1 claim result; the captured quote/version stays available separately.

  Pin HTTP test assertions including `assert.equal(foreignOrigin.status, 403)`, `assert.equal(wrongCapability.status, 403)`, `assert.equal(crossedReply.status, 409)`, and `assert.notEqual(afterReplace.version, beforeReplace.version)`. Validation errors use 400, ownership conflicts use 409, and missing registered documents use 404.

- [ ] Render with `html: false`, no Markdown plugins, and permitted link/image schemes restricted to HTTP(S), mailto links, and relative references. Escape document-supplied HTML; show thread text through `textContent`. Serve only registered documents and explicitly named assets. Poll registered files so atomic replacement is detected; report read errors without overwriting the last good registration. Resolve titles in order: user override, agent-supplied title, current first heading, filename.
- [ ] Add regression assertions that raw script/event-handler markup and `javascript:`/`data:` links cannot execute, an atomically replaced file gets a new version, and two files plus independent user title overrides survive a server restart. Run server/state tests and `pnpm typecheck`.
- [ ] Commit: `feat: serve registered Markdown and protected Sidecar APIs`.

### Task 3: Both original-agent connections and app lifecycle

**Files:** Create `src/agent.ts`, `src/cli.ts`, `test/agent.test.ts`, `.agents/skills/sidecar/SKILL.md`, `.claude/skills/sidecar` symlink, and `README.md`; modify `src/server.ts`.

**Interfaces:** Consume `startServer` and the shared state contract. Export `notifyCodex(owner: Owner, requestId: string): Promise<void>` and `watchClaude(ownerKey: string, signal: AbortSignal): Promise<void>`. Implement the CLI contract above, excluding `hook` until Task 5. Tests can put a fake executable named `codex` on a temporary PATH to capture arguments; that proves wiring only.

- [ ] Write failing transport tests. A 10,000-character comment must produce a notification shorter than 300 characters while the full claim result retains the entire comment. Verify the exact native UUID is passed to `codex queue`, shell syntax in text is not executed, and a stream reconnect re-announces an unacknowledged request without duplicating its stored messages. A repeated claim cannot authorize a second edit.
  Pin the notification assertions:

  ```ts
  assert.ok(Buffer.byteLength(notification) < 300);
  assert.equal(full.request.text.length, 10_000);
  assert.deepEqual(capturedArgs, ['queue', '--thread', owner.sessionId, '--message', notification]);
  ```

- [ ] Run `node --import tsx --test test/agent.test.ts`; confirm expected failures.
- [ ] Implement a single active request per owner, with other requests durable and queued. Notify the oldest eligible request. Codex uses `execFile`/`spawn` with an argument array and `shell: false`; never resume or create a replacement agent. Record queue acceptance separately from agent claim/reply. Do not repeatedly enqueue a notification merely because its agent is busy. On reconnect/restart, re-announcement is safe because the persisted claim/completion state controls execution. An uncertain edit needs inspection of the current file before `--resume`.
- [ ] Implement Claude's short NDJSON stream and full-context fetch. The shared skill checks the native ID, establishes the requested document-work scope, starts Monitor, handles replies sequentially, and checks `status` before re-arming after expiry. On a disconnected stream, retain pending requests; never equate a stream write with acknowledgement. Detect unsupported Monitor use and show a connection error. Use “waiting for agent” where liveness is unknown; report disconnected only when there is evidence.
- [ ] Implement `open`/`stop`: one app per owner, reused by additional documents, with a private runtime record and exclusive ownership lock. A simultaneous open must not create two writers. A stale record is reconciled without killing an unrelated PID. Generated input is written to a managed backing file. Stop aborts transports, closes sockets, and leaves the original conversation alive. A fresh open restores state. Infer session IDs only from the selected agent's native environment and reject conflicting explicit IDs.
- [ ] Document invocation from another repository using an absolute Sidecar path. Keep the skill canonical under `.agents/skills`; create the relative Claude symlink. Do not install globally or change existing agent settings. Explain normal permissions, the 30-minute Monitor limit, and explicit app shutdown in the README.
- [ ] Run transport/state/server tests and typecheck. Add lifecycle tests for simultaneous open, stop/reopen, an unavailable native queue, and no credentials in spawned command arguments. Commit: `feat: connect Sidecar to existing Codex and Claude sessions`.

### Task 4: Unstyled page and real browser interaction

**Files:** Create `web/index.html`, `web/app.js`, `test/browser.spec.ts`, `playwright.config.ts`; modify `src/server.ts`, `package.json`, `pnpm-lock.yaml`, and `tsconfig.json`.

**Interfaces:** Consume the protected viewer routes and events. Export pure `locateQuote(text: string, quote: Quote): {start: number; end: number} | null` from `web/app.js` using JSDoc types. Browser initialization runs only when `document` exists, allowing the locator to be tested directly. Keep browser code typechecked through `allowJs`/`checkJs`.

- [ ] Add Playwright as a development dependency. Write failing browser tests for a general question and selection spanning inline formatting/code; include emoji, repeated text, an empty selection, and a selection outside the document. Tests start their own temporary app and use a fake agent through agent HTTP routes, not by modifying browser state.
- [ ] Run `pnpm exec playwright test`; confirm the missing interface fails.
- [ ] Implement only semantic HTML and native controls: document links, editable title, document content, selected quote preview with Clear selection, labelled question textarea, Send, plain thread messages, follow-up textareas, and Resolve/Reopen. Capture document selection before the textarea takes focus. Use document `textContent` consistently for positions and surrounding text. Reattach only a unique contextual match; otherwise preserve the original quote with “Passage changed.”
- [ ] Subscribe to updates and refresh the document/thread content without erasing an unfinished textarea or moving keyboard focus. Update `document.title` for the selected document. A late reply must not reopen a resolved thread. Include a plain status message for queued work, failures, missing files, and lost connections.
- [ ] Verify the browser assertions below, plus refresh/restart recovery, native keyboard operation, an atomic file rewrite, title precedence, and two documents sharing one owner:

  ```ts
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await expect(page.getByText('Passage changed.', { exact: true })).toBeVisible();
  await expect(page).toHaveTitle('My review title');
  await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
  ```

- [ ] Run `pnpm test`, `pnpm typecheck`, and `pnpm exec playwright test`; require all green. Commit: `feat: add barebones document conversations in the browser`.

### Task 5: Compaction signals and both-agent acceptance

**Files:** Modify `src/cli.ts`, `src/server.ts`, `web/app.js`, `.agents/skills/sidecar/SKILL.md`, `README.md`, and `docs/superpowers/specs/2026-10-01-sidecar-design.md`; create `test/hooks.test.ts`, `docs/acceptance.md`, `hooks/codex.example.json`, and `hooks/claude.example.json`.

**Interfaces:** Implement the `hook` CLI command. Accept native `PreCompact` and `PostCompact` payloads for the matching session. Forward `{ownerKey, event: 'compaction-started' | 'compaction-completed' | 'interrupted', turnId?: string}` to the agent-authenticated lifecycle route. A Codex `Interrupt` is an interrupted turn, not proof of compaction-specific cancellation.

- [ ] Write failing hook tests: matching start/completion update the state; another session cannot; missing/stopped apps are no-ops; no signal labels an unverified cancellation. A restart clears stale transient “compacting” status rather than pretending compaction is still running.
- [ ] Run `node --import tsx --test test/hooks.test.ts`, implement parsing and forwarding, show “Compacting context” for the transient activity value, and rerun the test. Assert `afterStart.activity === "compacting"`, `afterCompletion.activity === "unknown"`, and that a foreign session leaves activity unchanged. Provide scoped configuration examples for both clients; do not overwrite the user's global hooks. Until native hook delivery is observed, label the integration unverified in the acceptance record. Exercise real compaction only in disposable test conversations, never in the user's existing conversation without explicit permission.
- [ ] Run the complete local gates: `pnpm test`, `pnpm typecheck`, `pnpm exec playwright test`, and `git diff --check`. Record real outputs; fix failures before acceptance.
- [ ] Perform the same browser walkthrough with an existing **Codex** conversation and an existing **Claude** conversation. Each agent registers two documents. Ask a context-recall question whose answer appeared earlier in that conversation but is absent from the request; verify the answer lands in the right thread. Test a general question, selected-text question, follow-up, authorized file revision, resolve/reopen, and independent title editing. Confirm the browser stays open and the backing file is updated.
- [ ] For **each agent**, submit during idle and while busy, use its terminal normally between requests, stop/reopen Sidecar, and verify pending questions are retained and not executed twice. Verify Claude expiry/re-arm with a short timeout. Record any native permission wait encountered during these checks without approving it automatically. For owner-session resume, use disposable sessions and verify reconnection preserves the exact native ID. Do not use pane focus to find a target.
- [ ] Record versions, conversation IDs used for tests, results, known limits, and cleanup in `docs/acceptance.md`, with separate Codex and Claude columns. Mark both-agent acceptance incomplete if either agent lacks any core walkthrough result. Mark compaction separately if a supported signal cannot be verified; never substitute inferred cancellation. Stop test servers/watchers and leave user conversations intact.
- [ ] Add `As built` notes and links to the approved spec, documenting actual behavior without rewriting its historical requirements. Commit: `feat: expose lifecycle status and verify both agent workflows`.

## Handoff

Recommended execution: **Native** in this session. The five tasks share a small state/protocol surface; implementing them in order avoids parallel coordination overhead. The alternative is subagent-driven implementation with per-task review. Choose the execution method after reviewing this plan; no product code or dependency installation occurs during planning.

Dependency references checked while planning: [markdown-it options](https://markdown-it.github.io/markdown-it/interfaces/MarkdownItOptions.html), [markdown-it package and bundled types](https://github.com/markdown-it/markdown-it/blob/master/package.json), [tsx Node integration](https://tsx.is/node-enhancement), [Node test runner](https://nodejs.org/api/test.html).
