import { useEffect } from 'react';
import { FileBrowser } from '@plannotator/ui/components/sidebar/FileBrowser';
import { setFileTreeBackend, useFileBrowser } from '@plannotator/ui/hooks/useFileBrowser';

// Plannotator's file browser (MIT) over Sidecar's document-scoped listing; see THIRD_PARTY_NOTICES.md.
export function FilesPanel({ documentId, root, activePath, onSelect }: {
  documentId: string; root: string; activePath: string | null; onSelect: (relativePath: string) => void;
}) {
  const browser = useFileBrowser();
  const { fetchAll, fetchTree } = browser;
  useEffect(() => {
    // The server ignores the browser's directory and lists the document's stored workspace.
    setFileTreeBackend({
      loadTree: () => fetch(`/api/files?document=${encodeURIComponent(documentId)}`),
      loadVaultTree: async () => Response.json({ error: 'Vaults are unavailable' }, { status: 404 }),
      watchTrees: () => undefined,
    });
    fetchAll([root]);
  }, [documentId, root, fetchAll]);
  const dir = browser.dirs[0];
  const isEmpty = !!dir && !dir.isLoading && !dir.error && dir.tree.length === 0;
  return (
    <aside className="files-panel" id="files-panel" aria-label="Files">
      <div className="files-panel-header">
        <span>Files</span>
        <button aria-label="Refresh files" title="Refresh files" onClick={() => fetchTree(root)}>Refresh</button>
      </div>
      {isEmpty ? (
        <p className="files-empty">No previewable files in this workspace.</p>
      ) : (
        <FileBrowser
          dirs={browser.dirs}
          expandedFolders={browser.expandedFolders}
          onToggleFolder={browser.toggleFolder}
          collapsedDirs={browser.collapsedDirs}
          onToggleCollapse={browser.toggleCollapse}
          onSelectFile={(absolutePath) => onSelect(absolutePath.slice(root.length + 1))}
          activeFile={activePath ? `${root}/${activePath}` : null}
          onFetchAll={() => fetchAll([root])}
        />
      )}
    </aside>
  );
}
