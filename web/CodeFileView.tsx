import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { File } from '@pierre/diffs/react';
import type { SelectedLineRange } from '@pierre/diffs';
import type { FileQuote } from '../src/quote.ts';

// Pierre renderer/options and shadow-selection handling adapted from Plannotator's
// CodeFilePopout.tsx (MIT). Sidecar keeps its own window/dock and reply composer.
export function CodeFileView({ path, contents, onQuote }: {
  path: string; contents: string; onQuote: (quote: Pick<FileQuote, 'exact' | 'startLine' | 'endLine'>) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const onQuoteRef = useRef(onQuote);
  useLayoutEffect(() => { onQuoteRef.current = onQuote; }, [onQuote]);
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
  const file = useMemo(() => ({ name: path.replace(/\.[^./]+$/, extension => extension.toLowerCase()), contents }), [path, contents]);
  const colors = getComputedStyle(document.documentElement);
  const bg = colors.getPropertyValue('--background').trim(), fg = colors.getPropertyValue('--foreground').trim();
  // Pierre rebuilds its code DOM when an option changes. Keep this callback
  // stable when bringing the window forward, so a pointer drag keeps its nodes.
  const quoteLines = useCallback((range: SelectedLineRange | null) => {
    if (!range) return;
    const startLine = Math.min(range.start, range.end), endLine = Math.max(range.start, range.end);
    const exact = contents.split('\n').slice(startLine - 1, endLine).join('\n');
    if (!exact.trim()) return;
    // Gutter pointerup precedes mouseup; discard an old text range so capture()
    // cannot replace these newly selected lines with the previous snippet.
    window.getSelection()?.removeAllRanges();
    setSelectedLines(range);
    onQuoteRef.current({ exact, startLine, endLine });
  }, [contents]);
  function capture() {
    const shadow = root.current?.querySelector('diffs-container')?.shadowRoot;
    const local = shadow && 'getSelection' in shadow && typeof shadow.getSelection === 'function' ? shadow.getSelection() : null;
    const selected = local instanceof Selection && !local.isCollapsed ? local : window.getSelection();
    if (!shadow || !selected?.rangeCount || selected.isCollapsed || !selected.toString().trim()) return;
    const range = selected.getRangeAt(0);
    if (!shadow.contains(range.startContainer) || !shadow.contains(range.endContainer)) return;
    const lineFor = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('[data-line]');
    const first = lineFor(range.startContainer), last = lineFor(range.endContainer);
    const startLine = Number(first?.getAttribute('data-line')), endLine = Number(last?.getAttribute('data-line'));
    if (!first || !last || !startLine || !endLine) return;
    const lines = contents.split('\n');
    const offset = (line: Element, number: number, node: Node, position: number) => {
      const before = document.createRange(); before.selectNodeContents(line); before.setEnd(node, position);
      return lines.slice(0, number - 1).reduce((total, value) => total + value.length + 1, 0) + before.toString().length;
    };
    // The renderer uses separate line elements. Restore source newlines, excluding the gutter.
    const exact = contents.slice(offset(first, startLine, range.startContainer, range.startOffset), offset(last, endLine, range.endContainer, range.endOffset));
    if (!exact.trim()) return;
    setSelectedLines(null);
    onQuote({ exact, startLine, endLine: startLine + exact.replace(/\n$/, '').split('\n').length - 1 });
  }
  return <div className="code-file-view" ref={root}
    onMouseUp={capture} onTouchEnd={capture}
    onKeyUp={event => { if (event.key === 'Shift' || event.key.startsWith('Arrow')) capture(); }}>
    <File file={file} selectedLines={selectedLines} options={{
      themeType: 'dark', overflow: 'scroll', disableFileHeader: true, enableLineSelection: true,
      onLineSelectionEnd: quoteLines,
      unsafeCSS: `:host { color-scheme: dark; --diffs-font-family: 'Geist Mono Variable', monospace; }
        :host, [data-file], [data-code], [data-column-number] {
          --diffs-bg: ${bg}; --diffs-fg: ${fg}; --diffs-dark-bg: ${bg}; --diffs-dark: ${fg};
        }`,
    }} />
  </div>;
}
