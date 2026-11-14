# Source-anchored references and split Markdown editor

Date: 2026-11-13
Status: draft for Sean's review
Supersedes: `2026-11-12-markdown-editor-design.md` (editor surface, selections
in edit mode, and mode switching). That document's save path, conflict
handling, and header controls carry over unchanged unless stated below.

## Intent

Sean tried the branch's live-preview editor (Plannotator `MarkdownEditor`,
syntax hidden except near the cursor) and did not like it. He wants the
layout he first asked for: raw Markdown source on one side, rendered preview
on the other, scrolling in step. He wants it built here rather than imported,
borrowing code where that helps (VS Code's preview scroll sync was discussed;
the sync below improves on it).

While designing selections for the two panes, Sean decided that **every
reference to a Markdown document should be raw Markdown source**, in view
mode as well as edit mode, and that losing existing references is acceptable.
The agent edits the source file, so a source quote is exactly what it needs
to find the passage, and one kind of quote removes the edit-mode/view-mode
split the previous design had.

## Goals

- Edit mode shows two panes: an editable raw-source pane (left) and the
  normal rendered view of the current text (right), updating as the user
  types.
- The panes scroll in sync in both directions, aligned by element and by
  position within the element, measured in pixels.
- Every Markdown reference (user selections in view mode, in either edit
  pane, and in Markdown file windows; agent highlights) is anchored in the
  Markdown source.
- Selecting rendered text produces the exact source slice it corresponds to
  (rules below).
- A reference can be revealed from any mode without switching modes.
- Usable on a phone.

## Non-goals

- Monaco or any VS Code editor component. CodeMirror 6 is already a
  dependency and every editor helper on the branch uses it.
- A draggable divider between panes. Fixed 50/50; add later if wanted.
- Keeping old rendered-text references. Sean accepted losing them.
- Changing HTML document quotes (selector/fingerprint), code file quotes
  (already source lines), or chat message quotes (`MessageQuote`).
- Everything listed as a non-goal in the 2026-11-12 design (patch-based
  versions, cross-save undo, auto-merge, autosave, editing linked file
  windows / code / HTML).

## Anti-goals

- A quote whose `exact` is not a literal substring of the source version it
  names.
- Panes that fight each other while scrolling (feedback loops, jitter).
- Making view mode slower or heavier for documents that are never edited.
- Changing bytes the user did not touch (carried over).

## Constraints and current state

Rendered-text model today (research on branch head 9c84ba9):

- **Capture:** `captureSelection` (`web/app.tsx` ~811-865) measures the
  selection as UTF-16 offsets into `selectionText(article)`
  (`web/selection.ts:59`), the concatenation of DOM text nodes minus
  `excludedSelection` (buttons, svg, KaTeX, `aria-hidden`, …). The `Quote`
  (`src/quote.ts`) is `{exact, prefix, suffix, start, end, version, sentence?,
  isPositionVerified?}` with 32-character rendered context.
- **Matching:** `matchQuote` / `resolveQuote` / `quoteIssue`
  (`web/selection.ts`) operate on any string; today that string is rendered
  text. Position wins only when `isPositionVerified` and the version matches.
- **Painting:** `@plannotator/web-highlighter` paints DOM ranges from
  `quoteRange(article, quote, version)` (`web/selection.ts:94`). Proposal
  review positions its popover from the same range
  (`web/ProposalReview.tsx:67`).
- **Agent highlights:** reply metadata `highlights[]` (`src/reply-metadata.ts`)
  carry rendered `exact`/`prefix`/`suffix`; the server stores them with
  placeholder offsets (`src/store.ts` ~336) and the viewer locates them.
  `highlights[i].proposal.before/after` are already **source** text, located
  by `locateSource` (`src/proposals.ts`), linked to the highlight only by
  array index.
- **Agent payload:** `requestContext` (`src/server.ts:61-72`) sends the
  user's selection as `quote: {exact, sentence?}`.
- **Agent docs:** `.agents/skills/sidecar/SKILL.md` (lines ~168-242) and
  `README.md` (~201-205, 247, 303-317) describe rendered-text quotes.
- **Original view:** `web/OriginalDocument.tsx` matches and disambiguates
  against the rendered text of an old version and re-anchors via
  `reanchorSelection` (`src/store.ts:375`).
- **File windows:** Markdown file windows capture rendered-text `FileQuote`s
  with no lines (`web/FilePreview.tsx:60-72`); a hidden `RenderedTextProbe`
  exists only to validate those (`FilePreview.tsx:132`, `app.tsx`
  ~1064-1090).
- **State:** `State.version` is 5; `readSavedState` refuses any other version
  and any state failing `isState`; there is no migration path today. Proposal
  integrity requires the proposal's `selectionId` to exist on its agent
  message (`src/store.ts:126`).
- **Rendering:** Plannotator `parseMarkdownToBlocks` gives each `Block` a
  `type`, inline-Markdown `content`, `startLine`, and sometimes
  `sourceLineCount`. The branch already wraps each main-document block in
  `<span data-source-line style="display:contents">` (`sourceLines` prop on
  `MarkdownDocument`).
- **Editor packages:** the lockfile already has `@codemirror/commands@6.11.1`,
  `@codemirror/language@6.12.4`, `@codemirror/lang-markdown@6.5.2`,
  `@lezer/highlight@1.2.5` next to the direct `@codemirror/state@6.7.6` /
  `@codemirror/view@6.43.13`.

## Approaches considered

### Editor surface

1. **CodeMirror 6 directly, plain source with Markdown syntax colouring —
   chosen.** Already a dependency; the branch's helpers (`web/editor-view.ts`:
   `minimalChange`, `applyExternalText`, marks, selection capture) are
   CodeMirror code and carry over.
2. **Monaco (VS Code's editor).** MIT, but several MB, and every helper would
   be rewritten. Rejected.
3. **Plannotator `MarkdownEditor` (current branch).** Sean tried it and
   rejected the live-preview style.

### Scroll sync

1. **Pixel-measured block segments with a sliding anchor — chosen by Sean.**
   Detailed below.
2. **VS Code's line-based sync** (`data-line` per block, interpolate by
   source line). Drifts on long wrapped paragraphs because one source line
   can be many screen lines. Its structure (block map, lock against echo
   scrolls) is reused.

### Reference scope

1. **Source-anchored everywhere, old references dropped — chosen by Sean.**
2. Source-anchored in edit mode only, rendered in view mode. Smaller, but
   keeps two kinds of quote and the mode-switching rules. Rejected by Sean.

### Sequencing

**Keep building on `feat/markdown-editor` — chosen by Sean.** The branch is
already based on current `main` (4f2b15b, #62), so no sync is needed first. Its save route,
conflict banner, Save & send, header controls, and tests stay. Order: source
references first (the preview pane's selection mapping depends on them),
then replace the editor with the split editor. One merge at the end.

## Design — part 1: source-anchored references

### Quote

`Quote` keeps its shape and validation, minus `sentence`, with new meaning:

- `exact`: a literal substring of the source of `version`.
- `start`/`end`: UTF-16 offsets of `exact` in that source.
- `prefix`/`suffix`: source text either side (32 characters at capture,
  growing as `resolveQuote` does today when needed for uniqueness).
- `isPositionVerified`: true when `start`/`end` were measured, not guessed.

`matchQuote`, `resolveQuote`, `quoteIssue` are reused unchanged against the
source string instead of rendered text. `sentence` is dropped from capture,
storage, and payload. *(Claude's call: line numbers replace it.)*

### Rendered-to-source mapping (the core new piece)

A function maps a DOM position inside the rendered article to a source
offset, and its inverse maps a source offset to a DOM position. Both work
per block, using the block's `startLine`/source span and the block's DOM
(reached through the `data-source-line` wrapper, which must therefore be on
in every renderer that captures or paints quotes: main document, original
view, Markdown file windows, edit-mode preview).

Within a block, rendered characters are aligned to the block's source
characters, skipping Markdown syntax. The builder chooses the alignment
algorithm, but a naive greedy "next matching character" scan is not enough:
it would match rendered text into link URLs. Required results:

| Rendered selection | Source quote |
| --- | --- |
| `Hello wor` in `Hello **world**` | `Hello **wor` |
| `world` in `Hello **world**` | `**world**` |
| `wor` in `Hello **world**` | `wor` |
| `click here` (a link) | `[click here](https://…)` |
| `here` (part of a link) | `here` |
| text inside inline code | the same text, backticks only if the whole code span is selected |
| `*` rendered from `\*` | `\*` |
| `&amp;` (Plannotator renders entities literally) | `&amp;` |
| `…` rendered from `...`, `—` from `---`, emoji from `:rocket:` | `...`, `---`, `:rocket:` |
| curly quote rendered from a straight quote (Plannotator smartens) | the straight quote |
| across two blocks (end of a paragraph into a heading) | the source between, including `\n\n## ` |
| inside a fenced code block | the same characters, 1:1 |

**Edge rule (Sean):** Markdown syntax strictly between the first and last
selected characters is always included. Syntax at an edge is included only
if the whole element it belongs to is selected.

**Block syntax follows the same rule.** *(Claude's call, extending Sean's
rule.)* Selecting a whole heading, list item, task item, blockquote, or code
block includes its markers: `## Title`, `- item`, `- [ ] task`, each line's
`> `, and the fences. A partial selection inside one gets no markers, so
`Tit` in a heading is `Tit`. Table cells map to cell text; selecting whole
rows includes their pipes.

**Fallback:** where alignment fails (raw HTML blocks, directives, math,
anything unmapped), the quote is the whole source lines of the blocks the
selection touches. Mermaid and KaTeX stay unselectable as today.

### Capture

- **View mode and edit-mode preview pane:** browser selection → mapping →
  `Quote` against the source being displayed (saved source in view mode, the
  editor's current text in the preview pane).
- **Edit-mode source pane:** CodeMirror selection, exact as selected
  (existing `selectionQuote` in `web/editor-view.ts`, producing a `Quote`
  instead of a `FileQuote`).
- **Markdown file windows:** same mapping, producing a `FileQuote` with
  `startLine`/`endLine` and source `exact` (like code files). Rendered-text
  `FileQuote`s and `RenderedTextProbe` are removed; `fileQuoteIssue` checks
  line quotes against the file's source only.
- Any capture that would yield whitespace-only `exact` is ignored.

### Painting and reveal

- Rendered views paint a quote by mapping its source range to DOM ranges and
  handing them to the existing highlighter. Partial-syntax quotes paint only
  their visible characters (`Hello **wor` paints "Hello wor").
- A quote covering no visible character (e.g. only a link URL) paints its
  containing block. *(Claude's call.)*
- The source pane paints quotes as CodeMirror marks (existing `quoteMarks`).
- Proposal review positions its popover from the painted range, as today.
- **Clicking a reference never switches modes.** View mode: scroll to and
  flash the passage. Edit mode: scroll the source pane to it and mark it; the
  preview follows through the sync. A source-pane quote clicked in view mode
  just reveals it in view mode. The branch's mode-switching logic
  (`requestExit` on view quotes, opening edit mode for `doc` FileQuotes,
  `reveal` prop) is removed.

### Agent side

- **Payload:** `quote: {exact, startLine, endLine}` with lines computed by the
  server from the quote's version source. *(Claude's call; the agent can
  read surrounding context from the file.)*
- **Highlights:** `exact`, `prefix`, `suffix` are literal source text. The
  server stores them as today (placeholder offsets, not verified); the
  viewer locates them in source with `matchQuote`. A highlight that does not
  match shows the existing "Passage changed" / "Multiple matching passages"
  states.
- **Highlights in a Markdown file-window thread** keep today's routing:
  they become `MessageSelection`s against the main document. Pointing them
  at the file as line-anchored `FileQuote`s is a follow-up, not part of this
  work. *(Claude's call: scope.)*
- **Proposals:** unchanged. The skill should recommend that a proposal's
  `before` equal its highlight's `exact` when both target the same passage.
- **Docs:** rewrite the quote/highlight sections of
  `.agents/skills/sidecar/SKILL.md` and the README sections listed above for
  source text. Remove the "visible text, without Markdown formatting
  delimiters" and "heading markers are not visible context" guidance.

### Validity and original view

- `passageIssue` checks quotes against the current saved source (view mode)
  or the editor's current text (edit mode).
- Original view matches against the old version's **source**, paints via the
  mapping on that version's render, and its disambiguation list shows source
  snippets. `reanchorSelection` is unchanged in shape.

### State migration

- `State.version` becomes 6. `readSavedState` accepts 5 and migrates once:
  drop every Markdown-document `MessageSelection`, request `quote`, every
  `kind: 'doc'` `FileQuote` without `startLine`, and every `kind: 'doc'`
  `FileQuote` whose path is its thread's own registered document (those came
  only from this branch's earlier edit mode, which never shipped). Drop
  `sentence` everywhere.
  Conversations, messages, HTML quotes, code quotes, and message quotes are
  kept.
- **Proposals survive.** A proposal from v5 must stay reviewable
  (accept/reject) from its thread after its selection is dropped. The
  builder either relaxes the `selectionId` integrity check for migrated
  proposals or keeps their selection records hidden; review then positions
  the popover by its existing fallback.
- Other versions still fail with the existing preserved-file error.

## Design — part 2: split editor

### Layout

- Edit mode replaces the article with two equal panes: **Source** (left,
  editable CodeMirror) and **Preview** (right, `MarkdownDocument` of the
  editor's current text, `sourceLines` on).
- Preview re-renders from the editor text, debounced (~150 ms, builder's
  call), without remounting so its scroll position is preserved.
- Header controls unchanged: Edit / ● Unsaved / Save / Done in the app
  header.
- **Phone / narrow (≤ 850 px, the existing sidebar breakpoint):** one pane
  with a **Source | Preview** toggle in the edit header. Switching keeps the
  same anchor position via the sync mapping.

### Editor

- CodeMirror 6 directly: `@codemirror/lang-markdown`, `@codemirror/language`
  syntax highlighting, `@codemirror/commands` history and default keymaps,
  line wrapping, no line numbers. These become direct dependencies pinned to
  the lockfile versions above; the builder verifies a single bundled copy of
  `@codemirror/state` and `@codemirror/view`.
- Styled with Sidecar's existing tokens (light and dark), monospace.
- The Plannotator `MarkdownEditor` import and its CSS are removed.
- Carried over from the branch unchanged: `EditModeHandle`, save route and
  409 handling, "This file changed on disk." banner (Reload / Keep mine /
  Save anyway), clean external updates via `applyExternalText` (not in undo
  history), Done prompt, leave guards, `beforeunload`, closed-screen text,
  `decisionBlocked`, `\r` documents not editable, ⌘S.

### Scroll sync (Sean)

1. **Segments.** Build a list pairing each rendered block (finest available:
   heading, paragraph, list item, table, code block, blockquote) with its
   source line range. Gaps between consecutive blocks form their own
   segments, so blank lines and margins map to each other.
2. **Position within a segment, in pixels on both sides.** Source side uses
   CodeMirror's wrapped geometry (`lineBlockAt` / `coordsAtPos`), so a
   paragraph wrapping onto ten screen lines is ten lines tall. A point 40%
   down a segment on one side maps to 40% down the same segment on the other.
3. **Sliding anchor.** The anchor line inside the leading pane's viewport is
   at `viewportHeight × scrollProgress`, where `scrollProgress =
   scrollTop / (scrollHeight − clientHeight)`: top of the viewport at the
   start, near the middle mid-document, bottom at the end. Both panes reach
   their top and bottom together.
4. **Either pane leads.** Whichever pane the user scrolls drives the other.
   Scrolls caused by the sync are ignored for driving (lock or
   programmatic-scroll flag). While typing, the source pane leads.
5. Segments are rebuilt after preview re-render and on resize; images
   loading in the preview trigger a rebuild.
6. Entering edit mode opens both panes at the reader's position; Done returns
   the reader to the preview's position. Replaces the branch's
   `topVisibleLine` / `scrollToLine` hand-off where the sync covers it.

### Selections in edit mode

- Both panes produce `Quote`s (part 1) against the editor's current text.
  *(Claude's calls for unsaved text:)*
  - While the editor is clean, the quote carries the saved version as usual.
  - While dirty, the pending quote's range is tracked through later edits
    (CodeMirror change mapping, as the branch's marks already do), so typing
    elsewhere after selecting does not break it.
  - **Save & send (carried over):** if the editor is dirty when sending, the
    button reads "Save & send" and saves first. The quote is then rebuilt from
    the mapped range in the saved text and stamped with the version the save
    produced. If the quoted text was edited away, the send is blocked with
    the existing "Passage changed" state. A save conflict aborts the send and
    shows the banner.
  - A draft quote whose unsaved text was later discarded is checked like any
    other quote. It is matched against the current source and shows "Passage
    changed" if missing. No new draft handling.
- Highlights from threads paint in both panes.

## Left to the builder

- The alignment algorithm and its data structures, held to the table and
  cases above.
- Exact styling of panes, toggle, and divider line.
- Debounce interval and segment rebuild triggers beyond those listed.
- How migrated proposals stay reviewable (two options above).
- Test plan. Must include:
  - unit tests for the mapping covering every row of the table, the
    fallback, and the inverse mapping;
  - migration v5→v6;
  - agent payload lines;
  - highlight located from source text;
  - view-mode capture and paint of source quotes;
  - original view;
  - Markdown file window line quotes;
  - scroll sync (both directions, start/middle/end, long wrapped paragraph,
    no feedback loop);
  - phone toggle;
  - capture in both panes, and Save & send version stamping;
  - quote click in edit mode not leaving edit mode.

  Existing browser tests asserting rendered-text quotes are updated, not
  deleted.
