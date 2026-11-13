import type { OpenFile } from './FilePreview.tsx';
import { viewerPath } from './viewer-path.ts';

// Per-tab "what I was looking at" (sessionStorage, like Run scripts): a refresh restores it, a new tab starts clean.
// Everything is a request, not trust: blocked storage or malformed JSON reads as nothing, and the server still authorizes each file.
export const viewKey = (documentId: string, part: string) => `sidecar-view:${viewerPath('/')}:${documentId}:${part}`;
export function readView(key: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
export function writeView(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Blocked storage: today's behavior. */ } }
export const isFinite_ = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const clamp = (value: unknown, min: number, max: number, fallback: number) => isFinite_(value) ? Math.max(min, Math.min(max, value)) : fallback;
// Trailing-edge save for scroll/drag bursts; flush() (pagehide) writes only what is still pending.
export function debouncedSave(save: () => void, ms = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return { run: () => { clearTimeout(timer); timer = setTimeout(() => { timer = undefined; save(); }, ms); }, flush: () => { if (timer === undefined) return; clearTimeout(timer); timer = undefined; save(); }, cancel: () => { clearTimeout(timer); timer = undefined; } };
}

export function restoreOpenFile(value: unknown): OpenFile | null {
  const v = typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
  if (!v || typeof v.path !== 'string' || typeof v.root !== 'string' || !v.path || !v.root || v.path.length > 4096 || v.root.length > 4096 || (v.kind !== 'doc' && v.kind !== 'code')) return null;
  const range = typeof v.lineRange === 'object' && v.lineRange !== null ? v.lineRange as Record<string, unknown> : null;
  const lineRange = range && isFinite_(range.start) && isFinite_(range.end) && range.start >= 1 && range.end >= range.start ? { start: Math.floor(range.start), end: Math.floor(range.end) } : undefined;
  return {
    id: `file:${v.root.replace(/\/$/, '')}/${v.path}`, path: v.path, root: v.root, kind: v.kind, lineRange,
    fragment: typeof v.fragment === 'string' && v.fragment.length <= 2048 ? v.fragment : undefined,
    isLineRangeVisible: v.isLineRangeVisible !== false, areScriptsEnabled: v.areScriptsEnabled === true,
    revision: isFinite_(v.revision) && v.revision >= 1 ? Math.floor(v.revision) : 1,
  };
}
