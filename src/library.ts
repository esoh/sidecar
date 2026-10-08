import { sortDocuments, sortSessions } from './library-sort.ts';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { agentFetch, appStatus, parseOwner, readRuntime } from './agent.ts';
import { acquireLock } from './owner-lock.ts';
import { readDocument } from './documents.ts';
import { closeDocument, DomainError, get, readSavedState, updateSavedState, ownerKey, type Owner } from './store.ts';

export type LibraryDocument = { id: string; title: string; path: string; updatedAt: number; lastOpenedAt: number | null; threadCount: number };
export type LibrarySession = { owner: Owner; ownerKey: string; ownerAlias?: string; url: string | null; documents: LibraryDocument[] };
export type LibraryState = { sessions: LibrarySession[]; unavailable: number };
export type ClosedDocument = { documentId: string; threadIds: string[]; nextDocumentId: string | null; cleanupError?: string };

export async function cleanupClosedDocument(directory: string, id: string): Promise<{ cleanupError?: string }> {
  try {
    await rm(join(directory, 'versions', id), { recursive: true, force: true });
    await rm(join(directory, 'opened', id), { force: true });
    return {};
  } catch { return { cleanupError: 'Conversations were deleted, but saved document metadata could not be completely removed from disk.' }; }
}

export async function closeLibraryDocument(root: string, key: string, id: string): Promise<ClosedDocument> {
  const owner = parseOwner(key), directory = join(root, ownerKey(owner));
  const forward = async (instanceId: string): Promise<ClosedDocument> => {
    const response = await agentFetch(key, `/agent/documents/${encodeURIComponent(id)}/close`, { instanceId }, undefined, directory);
    const result = await response.json();
    if (!response.ok) throw new DomainError(response.status === 404 ? 'The original viewer could not close this document. Refresh the list; if it is still present, update that viewer.' : result.error ?? 'The original viewer could not close this document.', response.status);
    return result;
  };
  const status = await appStatus(key, directory);
  if (status.state === 'running') return forward(status.instanceId);
  const release = await acquireLock(directory);
  if (!release) throw new DomainError('The original viewer is starting or unavailable. Retry when it is ready.', 409);
  try {
    // Recheck after taking the lock; never write behind a running viewer.
    const current = await appStatus(key, directory);
    if (current.state === 'running') return await forward(current.instanceId);
    const result = await updateSavedState(directory, owner, state => {
      const threadIds = closeDocument(state, id);
      return { documentId: id, threadIds, nextDocumentId: Object.keys(state.documents)[0] ?? null };
    });
    return { ...result, ...await cleanupClosedDocument(directory, id) };
  } finally { await release(); }
}

export async function readLibrarySession(root: string, key: string) {
  const owner = parseOwner(key);
  const state = readSavedState(JSON.parse(await readFile(join(root, ownerKey(owner), 'state.json'), 'utf8')));
  if (ownerKey(state.owner) !== ownerKey(owner)) throw new DomainError('Saved Sidecar session is unavailable', 404);
  return state;
}
export async function libraryDocument(root: string, key: string, id: string) {
  return get((await readLibrarySession(root, key)).documents, id);
}
export async function recordDocumentOpen(directory: string, id: string) {
  const opened = join(directory, 'opened');
  await mkdir(opened, { recursive: true, mode: 0o700 });
  await writeFile(join(opened, id), '', { mode: 0o600 });
}
export async function listLibrary(root: string, includeEmpty = false): Promise<LibraryState> {
  let unavailable = 0;
  const entries = await readdir(root, { withFileTypes: true });
  const sessions = await Promise.all(entries.filter(entry => entry.isDirectory() && /^(codex|claude)-[0-9a-f-]{36}$/.test(entry.name)).map(async entry => {
    try {
      const state = await readLibrarySession(root, entry.name);
      if (!includeEmpty && !Object.keys(state.documents).length) return null;
      const directory = join(root, entry.name);
      const status = await appStatus(entry.name, directory);
      const url = status.state === 'running' ? (await readRuntime(entry.name, directory)).url : null;
      const documents = await Promise.all(Object.values(state.documents).map(async document => {
        const threads = Object.values(state.threads).filter(thread => thread.documentId === document.id);
        const title = document.userTitle ?? document.providedTitle ?? (await readDocument(document.path).catch(() => null))?.heading ?? basename(document.path);
        const lastOpenedAt = await stat(join(directory, 'opened', document.id)).then(stat => stat.mtimeMs).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        return { id: document.id, title, lastOpenedAt, path: document.path, threadCount: threads.length, updatedAt: Math.max(0, ...threads.map(thread => thread.messages.at(-1)?.createdAt ?? thread.createdAt ?? 0)) };
      }));
      return { owner: state.owner, ownerKey: entry.name, url, documents: sortDocuments(documents, 'opened') };
    } catch { unavailable++; return null; }
  }));
  return { sessions: sortSessions(sessions.filter((session): session is LibrarySession => session !== null), 'opened'), unavailable };
}
