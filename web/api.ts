import type { DocumentRecord, State } from '../src/store.ts';

export type ClosedDocument = { documentId: string; threadIds: string[]; nextDocumentId: string | null; cleanupError?: string };

export type ViewerState = Omit<State, 'documents'> & {
  appVersion: string;
  documents: Record<string, DocumentRecord & { title: string; version: string | null; error: string | null }>;
  activity: 'unknown' | 'busy' | 'idle' | 'waiting' | 'disconnected' | 'compacting';
  connectionError: string | null;
  stream: { requestId: string; threadId: string; text: string; error: string | null; turnId?: string; canStop?: boolean; stopping?: boolean; stopError?: string } | null;
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
