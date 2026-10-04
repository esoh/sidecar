import { useEffect, useRef, useState } from 'react';
import { FileBrowser } from '@plannotator/ui/components/sidebar/FileBrowser';
import { setFileTreeBackend, useFileBrowser } from '@plannotator/ui/hooks/useFileBrowser';

// Plannotator's file browser (MIT) over Sidecar's document-scoped listing; see THIRD_PARTY_NOTICES.md.
export function FilesPanel({ documentId, root, workspace, activePath, reveal, onSelect, onRootChange }: {
  documentId: string; root: string; workspace: string; activePath: string | null;
  reveal: { path: string; id: number } | null;
  onSelect: (absolutePath: string) => void; onRootChange: (path: string, revealPath?: string) => void;
}) {
  const browser = useFileBrowser();
  const panel = useRef<HTMLElement>(null), revealed = useRef<number | null>(null);
  const [isEditingRoot, setEditingRoot] = useState(false), [draftRoot, setDraftRoot] = useState(root);
  const [isTruncated, setTruncated] = useState(false);
  const { fetchAll, fetchTree } = browser;
  useEffect(() => {
    setFileTreeBackend({
      loadTree: async () => {
        const response = await fetch(`/api/files?document=${encodeURIComponent(documentId)}&directory=${encodeURIComponent(root)}`);
        const data = await response.clone().json();
        setTruncated(!!data.truncated);
        return response;
      },
      loadVaultTree: async () => Response.json({ error: 'Vaults are unavailable' }, { status: 404 }),
      watchTrees: () => undefined,
    });
    fetchAll([root]);
  }, [documentId, root, fetchAll]);
  const dir = browser.dirs[0];
  useEffect(() => {
    if (!reveal || revealed.current === reveal.id || !dir || dir.isLoading || dir.error) return;
    const relativePath = reveal.path.slice(root.replace(/\/$/, '').length + 1);
    const parts = relativePath.split('/');
    let expanding = false;
    for (let i = 1; i < parts.length; i++) {
      const key = `${root}:${parts.slice(0, i).join('/')}`;
      if (!browser.expandedFolders.has(key)) { browser.toggleFolder(key); expanding = true; }
    }
    if (browser.collapsedDirs.has(root)) { browser.toggleCollapse(root); expanding = true; }
    if (expanding) return;
    const row = [...(panel.current?.querySelectorAll<HTMLButtonElement>('.file-tree-item') ?? [])].find(row => row.title === relativePath);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.focus({ preventScroll: true });
      revealed.current = reveal.id;
    } else if (isTruncated && parts.length > 1) {
      // A capped ancestor tree may omit the file; its containing folder is an exact fallback.
      onRootChange(reveal.path.slice(0, reveal.path.lastIndexOf('/')) || '/', reveal.path);
    }
  }, [reveal, root, dir, browser.expandedFolders, browser.collapsedDirs, browser.toggleFolder, browser.toggleCollapse, isTruncated]);
  const isEmpty = !!dir && !dir.isLoading && !dir.error && dir.tree.length === 0;
  return (
    <aside ref={panel} className="files-panel" id="files-panel" aria-label="Files">
      <div className="files-navigation">
      <div className="files-panel-header">
        <span>Files</span>
        <button aria-label="Refresh files" title="Refresh files" onClick={() => fetchTree(root)}>Refresh</button>
      </div>
      <div className="files-root-actions">
        <button title="Go to parent folder" aria-label="Go to parent folder" disabled={root === '/'} onClick={() => onRootChange(root.slice(0, root.lastIndexOf('/')) || '/')}>↑ Up</button>
        <button title="Reset visible root to workspace" disabled={root === workspace} onClick={() => onRootChange(workspace)}>Reset visible root</button>
      </div>
      {isEditingRoot ? <form className="files-root-form" onSubmit={event => { event.preventDefault(); onRootChange(draftRoot.trim()); setEditingRoot(false); }}>
        <input aria-label="Visible root" autoFocus value={draftRoot} onChange={event => setDraftRoot(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setEditingRoot(false); }} />
        <button type="submit">Open</button>
      </form> : <button className="files-root-path" title={root} aria-label="Change visible root" onClick={() => { setDraftRoot(root); setEditingRoot(true); }}>{root}</button>}
      </div>
      {isTruncated && <p className="files-empty">Large directory: some entries are omitted. Choose a closer root to see more.</p>}
      <div className="files-tree">
      {/* FileBrowser shows Plannotator's Settings hint until the first fetch registers the root. */}
      {!dir ? (
        <p className="files-empty" role="status">Loading files…</p>
      ) : isEmpty ? (
        <p className="files-empty">No previewable files in this workspace.</p>
      ) : (
        <FileBrowser
          key={reveal?.id ?? 0}
          dirs={browser.dirs}
          expandedFolders={browser.expandedFolders}
          onToggleFolder={browser.toggleFolder}
          collapsedDirs={browser.collapsedDirs}
          onToggleCollapse={browser.toggleCollapse}
          onSelectFile={onSelect}
          activeFile={root === '/' && activePath ? `/${activePath}` : activePath}
          onFetchAll={() => fetchAll([root])}
        />
      )}
      </div>
    </aside>
  );
}
