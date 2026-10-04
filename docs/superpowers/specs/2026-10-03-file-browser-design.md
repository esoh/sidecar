# File browser and preview

As built on 2026-10-03 after user exploration: file previews now open in draggable,
resizable windows over the document, sharing the existing pinned-message dock.
This supersedes the main-pane replacement and separate code-popout behavior below.
Files use the same minimize, dock, close, tab reorder and single/multiple-window
controls. Reopening a path reloads and focuses its existing window or dock tab.
The main document and conversation remain usable; file previews are read-only.
JSON/JSONC/JSON5 and YAML/YML render as literal highlighted source, as do code
links. Source language detection reuses `guideLanguageForPath` from Plannotator.
HTML retains its empty sandbox, and relative images remain disabled. Browser
window state is transient; file browsing does not register documents or call agents.

User-approved follow-up on 2026-10-03: text selections in file windows and dock tabs
attach a `fileQuote` to the current conversation's next input, following message
quoting. A selection from the thread list creates a conversation. Quotes retain
the absolute source path, exact excerpt and source-code line numbers through draft
reload, queueing and single/batched delivery to either coding agent. Sent quotes
reopen their source file. This does not turn external-file quotes into main-document
highlights or archive browsed files. Sandboxed HTML and diagram graphics retain
their existing isolation.

User-approved scope, 2026-10-03:

- Add a Files panel that lists the open document's workspace and previews files read-only. Reuse Plannotator's file browser rather than designing a new one.
- The default root is the worktree the agent is actually working in. The agent declares it; Sidecar does not guess from branch names.
- Browsing and previewing never register a document, create a thread, or send anything to the agent. Opening a browsed file for conversation is a possible follow-up, not part of this change.
- List and render whatever file types Plannotator's file browser handles today. Live tree watching is out of scope; the panel's refresh button re-fetches.

## Source

Plannotator is dual-licensed MIT/Apache-2.0; Sidecar uses the MIT terms already recorded in `THIRD_PARTY_NOTICES.md`.

- Import, do not copy, the browser pieces from the installed `@plannotator/ui` 0.47.0: `components/sidebar/FileBrowser.tsx` and `hooks/useFileBrowser.ts`. `setFileTreeBackend` replaces Plannotator's HTTP endpoints with Sidecar's.
- Import the file-type predicates (`ANNOTATABLE_DOC_REGEX`, `isAnnotatableDocPath`, `diagramRenderKindForPath`, and `MAX_ANNOTATABLE_FILE_BYTES` in `annotatable.ts`) from `@plannotator/core` 0.25.7, the version `@plannotator/ui` 0.47.0 already depends on. Add it as a direct, exactly pinned dependency.
- Port the server pieces from Plannotator `main` at `772c620302f584654c3d8e17bbffb2c6255d3331` from Bun to Node: `handleFileBrowserFiles` and its walk/cap in `packages/server/reference-handlers.ts`, `FILE_BROWSER_EXCLUDED` and `buildFileTree` in `packages/shared/reference-common.ts`, and the git status in `packages/shared/workspace-status.ts`. Keep their behavior: user-modified and untracked files are seeded before the bulk walk, the cap defaults to 5,000 files, and the response reports truncation.
- Do not upgrade `@plannotator/ui` or vendor its 0.49 source; the existing renderer stays on 0.47.0.

## Workspace root

- `sidecar open` accepts an optional `--workspace PATH`. Without it, the root is the Git top-level of the command's working directory; outside Git, the document has no workspace.
- The CLI resolves the root with `realpath` and sends it with the document. The server verifies it is an absolute, existing directory and stores it on the document record as optional `workspace`. State stays at version 3; older documents simply lack the field.
- `repoInfo` is computed from the workspace rather than the working directory, so the repository/branch badge always describes the browsed root.
- Re-running `open` for an already registered file updates its `workspace`, exactly as it already updates `repoInfo`. No new command.
- The skill tells the agent to pass the worktree it is working in, especially when its own session started in a main checkout.
- A document without a workspace hides the Files toggle.

## Server

Both routes require the existing viewer cookie and Host/Origin checks. The client never supplies a directory: the root always comes from the document record.

- `GET /api/files?document=ID` returns `{ root, tree, workspaceStatus, truncated, fileLimit }` using Plannotator's tree shape. Excluded directories, the type filter (including its `.env` exclusion), and the cap match Plannotator.
- `GET /api/files/content?document=ID&path=RELATIVE` returns `{ path, text, renderAs }`. The resolved real path must stay inside the real workspace root; `..` and symlink escapes return 403. Paths that fail the type filter return 415. Files over Plannotator's 2 MiB limit return 413. Content is read as UTF-8.
- Git status runs with `execFile` (no shell) and a timeout. A missing or failing Git reports an unavailable status and still returns the tree, as Plannotator does.

## Viewer

- A collapsible left Files panel, toggled from the top bar and resized with Plannotator's `ResizeHandle`. Its width and open state are saved in this browser. It starts closed.
- The panel renders `FileBrowser` with search, change badges, and line counts. Vault, annotation counts, and edit statuses are not used.
- Selecting a file replaces the main pane with a read-only preview, following the existing **View original document** pattern: a banner reading "Previewing `path`" with **Back to document**. Selecting the open document's own file returns to the document.
- Rendering follows Plannotator's rules for the path: Markdown, plain text, and data/config files through `MarkdownDocument`; Mermaid and Graphviz sources as diagrams; HTML in an `srcdoc` iframe with an empty `sandbox` (opaque origin, no scripts): Sidecar's page CSP is inherited by `srcdoc` and would block inline scripts anyway, so the preview is static.
- During a preview, passage selection and commenting are disabled. The conversation pane, its drafts, pins, and windows stay attached to the current document.

## Verification

- Backend tests: containment (`..`, absolute paths, symlink escape), type filter, `.env` exclusion, excluded directories, cap and truncation, missing workspace, documents without `workspace`, and Git status against a temporary repository including an untracked file beyond the cap's walk order.
- CLI test: `--workspace` and the Git top-level default are recorded, and `repoInfo` follows the workspace.
- Playwright: the toggle is hidden without a workspace; the tree is rooted at the workspace; a Markdown preview renders and Back restores the document with a saved draft intact; HTML renders inside the sandboxed iframe; commenting is unavailable during preview.
- `pnpm test`, `pnpm typecheck`, and the full Playwright suite pass. `THIRD_PARTY_NOTICES.md` names each ported file and revision; the README documents the panel and `--workspace`.

As built on 2026-10-03: server listing and preview live in `src/files.ts` with Plannotator's Git status copied unchanged into `src/workspace-status.ts`. The file-type predicates are copied from `@plannotator/core` 0.25.7 rather than imported at runtime, because Playwright's loader will not compile TypeScript inside `node_modules`; the package remains a dependency for type imports. The viewer imports `FileBrowser`/`useFileBrowser` from `@plannotator/ui` 0.47.0 through `setFileTreeBackend`; its labels hide `.md`/`.html` extensions as upstream does. HTML previews use an empty sandbox. Relative images in previews are intentionally not resolved.

## Local file links

### As built: navigation and numbered code (2026-10-03)

The user subsequently approved root navigation and opening explicitly chosen local folders/files outside the workspace. This supersedes the fixed-root/refusal behavior below. The existing Plannotator file tree now lists code as well as documents, behind a small left-edge tab below the app bar. Up changes the visible root; the path is editable; Reset visible root restores the document's workspace. None of these changes alter the registered workspace, repository badge, agent cwd, or document ownership.

Show in file browser (the file-window path button) opens the panel, clears its filter, expands ancestors, scrolls to and highlights the file. For files outside the current visible root it switches to the containing folder. Open windows retain their file's root, so navigating cannot silently retarget their source. The same path focuses the same window across different visible roots.

Authenticated `POST /api/files/root` grants an explicitly selected real directory to the current document for the server's lifetime. File reads may use a `directory` parameter only if it is the document workspace or a granted root. Passive hover previews stay workspace-scoped. Closing the document clears grants. Containment/symlink checks apply within each selected root, along with existing type exclusions and the 2 MiB limit. Directory walking is also capped to bound parent-folder browsing. A file quote may reference the user's chosen local file; it is context, not read/edit authorization.

Code, JSON and YAML use the same Pierre `File` component as Plannotator's code popout, inside Sidecar's windows/dock. Gutter selections attach whole lines; text selections preserve exact source substrings and newlines while excluding line numbers. Rendered Markdown/diagrams/HTML retain their existing paths.

User-approved addition, 2026-10-03: links to local files in documents, previews, replies and pinned windows open inside Sidecar instead of navigating the viewer to `/Users/...`.

- Plannotator's renderer classifies the links; Sidecar wires its `onOpenLinkedDoc` and `onOpenCodeFile` callbacks. The read-only library keeps plain links.
- Absolute paths and `file://` URLs resolve as given. Relative document links resolve from the linking file's folder (replies from the workspace root); code paths resolve from the workspace root unless they start with `./` or `../`.
- Document links open the existing read-only preview. Code links open Plannotator's `CodeFilePopout` without comment controls; it does not scroll to a `:line` suffix. Hovering a `path:line` reference uses the same code route.
- `GET /api/files/code?document=ID&path=RELATIVE[:line]` applies the preview route's containment, exclusions and 2 MiB limit with Plannotator's code-file types, returning `{ codeFile: true, filepath, contents }`.
- A link outside the workspace, or any link in a document without a workspace, shows the refusal and **Copy path** in the preview pane; nothing outside the root is read.
