import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownerKey } from '../src/store.ts';
import { startServer } from '../src/server.ts';

export async function fixture(t: { after: (callback: () => Promise<void>) => void }, pollMs = 20, root?: string) {
  const owner = { agent: 'claude' as const, sessionId: randomUUID() };
  const directory = root ? join(root, ownerKey(owner)) : await mkdtemp(join(tmpdir(), 'sidecar-http-'));
  let server = await startServer({ owner, directory, stateRoot: directory, pollMs });
  let cookie = '';
  const token = (await readFile(join(directory, 'agent-token'), 'utf8')).trim();
  async function login() {
    if (root) await writeFile(join(directory, 'runtime.json'), JSON.stringify({ url: server.url, instanceId: server.instanceId, ownerKey: ownerKey(owner), ownerAlias: server.ownerAlias }));
    const response = await fetch(server.url);
    const value = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(value);
    cookie = value;
  }
  await login();
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, owner, token,
    get url() { return server.url; },
    get cookie() { return cookie; },
    agent: (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(server.url + path, { method, headers: { 'X-Sidecar-Token': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    view: (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(server.url + path, { method, headers: { Cookie: cookie, Origin: server.url, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    async register(name = 'a.md', markdown = '# First heading\n\nHello **world**.\n') {
      const path = join(directory, name);
      await writeFile(path, markdown);
      const response = await this.agent('/agent/documents', { path, generated: false });
      assert.equal(response.status, 200);
      return response.json();
    },
    async reopen() { await server.close(); server = await startServer({ owner, directory, stateRoot: directory, pollMs }); await login(); },
  };
}

// Existing transport scenarios assert canonical routing; retain the actual wire
// markers while resolving aliases through the isolated registry for those checks.
export async function decodedDelivery(owner: import('../src/store.ts').Owner, root: string, event: any): Promise<any> {
  if (!['sc.request', 'sc.recovery'].includes(event.type)) return event;
  const { openAgentIds } = await import('../src/agent-ids.ts');
  const ids = await openAgentIds(root), key = ownerKey(owner), receipt = event.requestId;
  assert.equal(await ids.resolveOwner(event.ownerKey), key);
  const resolve = (kind: import('../src/agent-ids.ts').IdKind, value: string) => ids.resolve(key, kind, value);
  const quote = async (q: any) => q ? { ...q, threadId: await resolve('t', q.threadId), messageId: await resolve('m', q.messageId) } : q;
  const result = { ...event, type: event.type.replace('sc.', 'sidecar.'), ownerKey: key, requestId: await resolve('r', receipt) };
  if (event.recoveryId) result.recoveryId = await resolve('e', event.recoveryId);
  if (event.documentId) result.documentId = await resolve('d', event.documentId);
  if (event.thread) result.thread = { ...event.thread, id: await resolve('t', event.thread.id), ...(event.thread.lastRequestId ? { lastRequestId: await resolve('r', event.thread.lastRequestId) } : {}) };
  if (event.covers) result.covers = await Promise.all(event.covers.map((id: string) => resolve('r', id)));
  if (event.messageQuote) result.messageQuote = await quote(event.messageQuote);
  if (event.messages) result.messages = await Promise.all(event.messages.map(async (m: any) => ({ ...m, requestId: await resolve('r', m.requestId), ...(m.messageQuote ? { messageQuote: await quote(m.messageQuote) } : {}) })));
  if (event.text || event.messages || event.type === 'sc.recovery') result.stream = event.streamError ? { error: event.streamError } : { prefix: `[[sc:${receipt}]]\n`, suffix: `\n[[/sc:${receipt}]]`, progress: { prefix: `[[scp:${receipt}]]\n`, suffix: `\n[[/scp:${receipt}]]` } };
  delete result.streamError;
  return result;
}
