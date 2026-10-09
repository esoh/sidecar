import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { api, errorText } from './api.ts';
import type { WorkspaceFileChange } from './useComparison.ts';

// Lazy tree over Sidecar's directory listing, styled with Plannotator's file-tree classes (MIT);
// see THIRD_PARTY_NOTICES.md. Listings and explicit expand/collapse choices are cached per document
// at module level, so a remounted panel or a refresh keeps what the reader opened.
type Entry = { name: string; path: string; type: 'file' | 'folder' };
type DocumentCache = { dirs: Map<string, Entry[]>; errors: Map<string, string>; choices: Map<string, boolean>; revealed: object | null };
const caches = new Map<string, DocumentCache>();
const cacheFor = (documentId: string) => {
  let cache = caches.get(documentId);
  if (!cache) caches.set(documentId, cache = { dirs: new Map(), errors: new Map(), choices: new Map(), revealed: null });
  return cache;
};
const join = (dir: string, name: string) => `${dir.replace(/\/$/, '')}/${name}`;
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
type Total = { files: number; additions: number; deletions: number };

const marks: Partial<Record<WorkspaceFileChange['status'], { label: string; className: string; title: string }>> = {
  added: { label: 'A', className: 'text-success', title: 'Added file' },
  untracked: { label: 'U', className: 'text-primary', title: 'Untracked file' },
  deleted: { label: 'D', className: 'text-destructive', title: 'Deleted file' },
  renamed: { label: 'R', className: 'text-[#007aff]', title: 'Renamed file' },
  conflicted: { label: '!', className: 'text-destructive', title: 'Git conflict' },
};
const Chevron = ({ open }: { open: boolean }) => <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>;
const FolderIcon = () => <svg className="w-3 h-3 flex-shrink-0 text-muted-foreground/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>;
const FileIcon = () => <svg className="w-3 h-3 flex-shrink-0 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>;
export const Counts = ({ additions, deletions }: { additions: number; deletions: number }) => <>
  {additions > 0 && <span className="additions">+{additions}</span>}{deletions > 0 && <span className="deletions">-{deletions}</span>}
</>;

export function FileTree({ documentId, root, changes, activePath, reveal, refreshNonce, onSelect, onRootChange, onOpenChanges }: {
  documentId: string; root: string; changes: WorkspaceFileChange[]; activePath: string | null;
  reveal: { path: string; id: number } | null; refreshNonce: number;
  onSelect: (absolutePath: string) => void; onRootChange: (path: string) => void; onOpenChanges: (scope: string) => void;
}) {
  const cache = cacheFor(documentId);
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const [filter, setFilter] = useState('');
  const container = useRef<HTMLDivElement>(null), pending = useRef(new Set<string>());
  const base = root.replace(/\/$/, '');
  const load = useCallback(async (dir: string, force = false) => {
    if (!force && (cache.dirs.has(dir) || pending.current.has(dir))) return;
    pending.current.add(dir);
    try {
      cache.dirs.set(dir, (await api<{ entries: Entry[] }>(`/api/files?document=${encodeURIComponent(documentId)}&dir=${encodeURIComponent(dir)}`)).entries);
      cache.errors.delete(dir);
    } catch (reason) { cache.errors.set(dir, errorText(reason)); }
    pending.current.delete(dir); bump();
  }, [cache, documentId]);
  const { byFile, byDir, total } = useMemo(() => {
    const byFile = new Map<string, WorkspaceFileChange>(), byDir = new Map<string, Total>(), total: Total = { files: 0, additions: 0, deletions: 0 };
    for (const change of changes) {
      byFile.set(change.path, change);
      total.files++; total.additions += change.additions; total.deletions += change.deletions;
      for (let dir = parentOf(change.path); dir.length > base.length && dir.startsWith(`${base}/`); dir = parentOf(dir)) {
        const sum = byDir.get(dir) ?? { files: 0, additions: 0, deletions: 0 };
        sum.files++; sum.additions += change.additions; sum.deletions += change.deletions; byDir.set(dir, sum);
      }
    }
    return { byFile, byDir, total };
  }, [changes, base]);
  const tokens = filter.toLowerCase().split(/\s+/).filter(Boolean);
  // Filtering opens only folders already loaded; it must never trigger a recursive scan.
  const isOpen = (path: string) => tokens.length > 0 ? cache.dirs.has(path) : cache.choices.get(path) ?? byDir.has(path);
  const toLoad: string[] = [];
  let shown = 0;
  function rows(dir: string, depth: number): ReactNode[] {
    const entries = cache.dirs.get(dir);
    if (!entries) {
      const failure = cache.errors.get(dir);
      if (!failure) toLoad.push(dir);
      return [failure
        ? <div key={`${dir}:error`} className="files-empty" role="alert" style={{ paddingLeft: 8 + depth * 14 }}>{failure} <button className="ft-link" onClick={() => { cache.errors.delete(dir); void load(dir, true); bump(); }}>Retry</button></div>
        : <div key={`${dir}:loading`} className="files-empty" role="status" style={{ paddingLeft: 8 + depth * 14 }}>Loading…</div>];
    }
    return entries.flatMap(entry => {
      const rel = entry.path.slice(base.length + 1), padding = 8 + depth * 14;
      if (entry.type === 'file') {
        if (tokens.length && !tokens.every(token => rel.toLowerCase().includes(token))) return [];
        shown++;
        const change = byFile.get(entry.path), mark = change && marks[change.status];
        return [<button key={entry.path} data-path={entry.path} className={`file-tree-item w-full text-left${entry.path === activePath ? ' active' : ''}`} style={{ paddingLeft: padding + 15 }} title={rel} onClick={() => onSelect(entry.path)}>
          <FileIcon /><span className="truncate flex-1 min-w-0">{entry.name}</span>
          {change && <span className="ml-auto flex flex-shrink-0 items-center gap-1.5 text-[10px]">
            <Counts additions={change.additions} deletions={change.deletions} />
            {mark && <span className={`font-semibold ${mark.className}`} title={change.oldPath ? `Renamed from ${change.oldPath}` : mark.title}>{mark.label}</span>}
          </span>}
        </button>];
      }
      const open = isOpen(entry.path), children = open ? rows(entry.path, depth + 1) : [], sum = byDir.get(entry.path);
      if (tokens.length && !children.length && !tokens.every(token => rel.toLowerCase().includes(token))) return [];
      shown++;
      return [<div key={entry.path} data-path={entry.path} className="file-tree-folder ft-folder text-[11px] text-muted-foreground" style={{ paddingLeft: padding }}>
        <button className="ft-toggle" aria-expanded={open} title={rel} disabled={tokens.length > 0} onClick={() => { cache.choices.set(entry.path, !open); bump(); }}>
          <Chevron open={open} /><FolderIcon /><span className="truncate">{entry.name}</span>
        </button>
        {sum && <button className="ft-counts" aria-label={`${sum.files} changed ${sum.files === 1 ? 'file' : 'files'} in ${entry.name}`} title="Show changed files in this folder" onClick={() => onOpenChanges(entry.path)}>
          <Counts additions={sum.additions} deletions={sum.deletions} />
        </button>}
      </div>, ...children];
    });
  }
  const content = rows(root, 0);
  useEffect(() => { for (const dir of new Set(toLoad)) void load(dir); });
  useEffect(() => {
    // Explicit refresh re-reads every listing already loaded and keeps what is expanded.
    if (refreshNonce) for (const dir of cache.dirs.keys()) void load(dir, true);
  }, [refreshNonce]);
  useEffect(() => {
    // Keyed by request identity, so a remounted panel does not replay an old reveal.
    if (!reveal || cache.revealed === reveal || !reveal.path.startsWith(`${base}/`)) return;
    cache.revealed = reveal;
    const dirs: string[] = [];
    for (let dir = parentOf(reveal.path); dir.length > base.length; dir = parentOf(dir)) dirs.unshift(dir);
    for (const dir of dirs) cache.choices.set(dir, true);
    setFilter('');
    void Promise.all([root, ...dirs].map(dir => load(dir))).then(() => {
      bump();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (cache.revealed !== reveal) return;
        const row = [...(container.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find(node => node.dataset.path === reveal.path);
        if (!row) return;
        row.scrollIntoView({ block: 'center' }); row.focus({ preventScroll: true });
        row.classList.add('file-annotation-flash'); setTimeout(() => row.classList.remove('file-annotation-flash'), 1300);
      }));
    });
  }, [reveal]);
  return (
    <div className="ft" ref={container}>
      {total.files > 0 && <button className="file-tree-status-summary ft-summary" title="Show changed files" onClick={() => onOpenChanges(root)}>
        <span>{total.files} changed</span><span className="ft-summary-counts"><Counts additions={total.additions} deletions={total.deletions} /></span>
      </button>}
      <div className="ft-filter"><input type="search" aria-label="Filter files" placeholder="Filter" autoComplete="off" spellCheck={false} value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && filter) { event.stopPropagation(); setFilter(''); } }} /></div>
      <div className="py-1 px-1">
        {root !== '/' && tokens.length === 0 && <button className="file-tree-item w-full text-left" aria-label="Go to parent folder" title={parentOf(root)} style={{ paddingLeft: 8 + 15 }} onClick={() => onRootChange(parentOf(root))}><FolderIcon /><span>..</span></button>}
        {content}
        {tokens.length > 0 && !shown && cache.dirs.has(root) && <p className="files-empty">No loaded files match. Folders that are not expanded are not searched.</p>}
        {tokens.length === 0 && cache.dirs.get(root)?.length === 0 && <p className="files-empty">No previewable files in this folder.</p>}
      </div>
    </div>
  );
}
