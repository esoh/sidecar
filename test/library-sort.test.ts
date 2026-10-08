import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sortDocuments, sortSessions } from '../src/library-sort.ts';
import type { LibraryDocument, LibrarySession } from '../src/library.ts';
const doc = (id: string, lastOpenedAt: number | null, updatedAt: number): LibraryDocument => ({ id, title: id, path: id, lastOpenedAt, updatedAt, threadCount: 0 });
const session = (id: string, documents: LibraryDocument[]): LibrarySession => ({ ownerKey: id, owner: { agent: 'claude', sessionId: id }, url: null, documents });

test('document sorts use separate timestamps and stable IDs, missing times sort last', () => {
  const docs = [doc('b', 100, 10), doc('a', 20, 200), doc('z', null, 0), doc('c', 100, 10)];
  assert.deepEqual(sortDocuments(docs, 'opened').map(d => d.id), ['b', 'c', 'a', 'z']);
  assert.deepEqual(sortDocuments(docs, 'activity').map(d => d.id), ['a', 'b', 'c', 'z']);
  assert.deepEqual(docs.map(d => d.id), ['b', 'a', 'z', 'c']);
});
test('agent activity uses independent maxima across documents rather than the first sorted item', () => {
  const agents = [session('b', [doc('recent-open', 100, 10), doc('active', 20, 200)]), session('a', [doc('both', 150, 190)]), session('0', []), session('c', [doc('none', null, 0)])];
  assert.deepEqual(sortSessions(agents, 'opened').map(s => s.ownerKey), ['a', 'b', 'c', '0']);
  assert.deepEqual(sortSessions(agents, 'activity').map(s => s.ownerKey), ['b', 'a', 'c', '0']);
  assert.deepEqual(sortSessions([session('b', []), session('a', [])], 'opened').map(s => s.ownerKey), ['a', 'b']);
});
