import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { computePlanDiff } from '@plannotator/ui/utils/planDiffEngine';
import { MarkdownDocument } from './MarkdownDocument.tsx';
import { ADDED_CLOSE, ADDED_OPEN, REMOVED_CLOSE, REMOVED_OPEN, buildUnits, foldUnchanged, type DiffUnit } from './markdown-diff.ts';

// Plannotator's block diff (MIT) rendered with Sidecar's Markdown renderer. Removed text carries
// .annotation-exclude, so quotes taken from this view can only contain the current file's text.
const SENTINELS = new RegExp(`([${ADDED_OPEN}-${REMOVED_CLOSE}])`);
function markWords(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  let state: 'added' | 'removed' | null = null;
  for (const node of nodes) {
    const pieces = node.data.split(SENTINELS);
    if (pieces.length === 1 && !state) continue;
    const parts: Node[] = [];
    for (const piece of pieces) {
      if (piece === ADDED_OPEN) state = 'added'; else if (piece === REMOVED_OPEN) state = 'removed';
      else if (piece === ADDED_CLOSE || piece === REMOVED_CLOSE) state = null;
      else if (piece && state) {
        const word = document.createElement(state === 'added' ? 'ins' : 'del');
        word.className = state === 'added' ? 'plan-diff-word-added' : 'plan-diff-word-removed annotation-exclude';
        word.textContent = piece; parts.push(word);
      } else if (piece) parts.push(document.createTextNode(piece));
    }
    node.replaceWith(...parts);
  }
  root.querySelectorAll('del:not(.annotation-exclude)').forEach(element => element.classList.add('annotation-exclude'));
}

function Unit({ unit, anchorPrefix, linkBase }: { unit: DiffUnit; anchorPrefix: string; linkBase?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const isInline = unit.type === 'modified' && !!unit.tokens;
  useLayoutEffect(() => { if (ref.current) markWords(ref.current); }, []);
  const render = (markdown: string) => <MarkdownDocument markdown={markdown} documentId="" anchorPrefix={anchorPrefix} linkBase={linkBase} />;
  if (unit.type === 'unchanged') return render(unit.markdown);
  if (unit.type === 'added') return <div className="plan-diff-added">{render(unit.markdown)}</div>;
  if (unit.type === 'removed') return <div className="plan-diff-removed md-diff-removed annotation-exclude">{render(unit.markdown)}</div>;
  if (isInline) return <div className="plan-diff-modified" ref={ref}>{render(unit.markdown)}</div>;
  return <>
    <div className="plan-diff-removed md-diff-removed annotation-exclude">{render(unit.old ?? '')}</div>
    <div className="plan-diff-added">{render(unit.markdown)}</div>
  </>;
}

export function MarkdownDiff({ old, current, anchorPrefix, linkBase, source }: {
  old: string; current: string; anchorPrefix: string; linkBase?: string; source: ReactNode;
}) {
  const units = useMemo(() => buildUnits(computePlanDiff(old, current).blocks), [old, current]);
  const [view, setView] = useState<'rendered' | 'source'>('rendered');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [at, setAt] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const items = useMemo(() => foldUnchanged(units, expanded, unit => unit.markdown.slice(0, 120)), [units, expanded]);
  const changeAt = useMemo(() => { let n = 0; return units.map(unit => unit.type === 'unchanged' ? -1 : n++); }, [units]);
  const total = changeAt.filter(value => value >= 0).length;
  const go = (delta: number) => {
    if (!total) return;
    const next = at < 0 ? (delta > 0 ? 0 : total - 1) : (at + delta + total) % total;
    setAt(next);
    root.current?.querySelector(`[data-change="${next}"]`)?.scrollIntoView({ block: 'center' });
  };
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    // n / p apply while focus is inside this file's window or dock.
    const host = root.current?.closest('.reference-window, .pinned-dock');
    if (!host || view !== 'rendered') return;
    const onKey = (event: Event) => {
      const key = event as KeyboardEvent, target = key.target;
      if (key.ctrlKey || key.metaKey || key.altKey || (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]'))) return;
      if (key.key === 'n' || key.key === 'p') { key.preventDefault(); goRef.current(key.key === 'n' ? 1 : -1); }
    };
    host.addEventListener('keydown', onKey);
    return () => host.removeEventListener('keydown', onKey);
  }, [view]);
  useEffect(() => { if (at >= total) setAt(total - 1); }, [total, at]);
  return (
    <div className="md-diff" ref={root}>
      <div className="md-diff-toolbar" role="toolbar" aria-label="Diff view">
        <div role="group" aria-label="Diff format">
          {(['rendered', 'source'] as const).map(value => <button key={value} aria-pressed={view === value} onClick={() => setView(value)}>{value === 'rendered' ? 'Rendered' : 'Source'}</button>)}
        </div>
        {view === 'rendered' && <div role="group" aria-label="Changes">
          <button aria-label="Previous change" title="Previous change (p)" disabled={!total} onClick={() => go(-1)}>↑</button>
          <button aria-label="Next change" title="Next change (n)" disabled={!total} onClick={() => go(1)}>↓</button>
          <span role="status" aria-label="Change position">{total ? `${at + 1}/${total}` : 'No changes'}</span>
        </div>}
      </div>
      {view === 'source' ? source : items.map((item, index) => {
        if ('fold' in item) return <button key={item.fold.key + index} className="md-diff-fold" onClick={() => setExpanded(previous => new Set(previous).add(item.fold.key))}>⋯ {item.fold.units.length} unchanged {item.fold.units.length === 1 ? 'block' : 'blocks'}</button>;
        const change = changeAt[item.index];
        return <div key={`${item.unit.type === 'modified' ? item.unit.markdown : item.unit.markdown.slice(0, 40)}:${item.index}`} className={`md-diff-unit${change >= 0 && change === at ? ' is-current' : ''}`} data-change={change >= 0 ? change : undefined}>
          <Unit unit={item.unit} anchorPrefix={anchorPrefix} linkBase={linkBase} />
        </div>;
      })}
    </div>
  );
}
