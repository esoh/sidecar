import assert from 'node:assert/strict';
import { test } from 'node:test';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { get } from 'node:http';
import { fixture } from './support.ts';

const hasLan = Object.values(networkInterfaces()).flat().some(address => address?.family === 'IPv4' && !address.internal);
async function unlock(url: string, passphrase: string) {
  return fetch(url + '/', { method: 'POST', redirect: 'manual', headers: { Origin: url, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ passphrase }) });
}

test('LAN access is opt-in, shares the viewer, preserves local transport, and stops independently', { skip: !hasLan }, async t => {
  const f = await fixture(t), doc = await f.register();
  const local = await (await f.view('/api/network')).json();
  assert.deepEqual(local, { enabled: false, urls: [], isLocal: true, passphrase: null });
  assert.equal((await f.view('/api/network', { enabled: 'yes' })).status, 400);
  const enabled = await f.view('/api/network', { enabled: true });
  assert.equal(enabled.status, 200);
  const network = await enabled.json(), url = network.urls[0];
  assert.equal(network.enabled, true); assert.ok(url && !url.includes('127.0.0.1'));
  const home = await fetch(url);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('set-cookie'), null); assert.match(await home.text(), /Passphrase/);
  assert.equal((await unlock(url, 'incorrect')).status, 401);
  const login = await unlock(url, network.passphrase); assert.equal(login.status, 303);
  assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=34560000/);
  assert.equal((await stat(join(f.directory, 'network-auth.json'))).mode & 0o777, 0o600);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const phone = (path: string, body?: unknown) => fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await (await phone('/api/network')).json()).isLocal, false);
  assert.equal((await (await phone('/api/network')).json()).passphrase, undefined);
  assert.equal((await fetch(f.url + '/api/network', { headers: { Cookie: cookie } })).status, 403);
  const request = await (await phone('/api/questions', { documentId: doc.id, text: 'From my phone', clientMessageId: 'phone' })).json();
  assert.equal((await f.agent(`/agent/requests/${request.id}/claim`, {})).status, 200);
  const events = new AbortController(); t.after(async () => events.abort());
  const stream = await fetch(url + '/api/events', { headers: { Cookie: cookie }, signal: events.signal });
  const reader = stream.body!.getReader(); await reader.read();
  const next = reader.read();
  assert.equal((await f.agent('/agent/replies', { requestId: request.id, documentId: doc.id, threadId: request.threadId, text: 'Same attached agent' })).status, 200);
  assert.match(new TextDecoder().decode((await next).value), /event: change/);
  assert.equal((await (await phone('/api/state')).json()).threads[request.threadId].messages.at(-1).text, 'Same attached agent');

  assert.equal((await fetch(url + '/api/state')).status, 401);
  // Node fetch replaces Host; raw HTTP exercises the server's rebinding guard.
  const badHost = await new Promise(resolve => get(url, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }));
  assert.equal(badHost, 403);
  assert.equal((await fetch(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(url + '/api/questions', { method: 'POST', headers: { Cookie: cookie, Origin: f.url }, body: '{}' })).status, 403);
  assert.equal((await fetch(url + '/api/questions', { method: 'POST', headers: { Cookie: cookie }, body: '{}' })).status, 403);
  assert.equal((await fetch(url + '/agent/status', { headers: { 'X-Sidecar-Token': f.token } })).status, 403);
  assert.equal((await phone('/api/network', { enabled: false })).status, 403);

  const pending = await (await phone('/api/questions', { documentId: doc.id, threadId: request.threadId, text: 'Keep this queued', clientMessageId: 'queued' })).json();
  await f.agent(`/agent/requests/${pending.id}/claim`, {});
  const route = { requestId: pending.id, documentId: doc.id, threadId: request.threadId };
  const markers = await (await f.agent('/agent/streams', route)).json();
  const event = { ownerKey: `claude-${f.owner.sessionId}`, messageId: 'lan-reply', turnId: 'lan-turn' };
  await f.agent('/agent/stream-events', { ...event, index: 0, delta: markers.prefix + 'Still working', final: false });
  const instance = await (await f.agent('/agent/status')).json();
  assert.equal((await f.view('/api/network', { enabled: false })).status, 200);
  await assert.rejects(fetch(url));
  assert.equal((await (await f.agent('/agent/status')).json()).instanceId, instance.instanceId);
  const active = await (await f.view('/api/state')).json();
  assert.equal(active.requests[pending.id].status, 'claimed'); assert.equal(active.stream.text, 'Still working');
  await f.agent('/agent/stream-events', { ...event, index: 1, delta: markers.suffix, final: true });
  assert.equal((await (await f.view('/api/state')).json()).requests[pending.id].status, 'completed');
  const again = await (await f.view('/api/network', { enabled: true })).json();
  await f.reopen();
  await assert.rejects(fetch(again.urls[0]));
  assert.deepEqual(await (await f.view('/api/network')).json(), local);
  const restored = await (await f.view('/api/network', { enabled: true })).json();
  assert.equal(restored.passphrase, network.passphrase);
  assert.equal((await fetch(restored.urls[0] + '/api/state', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await f.view('/api/network', { enabled: true, passphrase: 'short' })).status, 400);
  assert.equal((await f.view('/api/network', { enabled: true, passphrase: 'my new home phrase' })).status, 200);
  assert.equal((await fetch(restored.urls[0] + '/api/state', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await unlock(restored.urls[0], network.passphrase)).status, 401);
  assert.equal((await unlock(restored.urls[0], 'my new home phrase')).status, 303);
});

test('network login requires its own origin and throttles incorrect passphrases', { skip: !hasLan }, async t => {
  const f = await fixture(t);
  const { urls: [url], passphrase } = await (await f.view('/api/network', { enabled: true })).json();
  for (const origin of [undefined, 'https://foreign.example', f.url]) {
    const response = await fetch(url + '/', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(origin ? { Origin: origin } : {}) }, body: new URLSearchParams({ passphrase }) });
    assert.equal(response.status, 403); assert.equal(response.headers.get('set-cookie'), null);
  }
  for (let i = 0; i < 10; i++) assert.equal((await unlock(url, 'wrong')).status, 401);
  const limited = await unlock(url, passphrase);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(limited.headers.get('set-cookie'), null);
  // The local viewer remains usable even if someone exhausts the network login budget.
  assert.equal((await f.view('/api/state')).status, 200);
  await f.view('/api/network', { enabled: true, passphrase: 'a changed home passphrase' });
  assert.equal((await unlock(url, 'a changed home passphrase')).status, 303);
});

test('LAN library links use this viewer and preview other owners instead of phone localhost', { skip: !hasLan }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-lan-library-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const f = await fixture(t, 20, root), other = await fixture(t, 20, root);
  await f.register(); await other.register();
  const enabled = await f.view('/api/network', { enabled: true }); assert.equal(enabled.status, 200);
  const { urls: [url], passphrase } = await enabled.json();
  const login = await unlock(url, passphrase), cookie = login.headers.get('set-cookie')!.split(';')[0];
  const library = await (await fetch(url + '/api/library', { headers: { Cookie: cookie } })).json();
  assert.equal(library.sessions.find((s: any) => s.owner.sessionId === f.owner.sessionId).url, url);
  assert.equal(library.sessions.find((s: any) => s.owner.sessionId === other.owner.sessionId).url, null);
  const desktop = await (await f.view('/api/library')).json();
  assert.equal(desktop.sessions.find((s: any) => s.owner.sessionId === other.owner.sessionId).url, other.url);
});
