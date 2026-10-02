import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { appStatus, parseOwner, readRuntime } from './agent.ts';
import { readDocument } from './documents.ts';
import { DomainError, get, isState, ownerKey, type Owner } from './store.ts';

export type LibraryDocument = { id: string; title: string; path: string; updatedAt: number; lastOpenedAt: number | null; threadCount: number };
export type LibrarySession = { owner: Owner; ownerKey: string; url: string | null; documents: LibraryDocument[] };
export type LibraryState = { sessions: LibrarySession[]; unavailable: number };

export async function readLibrarySession(root: string, key: string) {
  const owner = parseOwner(key);
  const state: unknown = JSON.parse(await readFile(join(root, ownerKey(owner), 'state.json'), 'utf8'));
  if (!isState(state) || ownerKey(state.owner) !== ownerKey(owner)) throw new DomainError('Saved Sidecar session is unavailable', 404);
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
export async function listLibrary(root: string): Promise<LibraryState> {
  let unavailable = 0;
  const entries = await readdir(root, { withFileTypes: true });
  const sessions = await Promise.all(entries.filter(entry => entry.isDirectory() && /^(codex|claude)-[0-9a-f-]{36}$/.test(entry.name)).map(async entry => {
    try {
      const state = await readLibrarySession(root, entry.name);
      if (!Object.keys(state.documents).length) return null;
      const directory = join(root, entry.name);
      const status = await appStatus(entry.name, directory);
      const url = status.state === 'running' ? (await readRuntime(entry.name, directory)).url : null;
      const documents = await Promise.all(Object.values(state.documents).map(async document => {
        const threads = Object.values(state.threads).filter(thread => thread.documentId === document.id);
        const title = document.userTitle ?? document.providedTitle ?? (await readDocument(document.path).catch(() => null))?.heading ?? basename(document.path);
        const lastOpenedAt = await stat(join(directory, 'opened', document.id)).then(stat => stat.mtimeMs).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        return { id: document.id, title, lastOpenedAt, path: document.path, threadCount: threads.length, updatedAt: Math.max(0, ...threads.map(thread => thread.messages.at(-1)?.createdAt ?? thread.createdAt ?? 0)) };
      }));
      return { owner: state.owner, ownerKey: entry.name, url, documents: documents.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.updatedAt - a.updatedAt) };
    } catch { unavailable++; return null; }
  }));
  return { sessions: sessions.filter((session): session is LibrarySession => session !== null).sort((a, b) => (b.documents[0].lastOpenedAt ?? 0) - (a.documents[0].lastOpenedAt ?? 0) || b.documents[0].updatedAt - a.documents[0].updatedAt), unavailable };
}
