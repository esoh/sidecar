import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { api, errorText } from './api.ts';
import { Icon } from './conversations.tsx';
import { FileTree } from './FileTree.tsx';
import type { Comparison } from './useComparison.ts';

// Own lazy explorer over Sidecar's document-scoped listing; row styling follows Plannotator's file
// browser (MIT), see THIRD_PARTY_NOTICES.md. Draft edits in the viewer must not re-render the tree.
const comparisonErrors: Record<string, string> = {
  'base-not-found': 'The base branch was not found locally or on origin.',
  'no-merge-base': 'HEAD and the base branch share no history.',
  'invalid-base-branch': 'That is not a valid branch name.',
  'not-a-git-repo': 'This workspace is not a Git repository.',
};
function age(time: number) {
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  return seconds < 60 ? 'just now' : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : seconds < 86400 ? `${Math.round(seconds / 3600)} h ago` : `${Math.round(seconds / 86400)} d ago`;
}

function Popover({ anchor, label, onClose, children }: { anchor: RefObject<HTMLElement | null>; label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (event: PointerEvent) => { if (event.target instanceof Node && !box.current?.contains(event.target) && !anchor.current?.contains(event.target)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); anchor.current?.focus(); } };
    document.addEventListener('pointerdown', down); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key, true); };
  }, [anchor, onClose]);
  return <div className="files-popover" role="dialog" aria-label={label} ref={box}>{children}</div>;
}

function ModePopover({ documentId, workspace, comparison, anchor, onClose }: { documentId: string; workspace: string; comparison: Comparison; anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  const { mode, base, status } = comparison, info = status?.comparison;
  const [draft, setDraft] = useState(base ?? ''), [branches, setBranches] = useState<string[]>([]), [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    api<{ branches: string[] }>(`/api/files/branches?document=${encodeURIComponent(documentId)}&directory=${encodeURIComponent(workspace)}`)
      .then(result => { if (!stopped) setBranches(result.branches); }, () => undefined);
    return () => { stopped = true; };
  }, [documentId, workspace]);
  async function save() {
    const name = draft.trim();
    if (!name || name === base) return;
    try { setError(''); await comparison.setBase(name); comparison.setMode('base'); } catch (reason) { setError(errorText(reason)); }
  }
  return <Popover anchor={anchor} label="Comparison" onClose={onClose}>
    <fieldset className="files-modes">
      <legend>Compare working tree with</legend>
      <label><input type="radio" name="compare-mode" checked={mode === 'uncommitted'} onChange={() => comparison.setMode('uncommitted')} />Uncommitted changes (HEAD)</label>
      <label><input type="radio" name="compare-mode" checked={mode === 'base'} onChange={() => comparison.setMode('base')} />Base branch</label>
    </fieldset>
    <form className="files-base" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>Base branch<input aria-label="Base branch" list={`branches-${documentId}`} value={draft} spellCheck={false} autoComplete="off" onChange={event => setDraft(event.target.value)} /></label>
      <datalist id={`branches-${documentId}`}>{branches.map(name => <option key={name} value={name} />)}</datalist>
      <button type="submit" disabled={!draft.trim() || draft.trim() === base}>Set</button>
    </form>
    {error && <p role="alert" className="files-popover-note is-error">{error}</p>}
    {mode === 'base' && info && <div className="files-popover-note">
      {info.commit && <p>Compared with {info.ref ?? base} at <code>{info.commit.slice(0, 7)}</code></p>}
      {!!info.behind && <p>{info.behind} base {info.behind === 1 ? 'commit' : 'commits'} not incorporated</p>}
      {info.remoteCheckedAt ? <p>Remote checked {age(info.remoteCheckedAt)}</p> : <p>Remote not checked yet</p>}
      {info.remoteError && <p className="is-error">Remote check failed: {info.remoteError}</p>}
      {info.error && <p className="is-error">{comparisonErrors[info.error] ?? info.error}</p>}
    </div>}
    {mode === 'base' && <button className="files-popover-action" onClick={() => { comparison.refresh(true); onClose(); }}>Fetch {base ?? 'base'} and refresh</button>}
  </Popover>;
}

function RootPopover({ root, workspace, anchor, onRootChange, onClose }: { root: string; workspace: string; anchor: RefObject<HTMLElement | null>; onRootChange: (path: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(root);
  return <Popover anchor={anchor} label="Visible root" onClose={onClose}>
    <form className="files-base" onSubmit={event => { event.preventDefault(); onRootChange(draft.trim()); onClose(); }}>
      <input aria-label="Visible root" autoFocus value={draft} spellCheck={false} onChange={event => setDraft(event.target.value)} />
      <button type="submit">Open</button>
    </form>
    <button className="files-popover-action" disabled={root === workspace} onClick={() => { onRootChange(workspace); onClose(); }}>Reset to workspace root</button>
  </Popover>;
}

export const FilesPanel = memo(function FilesPanel({ documentId, root, workspace, activePath, reveal, comparison, onSelect, onRootChange, onOpenChanges }: {
  documentId: string; root: string; workspace: string; activePath: string | null;
  reveal: { path: string; id: number } | null; comparison: Comparison;
  onSelect: (absolutePath: string) => void; onRootChange: (path: string, revealPath?: string) => void; onOpenChanges: (scope: string) => void;
}) {
  const [popover, setPopover] = useState<'mode' | 'root' | null>(null), [refreshNonce, setRefreshNonce] = useState(0);
  const chip = useRef<HTMLButtonElement>(null), rootButton = useRef<HTMLButtonElement>(null);
  const { mode, base, status } = comparison;
  const prefix = `${root.replace(/\/$/, '')}/`;
  const changes = useMemo(() => status?.available ? Object.values(status.files).filter(change => change.path.startsWith(prefix)) : [], [status, prefix]);
  const closePopover = useMemo(() => () => setPopover(null), []);
  const needsBase = mode === 'base' && !base;
  return (
    <aside className="files-panel" id="files-panel" aria-label="Files">
      <div className="files-navigation">
        <div className="files-panel-header">
          <span>Files</span>
          <button ref={chip} className="files-chip" aria-haspopup="dialog" aria-expanded={popover === 'mode'} title="Choose what to compare" onClick={() => setPopover(popover === 'mode' ? null : 'mode')}>
            {mode === 'uncommitted' ? 'Uncommitted' : base ? `vs ${base}` : 'Choose base'} ▾
          </button>
          <button className="files-icon-button" aria-label="Refresh files" title="Refresh files" aria-busy={comparison.isLoading} onClick={() => { setRefreshNonce(value => value + 1); comparison.refresh(true); }}><Icon name="refresh" /></button>
        </div>
        <button ref={rootButton} className="files-root-path" title={root} aria-label="Change visible root" aria-haspopup="dialog" aria-expanded={popover === 'root'} onClick={() => setPopover(popover === 'root' ? null : 'root')}><span>{root}</span></button>
        {popover === 'mode' && <ModePopover documentId={documentId} workspace={workspace} comparison={comparison} anchor={chip} onClose={closePopover} />}
        {popover === 'root' && <RootPopover root={root} workspace={workspace} anchor={rootButton} onRootChange={onRootChange} onClose={closePopover} />}
      </div>
      {needsBase && <p className="files-empty">Choose a base branch to see changes.</p>}
      {comparison.error && <p className="files-empty" role="alert">{comparison.error}</p>}
      {status && !status.available && status.error && status.error !== 'not-a-git-repo' && !needsBase && <p className="files-empty">Changes unavailable: {status.error}</p>}
      {status?.comparison.error && <p className="files-empty" role="alert">{comparisonErrors[status.comparison.error] ?? status.comparison.error}</p>}
      <div className="files-tree">
        <FileTree key={documentId} documentId={documentId} root={root} changes={changes} activePath={activePath} reveal={reveal} refreshNonce={refreshNonce} onSelect={onSelect} onRootChange={onRootChange} onOpenChanges={onOpenChanges} />
      </div>
    </aside>
  );
});
