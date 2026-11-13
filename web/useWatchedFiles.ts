import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeFileData, FilePreviewData } from '../src/files.ts';
import { viewerPath } from './viewer-path.ts';

export type WatchedFile = { version: string; data?: FilePreviewData; error?: string; status?: number };
type Source = { key: string; url: string; method?: 'HEAD' };

const pollMs = 3000;

// Polling is browser-owned: it stops when a tab/window closes or a file is no longer open, and a body crosses
// the tunnel only after a change (If-None-Match -> 304). No server watcher or stream protocol is involved.
export function useWatchedFiles(sources: Source[]): Record<string, WatchedFile> {
  const [watched, setWatched] = useState<Record<string, WatchedFile>>({});
  // Last answer per key (with its URL), shared across source changes so a new key never refetches the others' bodies.
  const known = useRef<Record<string, WatchedFile & { url: string }>>({});
  const json = JSON.stringify(sources);
  const stable = useMemo<Source[]>(() => JSON.parse(json), [json]);
  useEffect(() => {
    const keys = new Set(stable.map(source => source.key));
    for (const key of Object.keys(known.current)) if (!keys.has(key) || known.current[key].url !== stable.find(source => source.key === key)?.url) delete known.current[key];
    setWatched(before => Object.keys(before).every(key => key in known.current) ? before : Object.fromEntries(Object.entries(before).filter(([key]) => key in known.current)));
    if (!stable.length) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, isRunning = false, isStopped = false;
    async function check({ key, url, method }: Source): Promise<void> {
      const etag = known.current[key]?.version.startsWith('error:') ? undefined : known.current[key]?.version;
      let next: WatchedFile;
      try {
        const response = await fetch(viewerPath(url), { method, headers: etag ? { 'If-None-Match': etag } : {}, cache: 'no-store', signal: controller.signal });
        if (response.status === 304) return;
        if (!response.ok) {
          const body = method === 'HEAD' ? null : await response.json().catch(() => null) as { error?: unknown } | null;
          next = { version: `error:${response.status}`, status: response.status, error: typeof body?.error === 'string' ? body.error : `HTTP ${response.status}` };
        } else {
          next = { version: response.headers.get('ETag') ?? '' };
          if (method !== 'HEAD') {
            const loaded = await response.json() as FilePreviewData | CodeFileData;
            next.data = 'codeFile' in loaded ? { path: loaded.filepath, text: loaded.contents, renderAs: 'markdown' } : loaded;
          }
        }
      } catch { return; } // Offline or aborted: keep what is shown rather than flapping.
      if (isStopped || known.current[key]?.version === next.version) return;
      known.current[key] = { ...next, url };
      setWatched(before => ({ ...before, [key]: next }));
    }
    async function cycle() {
      clearTimeout(timer);
      if (isRunning || isStopped) return;
      if (!document.hidden) { isRunning = true; await Promise.all(stable.map(check)); isRunning = false; }
      if (!isStopped) timer = setTimeout(cycle, pollMs);
    }
    const onVisible = () => { if (!document.hidden) void cycle(); };
    document.addEventListener('visibilitychange', onVisible);
    void cycle();
    return () => { isStopped = true; clearTimeout(timer); controller.abort(); document.removeEventListener('visibilitychange', onVisible); };
  }, [stable]);
  return watched;
}
