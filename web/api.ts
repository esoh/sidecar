import type { DocumentRecord, State } from '../src/store.ts';

export type { ClosedDocument } from '../src/library.ts';

export type ViewerState = Omit<State, 'documents'> & ViewerRuntime & {
  appVersion: string;
  documents: Record<string, DocumentRecord & { title: string; version: string | null; error: string | null }>;
};
export type ViewerRuntime = {
  stateRevision: number;
  runtimeRevision: number;
  activity: 'unknown' | 'busy' | 'idle' | 'waiting' | 'disconnected' | 'compacting';
  connectionError: string | null;
  reset?: { status: 'checking' | 'interrupting' | 'done' | 'failed'; error?: string } | null;
  stream: { requestId: string; threadId: string; text: string; progressMessageId?: string; error: string | null; turnId?: string; canStop?: boolean; stopping?: boolean; stopError?: string } | null;
};
// History may lag the live stream. Keep its visible text until the replacement is
// saved, but allow an append to the same reply during unrelated history refreshes.
export function mergeRuntime(state: ViewerState, runtime: ViewerRuntime): ViewerState {
  const before = state.stream, after = runtime.stream;
  const canReplace = state.stateRevision === runtime.stateRevision || !before ||
    (before.progressMessageId && state.threads[before.threadId]?.messages.some(message => message.id === before.progressMessageId)) ||
    ['completed', 'failed', 'stopped'].includes(state.requests[before.requestId]?.status) ||
    (after?.requestId === before.requestId && after.text.startsWith(before.text));
  return { ...state, ...runtime, stateRevision: state.stateRevision, stream: canReplace ? after : before };
}
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
