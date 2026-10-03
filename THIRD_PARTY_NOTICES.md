# Third-party notices

The floating-composer placement, outside-click dismissal, compact layout, and
entrance animation in `web/app.tsx`, `web/conversations.tsx`, and `web/app.css`
are adapted from Plannotator’s
`packages/ui/components/CommentPopover.tsx`.
Source: https://github.com/backnotprop/plannotator/blob/435dac656cbdb9af07bab9ffbb20d791b520d172/packages/ui/components/CommentPopover.tsx

The quick-menu icon, entrance animation, above-selection placement, and
comment shortcut’s editable-target guards follow
`packages/ui/components/AnnotationToolbar.tsx` from the same revision.
Source: https://github.com/backnotprop/plannotator/blob/435dac656cbdb9af07bab9ffbb20d791b520d172/packages/ui/components/AnnotationToolbar.tsx

Native copy handling follows `Viewer.tsx` at the same revision.
Source: https://github.com/backnotprop/plannotator/blob/435dac656cbdb9af07bab9ffbb20d791b520d172/packages/ui/components/Viewer.tsx

Pending-highlight cleanup follows `handleToolbarClose` and the CREATE handler in
`packages/ui/hooks/useAnnotationHighlighter.ts`. Sidecar defers document-gesture
dismissal until mouseup so overlapping drags retain their anchor nodes.
Source: https://github.com/backnotprop/plannotator/blob/435dac656cbdb9af07bab9ffbb20d791b520d172/packages/ui/hooks/useAnnotationHighlighter.ts

Quick-menu outside-click dismissal and its multi-click guard follow
`packages/ui/hooks/useDismissOnOutsideAndEscape.ts` at the same revision.
Source: https://github.com/backnotprop/plannotator/blob/435dac656cbdb9af07bab9ffbb20d791b520d172/packages/ui/hooks/useDismissOnOutsideAndEscape.ts

The palette, grid background and document/sidebar styling in `web/app.css`
are adapted from `packages/ui/themes/plannotator.css`, `packages/ui/theme.css`,
`Viewer.tsx` and `AnnotationPanel.tsx` at the same revision.
Source: https://github.com/backnotprop/plannotator/tree/435dac656cbdb9af07bab9ffbb20d791b520d172/packages/ui

The document renderer imports the published MIT-licensed `@plannotator/ui`
0.47.0 components, parser, syntax highlighter, theme stylesheet, and heading
slugs. `web/MarkdownDocument.tsx` follows its `RenderedMarkdown` composition
and `Viewer` diagram/image rendering. Code-block layout in `web/app.css` is
copied from `packages/editor/index.css` at the source revision above.
Source: https://github.com/backnotprop/plannotator/blob/435dac656cbdb9af07bab9ffbb20d791b520d172/packages/editor/index.css

Repository and branch badges directly reuse `DocBadges` from `@plannotator/ui`
0.47.0. The Copy file button in `web/DocumentHeader.tsx` follows its `Viewer.tsx`
markup and styling, under the MIT license below.

Selection badge markup and excerpt typography in `web/conversations.tsx` are
adapted from `DocumentQAPair` in `@plannotator/ui` 0.47.0
`components/ai/DocumentAIChatPanel.tsx`, with Sidecar's two-line excerpt limit
and requested rounded attachment background.

`src/workspace-status.ts` is copied unchanged from Plannotator's
`packages/shared/workspace-status.ts`. The file-browser exclusions and tree
builder in `src/files.ts` are copied from `packages/shared/reference-common.ts`,
and its walk, file cap and changed-file seeding follow `handleFileBrowserFiles`
in `packages/server/reference-handlers.ts`. Its file-type predicates are copied
from the published `@plannotator/core` 0.25.7 `annotatable.ts`.
Source: https://github.com/backnotprop/plannotator/tree/772c620302f584654c3d8e17bbffb2c6255d3331/packages

The Files panel imports `FileBrowser` and `useFileBrowser` from the published
`@plannotator/ui` 0.47.0, connected to Sidecar through its `setFileTreeBackend`
seam. The preview banner reuses Sidecar's original-document styling.

Local file links use the `onOpenLinkedDoc`/`onOpenCodeFile` callbacks and
`setDocPreviewFetcher` of `@plannotator/ui` 0.47.0 `InlineMarkdown`, and open
code in its `CodeFilePopout` through `useCodeFilePopout`. The code-link file
types in `src/files.ts` are copied from `@plannotator/core` 0.25.7
`code-file.ts`.

Inter and Geist Mono are served from Plannotator's Fontsource dependencies;
the fonts use the SIL Open Font License 1.1 distributed with those packages.
KaTeX and its fonts retain the licenses included in the KaTeX dependency.

MIT License

Copyright (c) 2025 backnotprop

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
