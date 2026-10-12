import { useMemo, useState } from 'react';
import { Counts } from './FileTree.tsx';
import { matchesCategory, type Comparison, type WorkspaceFileChange } from './useComparison.ts';

import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@plannotator/ui/components/ui/dropdown-menu';
import { Icon } from './conversations.tsx';
import { TestFileSettings } from './TestFileSettings.tsx';

const letters: Partial<Record<WorkspaceFileChange['status'], string>> = { added: 'A', untracked: 'U', deleted: 'D', renamed: 'R', conflicted: '!', copied: 'C', typechange: 'T' };

// Content of the singleton Changed files window; paths are relative to the scope it was opened for.
export function ChangedFiles({ documentId, scope, comparison, onOpenFile }: { documentId: string; scope: string; comparison: Comparison; onOpenFile: (change: WorkspaceFileChange) => void }) {
  const [isGrouped, setGrouped] = useState(false);
  const { status } = comparison, prefix = `${scope.replace(/\/$/, '')}/`;
  const changes = useMemo(() => status?.available ? Object.values(status.files).filter(change => change.path.startsWith(prefix) && matchesCategory(change, comparison.category)).sort((a, b) => a.path.localeCompare(b.path)) : [], [status, prefix, comparison.category]);
  const totals = changes.reduce((sum, change) => ({ additions: sum.additions + change.additions, deletions: sum.deletions + change.deletions }), { additions: 0, deletions: 0 });
  const list = (files: WorkspaceFileChange[], label: string) => <ul className="changed-files-list" aria-label={label}>{files.map(change => <li key={change.path}>
        <button className="file-tree-item w-full text-left" title={change.path} onClick={() => onOpenFile(change)}>
          <span className="truncate flex-1 min-w-0">{change.path.slice(prefix.length)}</span>
          <span className="ml-auto flex flex-shrink-0 items-center gap-1.5 text-[10px]">
            <Counts additions={change.additions} deletions={change.deletions} />
            <span className="font-semibold" title={change.status}>{letters[change.status] ?? ''}</span>
          </span>
        </button>
      </li>)}</ul>;
  return <div className="changed-files">
    <div className="changed-files-head">
      <div className="path-line" title={scope}><span>{scope}</span></div>
      <p className="file-tree-status-summary">
        <span>{changes.length} changed</span><span>{comparison.mode === 'base' ? `vs ${comparison.base ?? '…'}` : 'uncommitted'}</span>
        <span className="ft-summary-counts"><Counts additions={totals.additions} deletions={totals.deletions} /></span>
      </p>
      <div className="changed-files-controls">
        <DropdownMenu><DropdownMenuTrigger className="thread-filter" aria-label="Group changed files">Group by: {isGrouped ? 'Tests' : 'None'}<Icon name="chevron" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="thread-filter-menu"><DropdownMenuRadioGroup value={isGrouped ? 'tests' : 'none'} onValueChange={value => setGrouped(value === 'tests')}>
            <DropdownMenuRadioItem closeOnClick value="none">None</DropdownMenuRadioItem><DropdownMenuRadioItem closeOnClick value="tests">Tests</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup></DropdownMenuContent>
        </DropdownMenu>
        <TestFileSettings documentId={documentId} scope={scope} onSaved={() => comparison.refresh()} />
      </div>
      {status?.testRulesError && <p className="error" role="alert">{status.testRulesError} Using default test patterns.</p>}
    </div>
    {comparison.mode === 'base' && !comparison.base ? <p className="files-empty">Choose a base branch to see changes.</p>
      : !status && comparison.isLoading ? <p className="files-empty" role="status">Loading changes…</p>
      : !changes.length ? <p className="files-empty">No changed files here.</p>
      : isGrouped ? <>{[['Source & other files', false], ['Tests', true]].map(([label, isTest]) => {
        const files = changes.filter(change => !!change.isTest === isTest);
        const additions = files.reduce((sum, file) => sum + file.additions, 0), deletions = files.reduce((sum, file) => sum + file.deletions, 0);
        return <details className="changed-files-group" key={String(label)} open>
          <summary><span>{label}</span><span className="changed-files-group-count">{files.length}</span><span className="ft-summary-counts"><Counts additions={additions} deletions={deletions} /></span></summary>
          {list(files, String(label))}
        </details>;
      })}</> : list(changes, 'Changed files')}
  </div>;
}
