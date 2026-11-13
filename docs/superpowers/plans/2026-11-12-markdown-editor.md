# Markdown Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Sean switch a registered Markdown document into an in-place live-preview editor, save safely, handle agent edits, and select source text to ask about or request changes.

**Architecture:** One new server route writes the file through the existing proposal write helpers under the per-document lock. The browser swaps the reading article for Plannotator's `MarkdownEditor`, with a few CodeMirror extensions for view access, external replacements, selection capture and line highlights. Edit-mode selections are sent as the existing `FileQuote` type; view-mode `Quote`s are untouched.

**Tech Stack:** TypeScript, Node `node:test`, React 19, `@plannotator/ui@0.47.0` `MarkdownEditor`, CodeMirror 6 (`@codemirror/state@6.7.6`, `@codemirror/view@6.43.13`), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-markdown-editor-design.md`

## Global Constraints

- Registered Markdown documents only. Not HTML documents, not linked file windows, not code files.
- Edit is disabled for any document whose source contains `\r`.
- The editor must never change bytes the user did not touch.
- Save never overwrites a file whose version is not `baseVersion`, except through the explicit **Save anyway** action.
- A version (`versions/<documentId>/<sha256>.md`) is written on save (before and after), never per keystroke.
- No new dependencies except `@codemirror/state@6.7.6` and `@codemirror/view@6.43.13` as direct dependencies at exactly the lockfile versions. Exactly one copy of each may be bundled.
- Import the editor from `@plannotator/ui/components/MarkdownEditor` only (not `@plannotator/atomic-editor` or `@plannotator/markdown-editor` directly).
- View mode behavior and view-mode `Quote` anchoring stay unchanged.
- Copy: header controls **Edit**, **Save**, **Done**, dirty marker "● Unsaved"; banner "This file changed on disk." with **Reload**, **Keep mine**, and on save conflict also **Save anyway**; composer button "Save & send" while dirty; proposal guard "Save or discard your edits first"; leave prompt choices **Save**, **Discard**, **Cancel**.
- Work happens on a branch in a worktree under `/Users/seanoh/ws/pg/sidecar/.claude/worktrees/`; agent processes start from the main checkout.

## Review Focus

1. **An agent writes the file during a save.** A save racing an agent write must end in either the agent's text or the user's text on disk, never a mix, and a 409 rather than a silent overwrite. (Task 1: `publishFileWrite` re-check test with the file changed between prepare and publish.)
2. **Undo after an agent update.** Pressing ⌘Z after a clean external update must not bring back the pre-agent text. (Task 3 browser test.)
3. **Leaving with unsaved edits by any path.** Switching document, closing the document, or reloading the tab must prompt; edits must not vanish. (Task 2 browser test covers document switch and `beforeunload`.)
4. **Huge or multi-byte documents.** A >256 KiB document with non-ASCII text saves byte-exactly. (Task 1 test.)
5. **Selection quote after the text moved.** An edit-mode quote whose text now sits on different lines is still found and painted, and one whose text is gone shows "Selection changed". (Task 4 unit test for `locateFileQuote`.)

---

### Task 1: Save route

**Files:**
- Create: `src/document-save.ts`
- Modify: `src/proposal-writes.ts` (`publishFileWrite` conflict message parameter)
- Modify: `src/viewer-http.ts:18-26` (`bodyOf` limit parameter)
- Modify: `src/server.ts` (body limit at ~819; new route next to `/api/documents/:id/versions/:hash` at ~766)
- Test: `test/document-save.test.ts`

**Interfaces:**
- Consumes: `readSourceFile`, `isHtmlPath` (`src/documents.ts`); `prepareFileWrite`, `publishFileWrite`, `discardFileWrite` (`src/proposal-writes.ts`); `saveDocumentVersion` (`src/snapshots.ts`); `proposalService.withDocument`; `refresh(document)` in `src/server.ts`.
- Produces:
  - `bodyOf(request: IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>>`. The 413 message reports the limit actually used.
  - `publishFileWrite(write: PreparedFileWrite, conflictMessage = 'The document changed before this proposal could be applied. Review it again.'): void`
  - `saveDocumentSource(input: { directory: string; documentId: string; path: string; markdown: string; baseVersion: string }): Promise<{ version: string; isUnchanged: boolean }>` in `src/document-save.ts`. Throws `DomainError(…, 409)` on version mismatch, and `DomainError(…, 400)` for HTML paths or `\r` in either the source or the new text.
  - HTTP: `POST /api/documents/:id/source`, body `{ markdown: string, baseVersion: string }` (64 hex), response `{ version: string }`. 409 body is the standard error JSON. Body limit is 16 MiB for this path only.

- [ ] **Step 1: Write failing tests** in `test/document-save.test.ts` using `fixture` from `test/support.ts`:
  - `save writes the file, records before and after versions, and returns the new version`: register `a.md` with `'# A\n'` and read its version via `GET /api/documents/:id`. POST `{ markdown: '# B\n', baseVersion }`. Expect 200, the file equals `'# B\n'`, and both `versions/<id>/<before>.md` and `versions/<id>/<after>.md` exist under `f.directory`. The returned `version` equals the sha256 of `'# B\n'`.
  - `save with a stale baseVersion is a 409 and leaves the agent text`: write `'# Agent\n'` to the file directly, then POST with the old `baseVersion`. Expect 409 and the file still `'# Agent\n'`.
  - `unchanged save writes nothing`: POST the identical text. Expect 200 with the same version and an unchanged mtime.
  - `save refuses HTML documents and text with carriage returns`: a registered `.html` gives 400. A source containing `'\r\n'` gives 400. New text containing `'\r'` gives 400. Files unchanged.
  - `save accepts a large multi-byte document byte-exactly`: 300 KiB of `'é漢\n'` repeated. Expect 200 and `readFile` equals the sent text.
  - `save after a pending proposal's target is edited away marks it outdated`: reuse the `propose` helper pattern from `test/server.test.ts`, save text without the proposal's `before`, then poll `/api/state` until `proposals[id].status === 'outdated'`.
  - `publish re-check refuses when the file changes between prepare and publish`: unit-level against `prepareFileWrite`/`publishFileWrite` with a custom `conflictMessage`. Expect the thrown message equals it and the file holds the external text.
- [ ] **Step 2: Run, expect failures.** `node --import tsx --test test/document-save.test.ts` fails (404 route / missing module).
- [ ] **Step 3: Implement** `bodyOf` limit, the `publishFileWrite` message parameter, `saveDocumentSource`, and the route. Route: `get(store.read().documents, id)` (404 for unknown or other-owner), validate the body, `proposalService.withDocument(id, () => saveDocumentSource(...))`, then outside the lock `await refresh(document)` so `changed()` and `revalidate` run. In `saveDocumentSource`, use the accepted-proposal order: `saveDocumentVersion(before)`, `prepareFileWrite`, `saveDocumentVersion(after)`, `publishFileWrite(write, 'The document changed on disk. Review it again.')`, and `discardFileWrite` in `finally`. No `proposalWrites` record.
- [ ] **Step 4: Run** `node --import tsx --test test/document-save.test.ts test/server.test.ts test/proposal-writes.test.ts test/viewer-http.test.ts`. Expect all PASS.
- [ ] **Step 5: Commit** `feat: add document source save route`.

### Task 2: Edit mode shell

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (`pnpm add @codemirror/state@6.7.6 @codemirror/view@6.43.13`)
- Create: `web/MarkdownEditMode.tsx` (editor, header controls, dirty state, leave dialog)
- Create: `web/editor-view.ts` (CodeMirror helpers)
- Modify: `web/MarkdownDocument.tsx:121-150` (expose `startLine`)
- Modify: `web/api.ts` (save call)
- Modify: `web/app.tsx` (~1299-1300 article render, header Edit button, document switch/close guards)
- Test: `test/browser.spec.ts`

**Interfaces:**
- Consumes: Task 1 route.
- Produces:
  - `saveSource(documentId: string, markdown: string, baseVersion: string): Promise<{ version: string }>` in `web/api.ts`. On 409 it throws an `Error` with `status === 409`.
  - `web/editor-view.ts`: `viewCapture(ref: { current: EditorView | null }): Extension`; `topVisibleLine(view: EditorView): number`; `scrollToLine(view: EditorView, line: number): void`.
  - `MarkdownDocument` renders each top-level block inside `<span data-source-line={block.startLine} style={{ display: 'contents' }}>`. Readers use the wrapper's `firstElementChild` rect.
  - `export type EditModeHandle = { isDirty(): boolean; save(): Promise<boolean>; requestExit(): Promise<boolean>; revealLines(start: number, end: number): void }`, exported from `web/MarkdownEditMode.tsx`.
  - `<MarkdownEditMode documentId path markdown version startLine handleRef onExit(line: number) onError />`. `requestExit` resolves `true` when it left (clean, or Save/Discard chosen) and `false` on Cancel.

- [ ] **Step 1: Install deps** and verify one copy: `pnpm add @codemirror/state@6.7.6 @codemirror/view@6.43.13`, then `pnpm why @codemirror/state` shows only 6.7.6.
- [ ] **Step 2: Write failing browser tests** in `test/browser.spec.ts`:
  - `edit mode saves typed text, keeps undo across save, and Done returns to the reading view`: register a doc, click **Edit**, type at the end of line 1, and expect "● Unsaved". Press `Meta+s`, then expect the file contains the typed text and "● Unsaved" is gone. Press `Meta+z` and expect the text reverts in the editor. **Done** asks; choose **Discard**, and expect the article shows the saved text.
  - `edit is unavailable for HTML documents and documents with carriage returns`: no enabled **Edit** button in either case.
  - `unsaved edits prompt before switching documents and on unload`: with two registered docs, make an edit, select the other document, and expect the leave dialog. **Cancel** keeps the editor text. Separately, `page.on('dialog')` sees a `beforeunload` dialog on `page.reload()` while dirty.
  - `entering edit mode opens near the reading position and Done returns near the editor position`: a long doc with 40 headings. Scroll the article to heading 30, click **Edit**, and expect the editor's top visible line within 3 lines of heading 30's source line. Scroll the editor to heading 10, click **Done**, and expect heading 10 in the viewport.
  - `phone width shows the same single editor pane`: viewport 390×844, **Edit** shows the editor and no second pane.
- [ ] **Step 3: Run, expect failures.** `pnpm exec playwright test test/browser.spec.ts -g "edit"` fails.
- [ ] **Step 4: Implement.**
  - **Edit button:** shown in the document header for registered non-HTML documents. Disabled with a title explaining line endings when `content.markdown.includes('\r')`.
  - **Editor:** `MarkdownEditMode` mounts `MarkdownEditor` in a height-bounded container in the article's place. `documentId` is `${documentId}:${mountKey}`; Task 3 bumps `mountKey` on Reload. Pass extensions from a `useMemo` keyed on the mount id, including `viewCapture`.
  - **Dirty state:** text differs from the last-synced text.
  - **Save:** ⌘S / Ctrl+S via a `Prec.high` keymap, plus the button.
  - **Leaving:** the leave dialog is a native `<dialog>`. `beforeunload` is registered only while dirty. The document switch and close paths in `app.tsx` await `handle.requestExit()` first.
  - **Position on enter:** the first `[data-source-line]` wrapper whose child's rect top is ≥ the article's top, giving `startLine`.
  - **Position on exit:** `onExit(topVisibleLine(view))` scrolls the article to the last wrapper with `data-source-line` ≤ that line.
- [ ] **Step 5: Run** the Step 2 tests plus `pnpm run typecheck`. Expect PASS.
- [ ] **Step 6: Commit** `feat: add in-place markdown edit mode`.

### Task 3: External changes and conflicts

**Files:**
- Modify: `web/editor-view.ts`, `web/MarkdownEditMode.tsx`
- Test: `test/editor-view.test.ts` (pure helper), `test/browser.spec.ts`

**Interfaces:**
- Consumes: Task 2 handle, `saveSource`, `viewCapture`.
- Produces:
  - `minimalChange(from: string, to: string): { from: number; to: number; insert: string } | null` in `web/editor-view.ts`. It trims the common prefix and suffix, and returns `null` when the strings are equal.
  - `applyExternalText(view: EditorView, text: string): void` dispatches `minimalChange` with `Transaction.addToHistory.of(false)`.
  - `MarkdownEditMode` takes new props `diskMarkdown: string; diskVersion: string`, the live `content` from `app.tsx`.

- [ ] **Step 1: Write failing tests.**
  - Unit, in `test/editor-view.test.ts`: `minimal change trims shared prefix and suffix` (`('abcXdef','abcYYdef')` → `{from:3,to:4,insert:'YY'}`), `equal text yields null`, and `pure insert and pure delete`.
  - Browser:
    - `agent edit flows into a clean editor and undo cannot revert it`: edit and save "mine", write agent text to the file, and expect the editor shows the agent text with no banner. Press `Meta+z` repeatedly, and expect the agent text is never removed from the editor.
    - `agent edit while dirty shows the banner; Reload loads it and clears undo`: expect "This file changed on disk.". Click **Reload**, and expect the editor shows the agent text and `Meta+z` leaves it unchanged.
    - `Keep mine then save conflicts; Save anyway overwrites`: **Keep mine**, then `Meta+s`, then expect the banner with **Save anyway**. Click it, and expect the file holds the user's text.
- [ ] **Step 2: Run, expect failures.** `node --import tsx --test test/editor-view.test.ts`; `pnpm exec playwright test test/browser.spec.ts -g "agent edit|Keep mine"`.
- [ ] **Step 3: Implement.** Keep `baseVersion` and `syncedText` refs.
  - **When `diskVersion` ≠ `baseVersion`:** if clean, `applyExternalText` and update both refs. If dirty, show the banner.
  - **Reload:** bump `mountKey` with `diskMarkdown` and set `baseVersion = diskVersion`.
  - **Keep mine:** hide the banner.
  - **Save 409:** show the banner with **Save anyway**, which calls `saveSource` with `baseVersion = diskVersion`.
  - **File unreadable** (the document error from `app.tsx`): show an error banner and keep the edits.
- [ ] **Step 4: Run** Step 2 commands. Expect PASS.
- [ ] **Step 5: Commit** `feat: handle agent edits while editing markdown`.

### Task 4: Edit-mode selections and highlights

**Files:**
- Create: `web/edit-quotes.ts`
- Modify: `web/editor-view.ts` (selection capture, line marks), `web/MarkdownEditMode.tsx`, `web/app.tsx` (`htmlPending` reuse, `fileQuoteIssue` ~1020, `onOpenFileQuote` ~1055), `web/conversations.tsx` (composer ~130-228)
- Test: `test/edit-quotes.test.ts`, `test/browser.spec.ts`

**Interfaces:**
- Consumes: `FileQuote` (`src/quote.ts`); the `htmlPending` state, toolbar and `attachToConversation` in `app.tsx`; Task 2 handle.
- Produces:
  - `locateFileQuote(source: string, quote: FileQuote): { from: number; to: number } | null` in `web/edit-quotes.ts`. It returns the occurrence of `quote.exact` whose start line is closest to `quote.startLine` (ties go to the earlier one), or `null` when absent.
  - `selectionQuote(view: EditorView, path: string): { quote: FileQuote; rect: DOMRect } | null` in `web/editor-view.ts`. `kind: 'doc'`, 1-based `startLine`/`endLine`, and `rect` from `coordsAtPos` of both ends. Returns `null` for empty or whitespace-only selections.
  - `quoteMarks(): Extension` plus `setQuoteMarks: StateEffectType<Array<{ from: number; to: number; id: string }>>`. Marks carry class `edit-quote` and `data-quote-id`.
  - Composer props `beforeSend?: () => Promise<boolean>` and `sendLabel?: string`. When `beforeSend` resolves `false`, the send is aborted and the draft kept.

- [ ] **Step 1: Write failing tests.**
  - Unit, in `test/edit-quotes.test.ts`:
    - `finds the occurrence nearest the quoted start line` (same text on lines 2 and 9, `startLine: 8`, gives the line-9 offset).
    - `finds text that moved to other lines`.
    - `returns null when the text is gone`.
    - `handles a multi-line exact`.
  - Browser:
    - `selecting in the editor starts a thread with a line quote`: select a word on line 3 and use the toolbar's new-thread action. The request's `fileQuote` equals `{ path: doc.path, kind: 'doc', exact: '<word>', startLine: 3, endLine: 3 }`. The thread shows the `a.md:3` badge, and the editor shows an `.edit-quote` mark.
    - `sending while dirty saves first`: type, select, and expect the composer button reads "Save & send". Send, then expect the file holds the typed text before `/api/questions` is called (route-order check via `page.route`).
    - `Save & send aborts on conflict`: dirty, then an external write, then send. Expect the banner, no new request, and the draft kept.
    - `edit-mode quote shows Selection changed after its text is deleted and saved`.
    - `view-mode selection still works unchanged in view mode`: the existing behavior smoke test.
- [ ] **Step 2: Run, expect failures.** `node --import tsx --test test/edit-quotes.test.ts`; `pnpm exec playwright test test/browser.spec.ts -g "editor|Save & send|Selection changed"`.
- [ ] **Step 3: Implement.**
  - **Selection capture:** on `mouseup`/`keyup` (Shift/Arrow)/`touchend` in the editor, `selectionQuote` feeds `setHtmlPending`, so the existing toolbar, `draftKey` and `attachToConversation` paths apply unchanged.
  - **Highlights:** `MarkdownEditMode` computes marks from every thread message `fileQuote` / `fileSelections[].fileQuote` with `kind === 'doc' && path === current.path`, via `locateFileQuote` on the editor text. It re-dispatches on text or thread change. Clicking a mark opens its thread.
  - **Validity:** `fileQuoteIssue` gives a matching doc quote `'Selection changed'` when `locateFileQuote(content.markdown, quote)` is `null`.
  - **Save & send:** `beforeSend` is `handle.save` while edit mode is dirty, and `sendLabel` is "Save & send".
- [ ] **Step 4: Run** Step 2 commands plus `node --import tsx --test test/selection.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `feat: quote markdown source from edit mode`.

### Task 5: Mode-switching reveal and proposal guard

**Files:**
- Modify: `web/app.tsx` (`selectionActions.onOpenFileQuote` ~1055, `showPassage` ~1086), `web/ProposalReview.tsx:79-82`
- Test: `test/browser.spec.ts`

**Interfaces:**
- Consumes: `EditModeHandle` (`requestExit`, `revealLines`, `isDirty`), and the edit-mode open path from Task 2.
- Produces:
  - `ProposalReview` prop `decisionBlocked?: string`. When set, accept actions show that text as the error and do not call the API. Reject stays allowed.

- [ ] **Step 1: Write failing browser tests:**
  - `clicking an edit-mode quote in view mode opens the editor at its lines`: create a quote on line 20 from edit mode, **Done**, then click the thread's file quote. Expect edit mode active, the line-20 mark in view, and the editor's top visible line ≤ 20 ≤ bottom.
  - `clicking a view-mode passage in edit mode leaves edit mode and reveals it`: clean. Expect the article and its `mark` revealed.
  - `while dirty, revealing a view-mode passage asks; Cancel stays in edit mode`: expect the dialog, then **Cancel**, and the editor still has the text and no article.
  - `accepting a proposal while dirty is blocked; while clean it flows into the editor`: dirty plus accept gives "Save or discard your edits first" and an unchanged file. After saving, accept updates the file and the editor shows it.
- [ ] **Step 2: Run, expect failures.** `pnpm exec playwright test test/browser.spec.ts -g "edit-mode quote|view-mode passage|proposal while dirty"`.
- [ ] **Step 3: Implement.**
  - **Edit-mode quotes:** in `onOpenFileQuote`, a `kind === 'doc'` quote whose `path === current?.path` (registered Markdown) enters edit mode if needed, then calls `revealLines(startLine, endLine)`. Other quotes keep today's path.
  - **View-mode passages:** `showPassage` (and the article "reveal highlight" entry points) first `await handle.requestExit()` when editing, and stop on `false`.
  - **Proposals:** pass `decisionBlocked` while editing and dirty.
- [ ] **Step 4: Run** Step 2 plus the full gates: `pnpm test`, `pnpm run typecheck`, `pnpm exec playwright test`. Expect all PASS.
- [ ] **Step 5: Commit** `feat: switch modes to reveal quotes and guard proposal accept`.
