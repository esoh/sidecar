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
  let server = await startServer({ owner, directory, pollMs });
  let cookie = '';
  const token = (await readFile(join(directory, 'agent-token'), 'utf8')).trim();
  async function login() {
    if (root) await writeFile(join(directory, 'runtime.json'), JSON.stringify({ url: server.url, instanceId: server.instanceId, ownerKey: ownerKey(owner) }));
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
    async reopen() { await server.close(); server = await startServer({ owner, directory, pollMs }); await login(); },
  };
}
