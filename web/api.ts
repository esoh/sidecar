import type { DocumentRecord, State } from '../src/store.ts';

export type ViewerState = Omit<State, 'documents'> & {
  documents: Record<string, DocumentRecord & { title: string; version: string | null; error: string | null }>;
  activity: 'unknown' | 'busy' | 'idle' | 'waiting' | 'disconnected' | 'compacting';
  connectionError: string | null;
  stream: { threadId: string; text: string; error: string | null } | null;
};
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed: ${response.status}`);
  return result;
}
