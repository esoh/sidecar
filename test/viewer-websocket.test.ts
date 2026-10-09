import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createConnection, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createViewerHost } from '../src/viewer-http.ts';
import { setupGateway } from './gateway-support.ts';

function connect(url: string, path: string, headers: Record<string, string>) {
  return new WebSocket(url.replace(/^http/, 'ws') + path, { headers, handshakeTimeout: 2000 });
}
async function rejected(url: string, path: string, headers: Record<string, string>) {
  const socket = connect(url, path, headers);
  return new Promise<number>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('unexpected-response', (_req, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
    socket.on('open', () => { socket.terminate(); reject(new Error('Unauthorized websocket opened')); });
  });
}
async function login(target: string, path: string, headers: Record<string, string>, passphrase: string) {
  return new Promise<string>((resolve, reject) => {
    const req = request(target + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } }, res => {
      res.resume(); assert.equal(res.statusCode, 303); resolve(res.headers['set-cookie']![0].split(';')[0]);
    }); req.on('error', reject); req.end(new URLSearchParams({ passphrase }).toString());
  });
}

test('viewer WebSockets stream only their owner events and close when that owner restarts', async t => {
  const f = await setupGateway(t), [a, b] = f.owners;
  const headers = { Cookie: f.cookie, Origin: f.gateway.url };
  const socket = connect(f.gateway.url, `/a/${b.alias}/api/events?updates=1`, headers);
  t.after(() => socket.terminate());
  let received = ''; socket.on('message', data => { received += data.toString(); });
  await once(socket, 'open');
  await a.agentCall('/agent/control', { ownerKey: a.key, turnId: 'sibling', event: 'poll', activity: 'busy' });
  await b.agentCall('/agent/control', { ownerKey: b.key, turnId: 'chosen', event: 'poll', activity: 'busy' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(received, /event: runtime/);
  assert.match(received, /chosen/); assert.doesNotMatch(received, /sibling|Own document/);
  const closed = once(socket, 'close'); await b.restart(); await closed;
  const reopened = connect(f.gateway.url, `/a/${b.alias}/api/events?updates=1`, headers);
  t.after(() => reopened.terminate()); await once(reopened, 'open');
});

test('viewer WebSocket upgrades require the viewer cookie, same origin and an exact event route', async t => {
  const f = await setupGateway(t), base = `/a/${f.owners[0].alias}`;
  const headers = { Cookie: f.cookie, Origin: f.gateway.url };
  assert.equal(await rejected(f.gateway.url, base + '/api/events?updates=1', { Origin: f.gateway.url }), 403);
  assert.equal(await rejected(f.gateway.url, base + '/api/events?updates=1', { Cookie: f.cookie }), 403);
  assert.equal(await rejected(f.gateway.url, base + '/api/events?updates=1', { ...headers, Origin: 'https://evil.example' }), 403);
  assert.equal(await rejected(f.gateway.url, base + '/api/events?updates=1', { ...headers, Host: 'evil.example' }), 403);
  for (const path of ['/agent/events', base + '/agent/events', base + '/api/state', base + '/api/%65vents', base + '/api/events/extra']) {
    assert.equal(await rejected(f.gateway.url, path, headers), 404, path);
  }
});

test('a rejected upgrade releases the server socket even when the client keeps its half open', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-upgrade-rejection-'));
  let accepted: Socket | undefined;
  const host = await createViewerHost({ directory, cookieName: 'viewer', capability: 'secret', instanceId: 'test',
    handle: async (req, res) => { accepted = req.socket; res.end('ready'); },
  });
  const address = new URL(host.url), client = createConnection({ host: address.hostname, port: Number(address.port), allowHalfOpen: true });
  t.after(async () => { client.destroy(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  client.on('error', () => {});
  await once(client, 'connect');
  // Capture the accepted socket on an ordinary keep-alive request, then upgrade that same connection.
  const ready = once(client, 'data');
  client.write(`GET / HTTP/1.1\r\nHost: ${address.host}\r\nConnection: keep-alive\r\n\r\n`); await ready;
  assert.ok(accepted);
  const closed = once(accepted, 'close', { signal: AbortSignal.timeout(1000) });
  const ended = once(client, 'end');
  let response = ''; client.on('data', data => { response += data.toString(); });
  client.write(`GET /api/events HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${host.url}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
  await closed; await ended; assert.match(response, /403 Rejected/);
});

test('protected viewer WebSockets require login and rotation disconnects them without disconnecting local viewers', async t => {
  const f = await setupGateway(t), base = `/a/${f.owners[1].alias}`;
  await f.gateway.setNetworkAccess(true, 'websocket test passphrase', 'https://sidecar.example');
  const target = f.gateway.networkStatus(true).tunnelTarget!;
  const remote = { Host: 'sidecar.example', Origin: 'https://sidecar.example', 'X-Forwarded-Proto': 'https' };
  assert.equal(await rejected(target, base + '/api/events?updates=1', remote), 401);
  const cookie = await login(target, base + '/', remote, 'websocket test passphrase');
  const network = connect(target, base + '/api/events?updates=1', { ...remote, Cookie: cookie });
  const local = connect(f.gateway.url, base + '/api/events?updates=1', { Origin: f.gateway.url, Cookie: f.cookie });
  t.after(() => { network.terminate(); local.terminate(); });
  await Promise.all([once(network, 'open'), once(local, 'open')]);
  const closed = once(network, 'close');
  await f.gateway.setNetworkAccess(true, 'rotated websocket phrase'); await closed;
  assert.equal(local.readyState, WebSocket.OPEN);
  assert.equal(await rejected(target, base + '/api/events?updates=1', { ...remote, Cookie: cookie }), 401);
  assert.equal(await rejected(target, base + '/api/events?updates=1', { ...remote, Cookie: cookie, Origin: f.gateway.url }), 403);
  const nextCookie = await login(target, base + '/', remote, 'rotated websocket phrase');
  const reopened = connect(target, base + '/api/events?updates=1', { ...remote, Cookie: nextCookie });
  t.after(() => reopened.terminate()); await once(reopened, 'open');
  const disabled = once(reopened, 'close');
  await f.gateway.setNetworkAccess(false); await disabled;
  assert.equal(local.readyState, WebSocket.OPEN);
  const stopped = once(local, 'close'); await f.gateway.close(); await stopped;
});
