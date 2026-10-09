import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from './api.ts';
import type { WorkspaceComparison, WorkspaceFileChange, WorkspaceStatusResult } from '../src/workspace-status.ts';

export type { WorkspaceComparison, WorkspaceFileChange, WorkspaceStatusResult };
export type CompareMode = 'uncommitted' | 'base';
export type Comparison = {
  mode: CompareMode; base: string | undefined; status: WorkspaceStatusResult | null; isLoading: boolean; error: string;
  /** Changes whenever status was re-read; file windows refetch their diff on it. */
  revision: number;
  refresh: (remote?: boolean) => void; setMode: (mode: CompareMode) => void; setBase: (name: string | null) => Promise<void>;
};

const storageKey = (documentId: string) => `sidecar-compare:${documentId}`;
// Last status per document, mode and base: a remounted explorer shows it while the next read is in flight.
const statuses = new Map<string, WorkspaceStatusResult>();
const statusKey = (documentId: string, mode: CompareMode, base?: string) => `${documentId}|${mode}|${base ?? ''}`;

export function useComparison(documentId: string, workspace: string | undefined, baseBranch: string | undefined, enabled: boolean): Comparison {
  const [stored, setStored] = useState<CompareMode | null>(() => {
    try { const value = localStorage.getItem(storageKey(documentId)); return value === 'base' || value === 'uncommitted' ? value : null; } catch { return null; }
  });
  const [localBase, setLocalBase] = useState<string | null | undefined>(undefined);
  useEffect(() => { setLocalBase(undefined); }, [baseBranch, documentId]);
  const base = (localBase === undefined ? baseBranch : localBase) ?? undefined;
  const mode: CompareMode = stored ?? (base ? 'base' : 'uncommitted');
  const key = statusKey(documentId, mode, mode === 'base' ? base : undefined);
  const [status, setStatus] = useState<WorkspaceStatusResult | null>(() => statuses.get(key) ?? null);
  const [isLoading, setLoading] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [request, setRequest] = useState({ id: 0, remote: false });
  const visit = useRef(0);
  useEffect(() => {
    setStatus(statuses.get(key) ?? null); setError('');
    if (!enabled || !workspace || (mode === 'base' && !base)) { setLoading(false); return; }
    const mine = ++visit.current;
    setLoading(true);
    const query = `document=${encodeURIComponent(documentId)}&directory=${encodeURIComponent(workspace)}&mode=${mode}${mode === 'base' ? `&base=${encodeURIComponent(base!)}` : ''}${request.remote && mode === 'base' ? '&fetch=1' : ''}`;
    api<WorkspaceStatusResult>(`/api/files/status?${query}`).then(result => {
      if (mine !== visit.current) return;
      statuses.set(key, result); setStatus(result); setRevision(value => value + 1);
    }, reason => { if (mine === visit.current) setError(errorText(reason)); })
      .finally(() => { if (mine === visit.current) setLoading(false); });
  }, [documentId, workspace, key, enabled, request]);
  const refresh = useCallback((remote = true) => setRequest(previous => ({ id: previous.id + 1, remote })), []);
  const setMode = useCallback((value: CompareMode) => {
    setStored(value);
    try { localStorage.setItem(storageKey(documentId), value); } catch { /* per-browser convenience only */ }
  }, [documentId]);
  const setBase = useCallback(async (name: string | null) => {
    await api(`/api/documents/${documentId}/base`, { baseBranch: name });
    setLocalBase(name);
  }, [documentId]);
  // Stable identity: memoized panels and windows re-render only when the comparison itself changes.
  return useMemo(() => ({ mode, base, status, isLoading, error, revision, refresh, setMode, setBase }), [mode, base, status, isLoading, error, revision, refresh, setMode, setBase]);
}
