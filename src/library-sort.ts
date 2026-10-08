import type { LibraryDocument, LibrarySession } from './library.ts';
export type LibrarySort = 'opened' | 'activity';
type Times = { lastOpenedAt: number | null; updatedAt: number };
const idOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function compare(a: Times, b: Times, sort: LibrarySort) {
  const opened = (b.lastOpenedAt ?? -1) - (a.lastOpenedAt ?? -1), activity = b.updatedAt - a.updatedAt;
  return sort === 'activity' ? activity || opened : opened || activity;
}
export function sessionTimes(session: LibrarySession): Times {
  const opened = session.documents.flatMap(doc => doc.lastOpenedAt === null ? [] : [doc.lastOpenedAt]);
  return { lastOpenedAt: opened.length ? Math.max(...opened) : null, updatedAt: Math.max(0, ...session.documents.map(doc => doc.updatedAt)) };
}
export function sortDocuments(documents: LibraryDocument[], sort: LibrarySort) {
  return [...documents].sort((a, b) => compare(a, b, sort) || idOrder(a.id, b.id));
}
export function sortSessions(sessions: LibrarySession[], sort: LibrarySort) {
  const times = new Map(sessions.map(session => [session, sessionTimes(session)]));
  return [...sessions].sort((a, b) => Number(!a.documents.length) - Number(!b.documents.length) || compare(times.get(a)!, times.get(b)!, sort) || idOrder(a.ownerKey, b.ownerKey));
}
