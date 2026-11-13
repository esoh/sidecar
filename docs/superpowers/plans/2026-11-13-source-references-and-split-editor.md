# Source References and Split Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor every Markdown reference in the raw source, and replace the branch's live-preview editor with a source pane plus a rendered preview pane that scroll in sync.

**Architecture:** A pure per-block source map (`web/source-map.ts`) turns a block's Markdown source into its visible text, with a character-to-source table and the inline/block syntax elements. A DOM layer (`web/source-dom.ts`) uses the renderer's `data-source-line` block wrappers to convert DOM selections to source offsets and back. Quotes keep the `Quote` shape, but their offsets and context become source offsets, and the existing `matchQuote`/`resolveQuote` run on source text. The editor becomes a plain CodeMirror 6 source pane beside `MarkdownDocument`. Pixel-segment scroll sync with a sliding anchor sits in `web/scroll-sync.ts`.

**Tech Stack:** TypeScript, Node `node:test`, React 19, Plannotator renderer (`parseMarkdownToBlocks`, `BlockRenderer`), `@plannotator/web-highlighter`, CodeMirror 6, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-13-source-references-and-split-editor-design.md` (read it; the mapping table and edge rules there are binding). The carried-over save and conflict behaviour is specified in `docs/superpowers/specs/2026-11-12-markdown-editor-design.md`.

## Global Constraints

- Every Markdown `Quote.exact` must be a literal substring of the source of `Quote.version`, at `start`/`end` (UTF-16 offsets into that source). `prefix`/`suffix` are source text, 32 characters at capture.
- `Quote` drops `sentence`. The other fields and `isQuote` length rule (`end - start === exact.length`) stay the same.
- Edge rule: syntax strictly between the first and last selected visible characters is included. Syntax at an edge is included only if its whole element is selected. This applies to inline elements (`**`, `_`, `~~`, backticks, links) and block markers (`#…`, list markers, `- [ ] `, each line's `> `, code fences, table pipes).
- If a block can't be mapped, the quote falls back to the whole source lines of the blocks touched. A whitespace-only `exact` is never produced.
- HTML document quotes, code file quotes, and `MessageQuote` are unchanged.
- State version 6. Version 5 migrates once, per the spec's State migration section. Any other version keeps the existing preserved-file error.
- Agent payload for the user's selection is `quote: { exact, startLine, endLine }`.
- No new dependencies beyond direct pins of packages already in the lockfile, at exactly these versions: `@codemirror/state@6.7.6`, `@codemirror/view@6.43.13`, `@codemirror/commands@6.11.1`, `@codemirror/language@6.12.4`, `@codemirror/lang-markdown@6.5.2`, `@lezer/highlight@1.2.5`. One bundled copy of each.
- Remove the `@plannotator/ui/components/MarkdownEditor` import and its CSS.
- Copy:
  - Pane toggle: **Source** | **Preview**.
  - Existing strings stay: "Passage changed", "Multiple matching passages", "Selection context changed", "Save & send", "This file changed on disk.", **Reload**, **Keep mine**, **Save anyway**, **Edit**, **Save**, **Done**, "● Unsaved".
- Narrow layout breakpoint: `innerWidth <= 850`.
- Gates:
  - `pnpm test`
  - `pnpm run typecheck`
  - `pnpm exec playwright test`
- Work in `/Users/seanoh/ws/pg/sidecar/.claude/worktrees/markdown-editor` on `feat/markdown-editor`. Commit per task.

## Review Focus

1. **Smart punctuation and whitespace.** Plannotator smartens quotes, and soft line breaks render as spaces. A selection across `"quoted"` text or a wrapped paragraph must map exactly, not fall back. (Task 1 unit rows, Task 2 browser test.)
2. **Duplicate passages.** The same sentence appears twice. A selection of the second one must quote and paint the second one, and an agent highlight with no context must show "Multiple matching passages". (Task 2 browser test.)
3. **Collapsed headings and closed `<details>`.** Revealing a quote inside a folded section opens it before scrolling, as today. (Task 2 browser test.)
4. **Preview heights change late.** Images and Mermaid diagrams finishing layout must not leave the panes misaligned. (Task 6 browser test with a delayed image.)
5. **CRLF documents in view mode.** Selections in a `\r\n` document still produce exact source slices. Edit stays disabled for them. (Task 1 unit row, Task 2 browser test.)

---

### Task 1: Pure per-block source map

**Files:**
- Create: `web/source-map.ts`
- Test: `test/source-map.test.ts`

**Interfaces:**
- Produces:
  - `type BlockKind = 'paragraph' | 'heading' | 'blockquote' | 'list-item' | 'code' | 'hr' | 'table' | 'html' | 'directive' | 'math'`. This is Plannotator `Block['type']`.
  - `type SyntaxElement = { open: [number, number]; close: [number, number] }`. These are source offsets, relative to the block's `from`, of an element's opening and closing syntax. A block marker has an empty `close`, at the block's end.
  - `type BlockMap = { visible: string; toSource: number[]; elements: SyntaxElement[] }`. `toSource[i]` is the source offset (relative) of visible character `i`, and `toSource[visible.length]` is the end of the last visible character's source.
  - `blockMap(source: string, kind: BlockKind): BlockMap | null`. `source` is the block's own source text. It returns `null` for unmappable kinds or syntax, such as `html`, `directive`, `math` and inline HTML, and the caller then uses the fallback.
  - `sourceSpan(map: BlockMap, start: number, end: number): { start: number; end: number }`. It takes a visible range and returns the source range under the edge rule.
  - `visibleSpan(map: BlockMap, start: number, end: number): { start: number; end: number } | null`. It takes a source range and returns the visible range it covers, or `null` when no visible character is covered.
  - `sameVisible(a: string, b: string): boolean`. It compares the map's `visible` with DOM text, treating curly and straight quotes as equal and any whitespace run as equal.

- [ ] **Step 1: Write the failing tests.** Add one `test()` per row of the spec's mapping table, plus the rows below. Each asserts `source.slice(...sourceSpan(map, i, j))` for the visible indices of the selected text:
  - `Hello **world**`:
    - `Hello wor` gives `Hello **wor`.
    - `world` gives `**world**`.
    - `wor` gives `wor`.
  - `see [click here](https://x.y "t") now`:
    - `click here` gives `[click here](https://x.y "t")`.
    - `here` gives `here`.
    - `visible` is `see click here now`.
  - `` run `npm i` now ``:
    - `npm i` gives `` `npm i` ``.
    - `npm` gives `npm`.
  - `a &amp; b \* c`: `visible` is `a & b * c`, and `&` and `*` give `&amp;` and `\*`.
  - Heading `## Title`, kind `heading`:
    - The whole block gives `## Title`.
    - `Tit` gives `Tit`.
  - List items:
    - `- item` with the whole block gives `- item`.
    - `- [ ] task` with the whole block gives `- [ ] task`.
    - `1. first` gives `1. first`.
  - Blockquote `> one\n> two`:
    - The whole block gives the full source.
    - `two` gives `two`.
  - Fenced code ```` ```ts\nconst a = 1;\n``` ````:
    - The whole block includes both fences.
    - `a = 1` gives `a = 1`.
  - Table `| a | b |\n| - | - |\n| c | d |`:
    - `c` gives `c`.
    - Visible text of a whole row maps to `| c | d |`.
  - Soft break `one\ntwo`: `visible` contains `one`, whitespace, `two`, and `sameVisible(map.visible, 'one two')` is true.
  - CRLF: `Hello **world**\r\n`. Offsets index the `\r\n` source exactly.
  - `visibleSpan`:
    - The source range of `**world**` gives the visible `world`.
    - The source range of `(https://x.y "t")` gives `null`.
  - `blockMap('<div>x</div>', 'html')` returns `null`.
  - `sameVisible('say “hi”', 'say "hi"')` is true.
- [ ] **Step 2: Run to verify failure.** `node --import tsx --test test/source-map.test.ts` fails with "Cannot find module".
- [ ] **Step 3: Implement `web/source-map.ts`.**
  - Use a small hand-written inline scanner over the block source. It must recognise escapes, entities, code spans, emphasis and strong delimiters (`*`, `_`, `**`, `__`, `~~`), links and images (`[text](dest "title")`, `![alt](src)`, where images have no visible text), autolinks (`<https://…>`, where the URL is visible), and hard breaks.
  - Block markers are peeled first, per kind. Markers are per line for blockquotes and for list continuation indent.
  - Do not scan forward greedily for matching characters (the spec explains why).
  - It is self-contained, with no DOM.
- [ ] **Step 4: Run to verify pass.** `node --import tsx --test test/source-map.test.ts` passes.
- [ ] **Step 5: Commit.** `git add web/source-map.ts test/source-map.test.ts && git commit -m "feat: map rendered Markdown blocks to source"`

### Task 2: Source quotes in the reading view

**Files:**
- Create: `web/source-dom.ts`
- Modify:
  - `web/MarkdownDocument.tsx`: add `data-block-type` to the wrapper.
  - `web/selection.ts`: add `sourceQuote`, remove `selectionSentence` and `surroundingSentence` if they are unused.
  - `web/app.tsx`: capture, paint, reveal, anchor, `passageIssue`.
  - `web/ProposalReview.tsx`: popover rect.
  - `web/conversations.tsx`: wherever the quote or sentence is shown.
- Test: `test/selection.test.ts`, `test/browser.spec.ts`

**Interfaces:**
- Consumes: Task 1's `blockMap`, `sourceSpan`, `visibleSpan` and `sameVisible`.
- Produces:
  - `rangeToSource(root: HTMLElement, source: string, range: Range): { start: number; end: number } | null`. Blocks are `[data-source-line]` wrappers inside `root`. A block's source is the span from its `startLine` up to the next wrapper's `startLine`, with trailing blank lines trimmed. It falls back to whole lines when `blockMap` returns `null` or `sameVisible` fails for that block.
  - `sourceToRanges(root: HTMLElement, source: string, start: number, end: number): Range[]`. It returns one DOM range per block covered. A block with no visible coverage contributes a range over its whole content.
  - `sourceQuote(source: string, start: number, end: number, version: string): Quote`. It sets 32-character `prefix`/`suffix` and `isPositionVerified: true`. It lives in `web/selection.ts`.
  - `MarkdownDocument` wrapper: `<span data-source-line={block.startLine} data-block-type={block.type} style="display:contents">`. It still sits behind the `sourceLines` prop.

- [ ] **Step 1: Write the failing tests.**
  - Unit (`test/selection.test.ts`):
    - `sourceQuote` gives prefix/suffix and offsets that `matchQuote(source, quote, version)` finds at the same position.
    - With a duplicate passage, `matchQuote` on source with context returns the second occurrence.
  - Browser:
    - **View selection quotes source:** select `Hello wor` in a document containing `Hello **world**.` and ask. The request's saved quote `exact` is `Hello **wor`, and `start`/`end` index the file. Also assert the highlight paints the text `Hello wor`.
    - **Whole heading:** triple-click a heading. The quote is `## Heading`.
    - **Duplicate passage:** the document has the same sentence twice. Selecting the second one paints the second one after reload.
    - **Agent highlight source:** an agent reply with highlight `exact: '**world**'` paints `world`. One with ambiguous `exact` shows "Multiple matching passages".
    - **Reveal in a collapsed section:** clicking a thread quote whose passage sits under a folded heading opens it and scrolls to it.
    - **Smart quotes:** select across `"quoted"` text. The quote is the straight-quote source, with no fallback to whole lines.
    - **CRLF document:** selecting `wor` gives a quote whose `start`/`end` slice the CRLF source to `wor`.
    - **Proposal popover:** it still opens beside its passage. Adjust the existing test if needed.
  - Update every existing browser test that asserts rendered-text `exact` or `sentence` to the source equivalents. Don't delete them.
- [ ] **Step 2: Run to verify failure.** `node --import tsx --test test/selection.test.ts`; `pnpm exec playwright test test/browser.spec.ts -g "quotes source|Whole heading|Duplicate passage|highlight source|collapsed section|Smart quotes|CRLF document"`.
- [ ] **Step 3: Implement `web/source-dom.ts` and the wiring.**
  - Turn `sourceLines` on in the main document render.
  - `captureSelection` builds the quote with `rangeToSource` and `sourceQuote` against `content.markdown`.
  - Painting, `showPassage` and `anchor` use `locateQuote(content.markdown, …)` and then `sourceToRanges`.
  - The highlighter paints each range.
  - `passageIssue` checks `content.markdown`.
  - Stop sending and storing `sentence`.
- [ ] **Step 4: Run to verify pass.** Step 2's commands, then `pnpm exec playwright test test/browser.spec.ts`.
- [ ] **Step 5: Commit.** `git commit -am "feat: anchor reading-view quotes in Markdown source"`, after adding new files.

### Task 3: Server, agent payload, migration, docs

**Files:**
- Modify:
  - `src/quote.ts`: drop `sentence`.
  - `src/server.ts`: `requestContext`.
  - `src/agent-protocol.ts`.
  - `src/store.ts`: version 6, migration, proposal integrity.
  - `.agents/skills/sidecar/SKILL.md`.
  - `README.md`.
- Test: `test/store.test.ts`, `test/server.test.ts`, `test/agent-protocol.test.ts`, `test/stream.test.ts`

**Interfaces:**
- Consumes: the source-offset `Quote` from Task 2.
- Produces:
  - `migrateState(saved: unknown): State`. This is the v5 to v6 path inside `readSavedState`. It writes v6 on the next save.
  - The request payload `quote` is `{ exact, startLine, endLine }`. The lines are 1-based and are computed from the source of `quote.version` (`versions/<documentId>/<version>.md`, or the current source when that version file is missing and its text still matches at `start`).

- [ ] **Step 1: Write the failing tests.**
  - **Migration (store):** a v5 state fixture contains:
    - a Markdown thread with user and agent `selections` (one of them with a pending proposal);
    - a request `quote` with `sentence`;
    - a `kind:'doc'` FileQuote without lines;
    - a `kind:'doc'` FileQuote on the thread's own document path;
    - an HTML `FileQuote`;
    - a code `FileQuote` with lines;
    - a `MessageQuote`.

    After loading, `version === 6` and the Markdown selections, the request quote, both doc FileQuotes and every `sentence` are gone. The HTML, code and message quotes and all messages remain. The pending proposal can still be accepted through the existing decision path.
  - **Version guard:** a version 4 or 7 state still throws the preserved-file error.
  - **isQuote:** it rejects a quote with `sentence`.
  - **Payload (server):** a question with quote `exact: '**world**'` on line 3 delivers `quote: { exact: '**world**', startLine: 3, endLine: 3 }`. A multi-line quote gives the correct `endLine`.
  - **Agent protocol:** the compact projection carries the new quote fields.
- [ ] **Step 2: Run to verify failure.** `node --import tsx --test test/store.test.ts test/server.test.ts test/agent-protocol.test.ts`.
- [ ] **Step 3: Implement the changes.**
  - Make the migration, payload and integrity changes above.
  - Rewrite the SKILL.md quote, highlight and proposal sections and the README sections named in the spec for source text:
    - `exact`, `prefix` and `suffix` are copied verbatim from the file, including Markdown syntax.
    - Recommend a proposal `before` equal to its highlight `exact`.
    - Remove the "visible text" and "heading markers are not visible" guidance.
- [ ] **Step 4: Run to verify pass.** `pnpm test`.
- [ ] **Step 5: Commit.** `git commit -am "feat: source quotes in agent payload, state v6 migration, docs"`

### Task 4: Original view and Markdown file windows

**Files:**
- Modify:
  - `web/OriginalDocument.tsx`.
  - `web/FilePreview.tsx`: capture as line `FileQuote`, and remove `RenderedTextProbe`.
  - `web/app.tsx`: `probes`, `renderedText` and `fileQuoteIssue`.
  - `web/PinnedWindows.tsx`, if it threads `onRenderedText`.
- Test: `test/browser.spec.ts`, `test/gateway-browser.spec.ts`

**Interfaces:**
- Consumes: `rangeToSource`, `sourceToRanges`, `sourceQuote` and `matchQuote`/`resolveQuote` on source.
- Produces: Markdown file-window quotes as `FileQuote { path, kind: 'doc', exact, startLine, endLine }`, with `exact` taken from the file's source via `rangeToSource`.

- [ ] **Step 1: Write the failing tests (browser).**
  - **Original view, source:** a quote saved on version A still shows on "Show original" after the file changed, and paints the right passage.
  - **Original view, ambiguous:** two candidates list source snippets, and choosing one re-anchors (existing anchor route).
  - **File window line quote:** selecting `Hello wor` in a linked Markdown file window gives `exact` `Hello **wor` with `startLine`/`endLine`. The quote shows its line range in the thread.
  - **File window validity:** the quote shows "Passage changed" once the text is removed from the file.
  - **Probe gone:** no hidden rendered-text probe element is mounted for docked files.
  - Update the existing file-window and original-view tests that assert rendered text.
- [ ] **Step 2: Run to verify failure.** `pnpm exec playwright test -g "Original view|File window"`.
- [ ] **Step 3: Implement.** Turn `sourceLines` on in the `OriginalDocument` and `FilePreview` renders. `fileQuoteIssue` checks line quotes against the file's source only.
- [ ] **Step 4: Run to verify pass.** Step 2, then the full `pnpm exec playwright test`.
- [ ] **Step 5: Commit.** `git commit -am "feat: source quotes in original view and Markdown file windows"`

### Task 5: Split editor

**Files:**
- Create: `web/SourceEditor.tsx` (CodeMirror setup and the React wrapper).
- Modify:
  - `web/MarkdownEditMode.tsx`: two panes, preview, toggle, quotes as `Quote`.
  - `web/editor-view.ts`: `selectionQuote` returns `Quote`.
  - `web/app.tsx`: remove the mode switching for quotes.
  - `web/app.css`.
  - `package.json` and `pnpm-lock.yaml`.
- Delete: `web/edit-quotes.ts` and its test, if no caller remains.
- Test: `test/editor-view.test.ts`, `test/browser.spec.ts`

**Interfaces:**
- Consumes:
  - `EditModeHandle` (unchanged).
  - `applyExternalText`, `minimalChange`, `quoteMarks` and `setQuoteMarks`.
  - Task 2's `rangeToSource`, `sourceToRanges` and `sourceQuote`.
- Produces:
  - `SourceEditor({ initial, documentId, extensions, onChange, viewRef })`. It holds one `EditorView` per mount, with markdown language, syntax highlighting, history, default and history keymaps, line wrapping, and no line numbers.
  - `MarkdownEditMode` props: remove `reveal` and `startLine`. Add `anchor: number` (a source offset to open at) and `quotes: Array<{ id: string; quote: Quote }>`. `onSelect` reports `{ quote: Quote; rect: DOMRect } | null`.
  - `EditModeHandle.revealLines` becomes `revealQuote(id: string): void`.
  - `EditModeHandle` gains `pendingQuote(): Quote | null`. It returns the selected quote's range, mapped through later edits.

- [ ] **Step 1: Write the failing tests.**
  - Unit (`test/editor-view.test.ts`):
    - `selectionQuote` on a CodeMirror state returns a `Quote` whose `exact` is the selected source and whose offsets match.
    - A tracked range mapped through an insertion before it shifts correctly.
  - Browser:
    - **Two panes:** Edit shows a source pane containing the raw `**world**` and a preview pane rendering bold `world`. Typing `!` in the source updates the preview.
    - **No Plannotator editor:** `.cm-content` exists, and no Plannotator live-preview class does. The bundle has no `atomic-editor` import. Check `web/` sources with a grep in a unit test, or assert in the browser.
    - **Preview selection:** in edit mode, select `Hello wor` in the preview, then ask. The quote is `Hello **wor`.
    - **Source selection:** select in the source pane. The quote is exact.
    - **Quote click stays in edit mode:** clicking a view-made quote in a thread while editing keeps edit mode and marks it in the source pane. Clicking an edit-made quote in view mode reveals it in view mode without entering edit mode.
    - **Save & send after typing elsewhere:** select a passage, type before it, then press Save & send. The sent quote is the same passage, at shifted offsets, with the new version. If the quoted text was deleted first, the send is blocked with "Passage changed".
    - **Phone toggle:** at 390 px wide, edit mode shows one pane with **Source** | **Preview**, and switching panes keeps the passage in view.
    - The carried-over tests stay green:
      - save;
      - Done prompt;
      - clean external update not undoable;
      - dirty banner with Reload, Keep mine and Save anyway;
      - closed screen keeps the text;
      - proposal blocked while dirty;
      - CRLF disables Edit.
    - Update the selectors of tests that targeted the Plannotator editor.
- [ ] **Step 2: Run to verify failure.** `node --import tsx --test test/editor-view.test.ts`; `pnpm exec playwright test test/browser.spec.ts -g "Two panes|Plannotator editor|Preview selection|Source selection|stays in edit mode|after typing elsewhere|Phone toggle"`.
- [ ] **Step 3: Implement.**
  - Add the direct dependencies at the pinned versions (`pnpm add --save-exact …`) and verify a single bundled copy.
  - The preview re-renders `MarkdownDocument` (`sourceLines` on) from the editor text, debounced at about 150 ms, without remounting.
  - Remove `requestExit`-on-quote, the doc-`FileQuote` path, and the `reveal` plumbing from `app.tsx`.
  - Use a fixed 50/50 split above 850 px, and one pane with the toggle at or below it.
- [ ] **Step 4: Run to verify pass.** Step 2, then the full gates.
- [ ] **Step 5: Commit.** `git commit -am "feat: split source and preview Markdown editor"`, after adding new files.

### Task 6: Scroll sync

**Files:**
- Create: `web/scroll-sync.ts`
- Modify: `web/MarkdownEditMode.tsx`, for wiring, enter and leave position, and toggle position.
- Test: `test/scroll-sync.test.ts`, `test/browser.spec.ts`

**Interfaces:**
- Produces:
  - `type Segment = { source: [number, number]; preview: [number, number] }`. These are pixel spans in each pane's scroll coordinates. Gap segments between blocks are included, and the list covers 0 to the content height on both sides.
  - `anchorY(scrollTop: number, scrollHeight: number, clientHeight: number): number`. It returns `scrollTop + clientHeight * progress`, where `progress = scrollTop / max(1, scrollHeight - clientHeight)`.
  - `mapY(segments: Segment[], from: 'source' | 'preview', y: number): number`. It maps by the fraction within the containing segment.
  - `targetScrollTop(segments, from, scrollTop, fromHeights, toHeights): number`. It combines `anchorY`, `mapY` and the inverse anchor on the target side, and is clamped to the target's scroll range.
  - `syncScroll(source: EditorView, preview: HTMLElement): () => void`. It wires listeners, rebuilds segments (`lineBlockAt` on the source side, `[data-source-line]` rects on the preview side) on re-render, resize and image `load`, ignores scroll events it caused, and returns a cleanup function.

- [ ] **Step 1: Write the failing tests.**
  - Unit:
    - `anchorY` at top, middle and end gives `scrollTop`, `scrollTop + clientHeight/2` and `scrollTop + clientHeight`.
    - `mapY` maps 40% of a source segment to 40% of the paired preview segment, and gap segments map linearly.
    - `targetScrollTop` with both panes at their ends gives the target's max scroll. At top it gives 0.
  - Browser:
    - **Sync source to preview:** scroll the source so a long, wrapped paragraph's middle is at the anchor. The preview shows the same paragraph at the anchor, within 24 px.
    - **Sync preview to source:** the same, scrolling the other pane.
    - **Ends align:** scrolling either pane to its bottom puts the other at its bottom.
    - **No feedback loop:** after a single programmatic scroll, both `scrollTop`s settle with no further scroll events over 300 ms.
    - **Late image:** an image whose response is delayed loads, and the panes realign at the anchor.
    - **Typing leads:** typing at the bottom of a long document keeps the preview showing the edited block.
    - **Enter and leave:** entering edit mode with a passage at the top of the reading view shows it in both panes, and Done returns the reading view to the preview's passage.
- [ ] **Step 2: Run to verify failure.** `node --import tsx --test test/scroll-sync.test.ts`; `pnpm exec playwright test test/browser.spec.ts -g "Sync|Ends align|feedback loop|Late image|Typing leads|Enter and leave"`.
- [ ] **Step 3: Implement `web/scroll-sync.ts` and the wiring.** Replace the branch's `topVisibleLine`/`scrollToLine` hand-off where sync covers it.
- [ ] **Step 4: Run to verify pass.** Step 2, then the full gates.
- [ ] **Step 5: Commit.** `git commit -am "feat: pixel-segment scroll sync between source and preview"`, after adding new files.
