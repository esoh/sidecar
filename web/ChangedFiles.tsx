import { useMemo } from 'react';
import { Counts } from './FileTree.tsx';
import type { Comparison, WorkspaceFileChange } from './useComparison.ts';

const letters: Partial<Record<WorkspaceFileChange['status'], string>> = { added: 'A', untracked: 'U', deleted: 'D', renamed: 'R', conflicted: '!', copied: 'C', typechange: 'T' };

// Content of the singleton Changed files window; paths are relative to the scope it was opened for.
export function ChangedFiles({ scope, comparison, onOpenFile }: { scope: string; comparison: Comparison; onOpenFile: (change: WorkspaceFileChange) => void }) {
  const { status } = comparison, prefix = `${scope.replace(/\/$/, '')}/`;
  const changes = useMemo(() => status?.available ? Object.values(status.files).filter(change => change.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path)) : [], [status, prefix]);
  const totals = changes.reduce((sum, change) => ({ additions: sum.additions + change.additions, deletions: sum.deletions + change.deletions }), { additions: 0, deletions: 0 });
  return <div className="changed-files">
    <div className="changed-files-head">
      <div className="path-line" title={scope}><span>{scope}</span></div>
      <p className="file-tree-status-summary">
        <span>{changes.length} changed</span><span>{comparison.mode === 'base' ? `vs ${comparison.base ?? '…'}` : 'uncommitted'}</span>
        <span className="ft-summary-counts"><Counts additions={totals.additions} deletions={totals.deletions} /></span>
      </p>
    </div>
    {comparison.mode === 'base' && !comparison.base ? <p className="files-empty">Choose a base branch to see changes.</p>
      : !status && comparison.isLoading ? <p className="files-empty" role="status">Loading changes…</p>
      : !changes.length ? <p className="files-empty">No changed files here.</p>
      : <ul className="changed-files-list" aria-label="Changed files">{changes.map(change => <li key={change.path}>
        <button className="file-tree-item w-full text-left" title={change.path} onClick={() => onOpenFile(change)}>
          <span className="truncate flex-1 min-w-0">{change.path.slice(prefix.length)}</span>
          <span className="ml-auto flex flex-shrink-0 items-center gap-1.5 text-[10px]">
            <Counts additions={change.additions} deletions={change.deletions} />
            <span className="font-semibold" title={change.status}>{letters[change.status] ?? ''}</span>
          </span>
        </button>
      </li>)}</ul>}
  </div>;
}
