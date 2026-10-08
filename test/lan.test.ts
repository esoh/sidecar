import assert from 'node:assert/strict';
import { gatewayCli } from './gateway-support.ts';
import { test } from 'node:test';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { get, request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from './support.ts';

const hasLan = Object.values(networkInterfaces()).flat().some(address => address?.family === 'IPv4' && !address.internal);
async function unlock(url: string, passphrase: string) {
  return fetch(url + '/', { method: 'POST', redirect: 'manual', headers: { Origin: url, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ passphrase }) });
}

test('LAN access is opt-in, shares the viewer, preserves local transport, and stops independently', { skip: !hasLan }, async t => {
  const f = await fixture(t), doc = await f.register();
  const local = await (await f.view('/api/network')).json();
  assert.deepEqual(local, { enabled: false, urls: [], publicUrl: null, isLocal: true, passphrase: null, tunnelTarget: null });
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
  assert.match(await (await fetch(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).text(), /Passphrase/);
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

// Connect to the protected listener as a reverse proxy does, preserving the public Host.
function tunneled(target: string, origin: string, path = '/', body?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const request = httpRequest(target + path, { agent: false, method: body === undefined ? 'GET' : 'POST', headers: { Host: new URL(origin).host, 'X-Forwarded-Proto': 'https', ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject); request.end(body);
  });
}

test('an explicit HTTPS tunnel keeps passphrase, origin and agent boundaries', { skip: !hasLan }, async t => {
  const f = await fixture(t), doc = await f.register(), origin = 'https://sidecar.example';
  const network = await (await f.view('/api/network', { enabled: true })).json();
  const target = network.tunnelTarget;
  assert.equal((await tunneled(target, origin)).status, 403);
  assert.equal((await f.view('/api/network', { enabled: true, publicUrl: origin })).status, 200);
  for (const proto of ['', 'http', 'https, http']) assert.equal((await tunneled(target, origin, '/', undefined, { 'X-Forwarded-Proto': proto })).status, 403);
  assert.equal((await tunneled(network.urls[0], origin)).status, 403);
  for (const site of ['cross-site', 'same-site']) {
    const linked = await tunneled(target, origin, '/', undefined, { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
    assert.equal(linked.status, 200); assert.match(linked.text, /Passphrase/);
    assert.equal((await fetch(f.url, { headers: { 'Sec-Fetch-Site': site } })).status, 403);
  }
  const home = await tunneled(target, origin);
  assert.equal(home.status, 200); assert.match(home.text, /Passphrase/); assert.equal(home.headers['set-cookie'], undefined);
  assert.equal((await tunneled(target, origin, '/api/state')).status, 401);
  assert.equal((await tunneled(target, origin, '/api/state', undefined, { Cookie: f.cookie })).status, 401);
  assert.equal((await tunneled(f.url, origin)).status, 403);
  assert.equal((await tunneled(target, 'https://other.example', '/', undefined, { 'X-Forwarded-Host': new URL(origin).host, 'X-Forwarded-Proto': 'https' })).status, 403);
  const loginBody = new URLSearchParams({ passphrase: network.passphrase }).toString();
  for (const badOrigin of ['', f.url, 'http://sidecar.example', 'https://other.example']) {
    assert.equal((await tunneled(target, origin, '/', loginBody, { 'Content-Type': 'application/x-www-form-urlencoded', ...(badOrigin ? { Origin: badOrigin } : {}) })).status, 403);
  }
  const login = await tunneled(target, origin, '/', loginBody, { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(login.status, 303);
  assert.match(login.headers['set-cookie']![0], /; Secure/);
  const cookie = login.headers['set-cookie']![0].split(';')[0];
  const view = (path: string, body?: unknown) => tunneled(target, origin, path, body === undefined ? undefined : JSON.stringify(body), { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' });
  assert.equal((await view('/api/state')).status, 200);
  const remote = JSON.parse((await view('/api/network')).text);
  assert.equal(remote.passphrase, undefined); assert.equal(remote.tunnelTarget, undefined);
  assert.equal((await view('/api/network', { enabled: false })).status, 403);
  assert.equal((await tunneled(target, origin, '/agent/network', undefined, { 'X-Sidecar-Token': f.token })).status, 403);
  assert.equal((await view('/agent/status')).status, 403);
  for (const badOrigin of ['', 'https://other.example']) {
    assert.equal((await tunneled(target, origin, '/api/questions', '{}', { Cookie: cookie, ...(badOrigin ? { Origin: badOrigin } : {}) })).status, 403);
  }
  const request = JSON.parse((await view('/api/questions', { documentId: doc.id, text: 'Through the tunnel', clientMessageId: 'tunnel' })).text);
  assert.equal((await f.agent(`/agent/requests/${request.id}/claim`, {})).status, 200);
  assert.equal((await f.agent('/agent/replies', { requestId: request.id, documentId: doc.id, threadId: request.threadId, text: 'Same agent' })).status, 200);
  assert.equal(JSON.parse((await view('/api/state')).text).threads[request.threadId].messages.at(-1).text, 'Same agent');
  // Updating only the passphrase must preserve the configured public address.
  await f.view('/api/network', { enabled: true, passphrase: 'a new tunnel passphrase' });
  assert.equal((await view('/api/state')).status, 401);
  assert.equal((await tunneled(target, origin)).status, 200);
  await f.view('/api/network', { enabled: true, publicUrl: 'https://replacement.example' });
  assert.equal((await tunneled(target, origin)).status, 403);
  assert.equal((await tunneled(target, 'https://replacement.example')).status, 200);
  await f.view('/api/network', { enabled: false });
  await assert.rejects(tunneled(target, 'https://replacement.example'));
  assert.equal((await f.view('/api/network')).status, 200);
});

test('the gateway CLI configures a tunnel without viewer cookies and rejects unsafe URLs', { skip: !hasLan }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-tunnel-cli-'));
  const f = await fixture(t, 20, root), key = `claude-${f.owner.sessionId}`;
  const { run } = await gatewayCli(t, root);
  const cli = (...args: string[]) => run('network', ...args, '--owner', key);
  assert.equal((await cli()).enabled, false);
  const enabled = await cli('on');
  assert.match(enabled.tunnelTarget, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(enabled.publicUrl, null);
  for (const publicUrl of ['http://unsafe.example', 'https://example.com/path', 'https://example.com/?query=1', 'https://example.com/#hash', 'https://user:password@example.com', 'not a url']) {
    assert.equal((await f.agent('/agent/network', { enabled: true, publicUrl })).status, 400, publicUrl);
  }
  assert.equal((await fetch(f.url + '/agent/network')).status, 403);
  const configured = await cli('on', '--public-url', 'https://sidecar.example/');
  assert.equal(configured.publicUrl, 'https://sidecar.example');
  assert.equal((await tunneled(configured.tunnelTarget, configured.publicUrl)).status, 200);
  assert.equal((await cli()).publicUrl, configured.publicUrl);
  assert.equal((await cli('on', '--public-url', '')).publicUrl, null);
  assert.equal((await tunneled(configured.tunnelTarget, configured.publicUrl)).status, 403);
  await cli('off');
  assert.equal((await cli()).tunnelTarget, null);
  assert.equal((await f.agent('/agent/status')).status, 200);
});
