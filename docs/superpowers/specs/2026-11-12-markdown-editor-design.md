# Markdown editor for registered documents

Date: 2026-11-12
Status: approved by Sean 2026-11-12

## Intent

Sean mostly reads Markdown documents in Sidecar, but wants the option to edit
one without leaving the viewer. Editing is an occasional, explicit mode; the
reading experience stays the default and is unchanged.

He wants ordinary undo/redo while editing. He first asked for source and
rendered preview side by side with aligned scrolling; after learning that
Plannotator's editor is an Obsidian-style live preview (syntax hidden except
on the cursor line, formatting rendered inline), he chose to **try that editor
as is, with no separate preview pane**.

## Goals

- An **Edit** control on registered Markdown documents that swaps the reading
  article for Plannotator's live-preview Markdown editor, in the same place.
- Per-keystroke undo/redo inside the editor.
- Explicit save. A save writes the file safely and records a version.
- No silent loss: if the file changed on disk after editing began, the user
  chooses what happens; save never overwrites a newer file without an
  explicit choice.
- Usable on a phone.
- In edit mode, select text and ask about it, request changes, add it to the
  current thread, or start a new thread with the highlight attached, the same
  as in view mode (Sean).

## Non-goals

- A side-by-side source/preview layout and scroll alignment between panes.
  Deferred, not rejected: revisit if the live-preview editor alone is not
  enough. A raw-source variant would need its own CodeMirror setup (see
  Approaches).
- Editing linked file windows (dock, file-tree previews), code files, or HTML
  documents. Registered Markdown documents only. The same component can be
  reused for linked Markdown files later.
- Delta/patch-based version storage, compression, or version pruning. Versions
  stay full content-addressed copies (`src/snapshots.ts`). Growth now tracks
  saves, not keystrokes; measured store on 2026-11-12 was 514 versions, 45
  documents, 13.4 MB. Pruning stays the existing `ponytail:` note in
  `src/server.ts`.
- Undo/redo that crosses saves or reverts agent edits (a "revert to version"
  feature). Undo is the editor's in-memory history only.
- Auto-merge of concurrent agent edits, and autosave.

## Anti-goals

- Changing bytes the user did not touch (normalizing list markers, escaping,
  whitespace). Agents and proposals read this file afterwards; an edit must be
  a minimal diff.
- Overwriting an agent's concurrent change without the user choosing to.
- Making the default viewing mode heavier, slower, or more cluttered.

## Constraints and current state

- Rendering: the viewer parses Markdown into Plannotator blocks in the browser
  (`web/MarkdownDocument.tsx`, `parseMarkdownToBlocks`). Each `Block` carries
  `startLine` (1-based source line). Block DOM does not currently expose it.
- Editor: `@plannotator/ui/components/MarkdownEditor` (a theme shim over
  `@plannotator/markdown-editor`, CodeMirror 6 via `@plannotator/atomic-editor`)
  is already installed through `@plannotator/ui@0.47.0`. It is byte-faithful
  for LF text, live-preview styled (no option to show raw source), and has
  built-in undo/redo. Its handle exposes `getMarkdown`, `undo`, `redo`,
  `focus`, search, `revealText`, and `getContentDOM`; it has **no** set-text
  method. `markdown` is read at mount only; changing `documentId` remounts
  (and drops undo). `extensions` are captured once per `documentId`. It needs
  a height-bounded parent and scrolls internally.
- Any custom CodeMirror extension must be built against the same single copy
  of `@codemirror/state` / `@codemirror/view` the editor uses (currently
  6.7.6 / 6.43.13 in the lockfile). Two copies break the editor.
- File writes: `prepareFileWrite` / `publishFileWrite` / `discardFileWrite`
  (`src/proposal-writes.ts`) write a temp file in the same directory, then
  re-check path, identity (dev/ino/mode), and content hash against the
  expected `beforeVersion` immediately before `rename`. They throw a 409
  `DomainError` if the file moved on. Proposal-specific wording in those
  errors will need a neutral variant.
- Per-document serialization: `proposalService.withDocument(documentId, …)`.
- Live updates: `refresh(document)` in `src/server.ts` re-reads the file;
  when the version changes it emits `changed()` and runs
  `proposalService.revalidate`, which marks pending proposals `outdated` when
  their target text no longer matches. Highlight quote validity refresh from
  PR62 applies to any version change.
- `bodyOf` in `src/viewer-http.ts` caps request bodies at 256 KiB.
- Layout: right conversation sidebar is collapsible and auto-hides at
  `innerWidth <= 850` (`web/app.tsx`). Mobile has separate document/chat
  views.

## Approaches considered

### Editor surface

1. **Plannotator `MarkdownEditor` as is, single pane — chosen by Sean.**
   Import, no copy. Live preview means a separate rendered pane would mostly
   repeat it, so there is none.
2. **Plain CodeMirror raw-source editor plus rendered preview pane.** Every
   Markdown character visible, exact line-to-block scroll sync. Costs four
   direct `@codemirror/*` dependencies (already in the lockfile) and ~50
   lines of editor setup. Deferred: the fallback if live preview disappoints.
3. **`<textarea>`.** No dependencies, but no syntax styling, and replacing
   its text on an external change wipes native undo. Rejected.

### Save path

1. **New save route on the existing write helpers — chosen.** Browser sends
   the new text and the version editing started from. Server reuses
   `prepareFileWrite`/`publishFileWrite` under `withDocument`, saves before and
   after versions, and lets the normal refresh/revalidate path update
   highlights and proposals. Conflict returns 409. Small: one route plus
   wiring, no new storage.
2. **Save as a self-accepted proposal.** Every save would appear as a
   whole-document proposal in threads; proposals are designed for passage
   replacement. Rejected: noise and misuse.
3. **Plain file write.** Skips symlink/identity protection and the conflict
   check, so it can overwrite an agent edit. Rejected: violates the
   no-silent-loss goal.

### Concurrent edits

**Warn and let the user choose — chosen by Sean** over auto-merge or
autosave, because editing is occasional and conflicts will be rare.

## Design

### Entering and leaving edit mode

- **Edit** button in the document header of a registered Markdown document
  (not HTML, not linked file windows).
- Edit mode replaces the reading article with the editor in the same area,
  sized to the available height. Header shows dirty state (e.g.
  "● Unsaved"), **Save**, and **Done**.
- Entering edit mode opens the editor near where the reader was: take the
  top visible block's `startLine` and scroll the editor to that line. On
  **Done**, return the reader to the block containing the editor's top
  visible line. Approximate is fine. *(Claude's call: keeps the user's
  place without any live sync.)*
- **Done** with no unsaved changes returns to view mode. With unsaved changes
  it asks: Save, Discard, or Cancel.
- Navigating away from the document, closing it, or closing/reloading the tab
  with unsaved changes must prompt (in-app confirm; `beforeunload` for the
  tab).
- The conversation sidebar keeps its existing open/collapse behavior.
- Phone and narrow screens: same single editor pane; no special layout.

### Undo / redo

- CodeMirror history in the editor, per keystroke, in memory. ⌘Z / ⇧⌘Z (Ctrl
  on non-Mac). Kept across saves; lost when leaving edit mode, reloading, or
  choosing Reload in the conflict banner. Not tied to versions.

### Save

- ⌘S / Ctrl+S and the Save button.
- Request carries `{ markdown, baseVersion }`, where `baseVersion` is the
  version the editor's text was last synced to (initially the version edit
  mode opened with; updated after each successful save or accepted external
  update).
- Server, inside `withDocument(documentId)`:
  1. Read the source; if its version ≠ `baseVersion`, return 409 conflict
     with the current version.
  2. If text is unchanged, return success without writing.
  3. `saveDocumentVersion` for the before version, `prepareFileWrite`,
     `saveDocumentVersion` for the after version, `publishFileWrite`,
     `discardFileWrite` in `finally` (same order as accepted proposals).
  4. Trigger the normal refresh so `changed()` and `revalidate` run and
     clients see the new version.
- Response returns the new version; the client updates `baseVersion` and
  clears dirty state. Undo history is kept.
- Only registered Markdown documents of the current owner are accepted.
- The save route needs a body limit above `bodyOf`'s 256 KiB so large
  documents can be saved.
- No `proposalWrites` recovery record: a plain save has no decision state to
  recover after a crash.

### External changes while editing

- The client already receives new versions of the open document. In edit
  mode:
  - **Editor clean (no unsaved changes):** replace the editor content with
    the new text in place, preserving scroll position as best as possible,
    and update `baseVersion`. This needs a small CodeMirror extension (to get
    the `EditorView` and dispatch a replacement transaction) rather than a
    remount, so the user's own undo history and cursor survive. The
    replacement is dispatched with `Transaction.addToHistory.of(false)` so
    ⌘Z can never step back over an agent's change and then save it away
    against the new `baseVersion`. *(Claude's call.)*
  - **Editor dirty:** show a banner "This file changed on disk." with
    **Reload** (discard my edits, load the new text, update `baseVersion`) and
    **Keep mine** (dismiss; the next save will still be checked). Reload
    remounts the editor (new mount key) and so clears undo history: the user
    chose to discard those edits, and undo must not bring them back.
    *(Claude's call.)*
- **Save conflict (409):** show the same banner, plus **Save anyway**, which
  re-sends with the current disk version as `baseVersion` (explicit
  overwrite). *(Claude's call, so Keep mine is not a dead end.)*
- The file disappearing or becoming unreadable shows an error banner; edits
  stay in the editor until the user leaves.
- **Line endings:** CodeMirror normalizes `\r\n` and `\r` to `\n`, which
  would rewrite every line on first save. Edit is disabled (with a short
  explanation) for documents containing `\r`. *(Claude's call; uniform-CRLF
  support via `EditorState.lineSeparator` can come later if needed.)*

### Threads, highlights, proposals

- No new mechanism. A save is a file change like an agent edit: the refresh
  path revalidates pending proposals and PR62 refreshes quote validity.
  Highlights whose text was edited away become invalid exactly as they do
  after an agent edit.
- Accepting a proposal while in edit mode: allowed when the editor is clean
  (the file write then flows into the editor as a clean external update);
  blocked with "Save or discard your edits first" when dirty, so the user
  cannot conflict with themselves. *(Claude's call.)*

### Selections and threads in edit mode

View-mode selections are `Quote`s anchored in the **rendered article text**
(`selectionText` in `web/selection.ts`) of a saved version. Edit mode does
**not** translate into that model. It sends **raw Markdown source** using the
existing `FileQuote` type (`src/quote.ts`): `{ path, kind: 'doc', exact,
startLine, endLine }` with `path` = the registered document's own path. This
type is already validated by the server, carried by the agent protocol, and
rendered in threads (code file windows use it with line ranges; registered
HTML documents already attach `FileQuote`s to their threads). The agent reads
the source file, so raw source with line numbers is the better input anyway.
*(Sean.)*

- **Capture:** a CodeMirror extension (via the editor's `extensions` prop)
  reads the selection's source text, its 1-based start/end lines, and its
  screen coordinates (`coordsAtPos`). It drives the same selection menu view
  mode uses: ask / add to current thread / new thread with the highlight /
  request a change. No new menu.
- **Save & send (Sean):** if the editor is dirty when the user sends, the
  send action is labelled "Save & send" and saves first (same save route,
  same conflict handling; a conflict aborts the send and shows the banner).
  The agent then reads exactly the text that was selected.
- **Where the highlight shows (Sean):** painted in the editor (CodeMirror
  mark decoration over the quoted source, found from `exact` near
  `startLine`), and shown in the thread as quoted text with a line range,
  like code-window quotes. It is **not** painted on the reading-view
  article.
- **Validity:** `fileQuoteIssue` in `web/app.tsx` currently looks quotes up
  among linked file windows only; extend it so a `doc` `FileQuote` whose
  path is the open registered document is checked against that document's
  current source ("Selection changed" when `exact` is gone).
- **View-mode highlights are not painted in the editor.** That would need
  rendered-text-to-source mapping, which this design avoids. They still show
  in view mode. *(Claude's call, agreed by Sean.)*
- **Revealing switches mode (Sean):** each highlight is revealed in the mode
  it was made in. Clicking an edit-mode quote (`FileQuote` on the open
  document) in a thread while in view mode enters edit mode and scrolls the
  editor to and paints its lines. Clicking a view-mode quote (`Quote`) while
  in edit mode leaves edit mode through the normal Done flow (clean: leave
  at once; dirty: Save / Discard / Cancel, where Cancel stays in edit mode
  and does not reveal), then reveals it on the article as today.
- Live preview reveals raw Markdown on lines inside a selection, so text
  shifts slightly while selecting. Accepted as cosmetic.
- Deferred: painting edit-mode highlights in the reading view, and view-mode
  highlights in the editor, if Sean misses them.

## Left to the builder

- Exact visual treatment of the header controls, dirty indicator, and banner,
  using existing Sidecar styles.
- `@codemirror/state` and `@codemirror/view` become direct dependencies
  pinned to the copies already in the lockfile (6.7.6 / 6.43.13); the
  builder verifies a single copy is bundled.
- How to expose block `startLine` for the enter/leave position mapping.
- Neutral wording for the write-helper 409 errors.
- Route path and payload naming.
- Test plan: backend tests for the save route (success, unchanged, 409
  conflict, non-registered / non-Markdown / `\r` rejection, version files
  written, large body); browser tests for edit/save/done, dirty prompts,
  clean external update (undo does not revert it), dirty-conflict banner
  (Reload, Keep mine, Save anyway), and a phone-width viewport; edit-mode
  selection to new thread and to existing thread (clean and Save & send),
  the `FileQuote` sent with correct path/lines/text, the highlight painted in
  the editor and shown in the thread, thread-click opening edit mode at the
  lines, view-mode quote click from edit mode (clean, and dirty with Cancel), and "Selection changed" after the quoted text is edited away.
