import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { createViewerHost, json } from '../src/viewer-http.ts';

async function unusedPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
function tunnel(target: string, path: string, body?: string, cookie?: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request(target + path, { method: body === undefined ? 'GET' : 'POST', headers: { Host: 'sidecar.example.com', 'X-Forwarded-Proto': 'https', Origin: 'https://sidecar.example.com', 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}), ...extra } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', value => { text += value; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    }); req.on('error', reject); req.end(body);
  });
}

test('persistent viewer login survives restart and network changes, but rotation revokes it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-http-'));
  const port = await unusedPort(), networkPort = await unusedPort();
  const options = { directory, port, networkPort, persistNetwork: true, instanceId: 'test', cookieName: 'gateway', capability: 'secret', capabilityPrefix: '/gateway/',
    isPage: (path: string) => path === '/' || path === '/a/o4/',
    handle: async (_req: unknown, res: import('node:http').ServerResponse, context: { isLocal: boolean }) => { json(res, { ok: true, isLocal: context.isLocal }); } };
  let host = await createViewerHost(options);
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(host.networkStatus(true).enabled, false);
  await host.setNetworkAccess(true, 'home browser phrase', 'https://sidecar.example.com');
  const target = `http://127.0.0.1:${networkPort}`;
  assert.equal(host.networkStatus(true).tunnelTarget, target);
  assert.match((await tunnel(target, '/a/o4/?document=one')).text, /Passphrase/);
  const login = await tunnel(target, '/a/o4/?document=one', 'passphrase=home+browser+phrase');
  assert.equal(login.status, 303); assert.equal(login.headers.location, '/a/o4/?document=one');
  const cookie = login.headers['set-cookie']![0].split(';')[0]; assert.match(login.headers['set-cookie']![0], /Secure/);
  assert.equal((await tunnel(target, '/api/test', undefined, cookie, { 'X-Forwarded-For': '192.0.2.1' })).status, 200);
  await host.close(); host = await createViewerHost(options);
  assert.equal(host.networkStatus(true).enabled, true);
  const restored = await tunnel(target, '/api/test', undefined, cookie, { 'X-Forwarded-For': '198.51.100.2' });
  assert.equal(restored.status, 200); assert.equal(JSON.parse(restored.text).isLocal, false);
  assert.equal((await tunnel(target, '/api/test', '{}', cookie, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await tunnel(target, '/gateway/status', undefined, cookie, { 'X-Sidecar-Token': 'secret' })).status, 403);
  await host.setNetworkAccess(true, 'replacement phrase');
  assert.equal((await tunnel(target, '/api/test', undefined, cookie)).status, 401);
  await host.setNetworkAccess(false); await host.close(); host = await createViewerHost(options);
  assert.equal(host.networkStatus(true).enabled, false);
});
