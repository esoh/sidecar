import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MultiFileDiff } from '@pierre/diffs/react';
import type { SelectedLineRange } from '@pierre/diffs';
import type { FileQuote } from '../src/quote.ts';

// Unified line diff (Pierre, as in CodeFileView). Quotes are whole lines of the current file:
// deleted lines are never part of a quote, and a file with no current text cannot be quoted.
export function CodeDiff({ path, old, current, onQuote }: {
  path: string; old: string | null; current: string | null; onQuote: (quote: Pick<FileQuote, 'exact' | 'startLine' | 'endLine'>) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const onQuoteRef = useRef(onQuote);
  useLayoutEffect(() => { onQuoteRef.current = onQuote; }, [onQuote]);
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
  const name = path.replace(/\.[^./]+$/, extension => extension.toLowerCase());
  const oldFile = useMemo(() => ({ name, contents: old ?? '' }), [name, old]);
  const newFile = useMemo(() => ({ name, contents: current ?? '' }), [name, current]);
  const colors = getComputedStyle(document.documentElement);
  const bg = colors.getPropertyValue('--background').trim(), fg = colors.getPropertyValue('--foreground').trim();
  const quoteLines = useCallback((startLine: number, endLine: number) => {
    if (current === null) return false;
    const exact = current.split('\n').slice(startLine - 1, endLine).join('\n');
    if (!exact.trim()) return false;
    onQuoteRef.current({ exact, startLine, endLine });
    return true;
  }, [current]);
  const selectLines = useCallback((range: SelectedLineRange | null) => {
    // Line numbers belong to the file named by the side; only the additions side is the current file.
    if (!range || range.side === 'deletions' || range.endSide === 'deletions') return;
    window.getSelection()?.removeAllRanges();
    setSelectedLines(range);
    quoteLines(Math.min(range.start, range.end), Math.max(range.start, range.end));
  }, [quoteLines]);
  function capture() {
    const shadow = root.current?.querySelector('diffs-container')?.shadowRoot;
    const local = shadow && 'getSelection' in shadow && typeof shadow.getSelection === 'function' ? shadow.getSelection() : null;
    const selected = local instanceof Selection && !local.isCollapsed ? local : window.getSelection();
    if (!shadow || !selected?.rangeCount || selected.isCollapsed || !selected.toString().trim()) return;
    const range = selected.getRangeAt(0);
    if (!shadow.contains(range.startContainer) || !shadow.contains(range.endContainer)) return;
    // Current-file lines are the context and addition rows between the selection ends.
    const rows = [...shadow.querySelectorAll('[data-line]')].filter(row => range.intersectsNode(row) && row.getAttribute('data-line-type') !== 'change-deletion');
    const numbers = rows.map(row => Number(row.getAttribute('data-line'))).filter(Boolean);
    if (!numbers.length) return;
    setSelectedLines(null);
    quoteLines(Math.min(...numbers), Math.max(...numbers));
  }
  return <div className="code-file-view" ref={root}
    onMouseUp={capture} onTouchEnd={capture}
    onKeyUp={event => { if (event.key === 'Shift' || event.key.startsWith('Arrow')) capture(); }}>
    <MultiFileDiff oldFile={oldFile} newFile={newFile} selectedLines={selectedLines} options={{
      themeType: 'dark', overflow: 'scroll', diffStyle: 'unified', disableFileHeader: true, enableLineSelection: true,
      onLineSelectionEnd: selectLines,
      unsafeCSS: `:host { color-scheme: dark; --diffs-font-family: 'Geist Mono Variable', monospace; }
        :host, [data-file], [data-code], [data-column-number] {
          --diffs-bg: ${bg}; --diffs-fg: ${fg}; --diffs-dark-bg: ${bg}; --diffs-dark: ${fg};
        }`,
    }} />
  </div>;
}
