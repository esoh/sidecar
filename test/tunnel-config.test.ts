import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './support.ts';
import { gatewayCli } from './gateway-support.ts';

// Exercise the installed-command contract without starting an app or a tunnel.
test('config defaults to ngrok, reads Cloudflare paths, and fails closed on invalid configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json');
  const cli = () => promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname, 'config'], {
    env: { ...process.env, SIDECAR_CONFIG: path },
  });
  assert.deepEqual(JSON.parse((await cli()).stdout), { path, gateway: { port: 43120, networkPort: 43121 }, tunnel: { provider: 'ngrok' } });
  await writeFile(path, JSON.stringify({ tunnel: { provider: 'cloudflare', publicUrl: 'https://sidecar.example.com/', configPath: '~/.cloudflared/sidecar.yml' } }));
  assert.deepEqual(JSON.parse((await cli()).stdout), { path, gateway: { port: 43120, networkPort: 43121 }, tunnel: { provider: 'cloudflare', publicUrl: 'https://sidecar.example.com', configPath: join(homedir(), '.cloudflared/sidecar.yml') } });
  for (const value of [
    '{invalid-secret-text', 'null',
    JSON.stringify({ tunnel: null }),
    JSON.stringify({ tunnel: { provider: null } }),
    JSON.stringify({ tunnel: { provider: 'unknown' } }),
    JSON.stringify({ tunnel: { provider: 'cloudflare', publicUrl: 'http://sidecar.example.com', configPath: '/tmp/tunnel.yml' } }),
    JSON.stringify({ tunnel: { provider: 'cloudflare', publicUrl: 'https://sidecar.example.com/path', configPath: '/tmp/tunnel.yml' } }),
    JSON.stringify({ tunnel: { provider: 'cloudflare', publicUrl: 'https://name:secret@sidecar.example.com', configPath: '/tmp/tunnel.yml' } }),
    JSON.stringify({ tunnel: { provider: 'cloudflare', publicUrl: 'https://sidecar.example.com', configPath: 'relative.yml' } }),
    JSON.stringify({ tunnel: { provider: 'cloudflare', publicUrl: 'https://sidecar.example.com' } }),
    JSON.stringify({ tunnel: { provider: 'ngrok', autoStart: true } }),
  ]) {
    await writeFile(path, value);
    await assert.rejects(cli(), error => {
      assert.ok(error instanceof Error && 'stderr' in error);
      assert.match(String(error.stderr), /Sidecar config/);
      assert.doesNotMatch(String(error.stderr), /invalid-secret-text|name:secret/);
      return true;
    });
  }
});

test('only the local authenticated viewer reads tunnel settings; invalid config does not break network controls', async t => {
  const f = await fixture(t), path = join(f.directory, 'config.json');
  const previous = process.env.SIDECAR_CONFIG;
  process.env.SIDECAR_CONFIG = path;
  t.after(async () => { if (previous === undefined) delete process.env.SIDECAR_CONFIG; else process.env.SIDECAR_CONFIG = previous; });
  await writeFile(path, JSON.stringify({ tunnel: { provider: 'cloudflare', publicUrl: 'https://sidecar.example.com', configPath: '/private/example/tunnel.yml' } }));
  assert.equal((await fetch(f.url + '/api/tunnel-config')).status, 403);
  const response = await f.view('/api/tunnel-config');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tunnel.provider, 'cloudflare');
  assert.equal((await (await f.view('/api/network')).json()).enabled, false);
  const network = await (await f.view('/api/network', { enabled: true })).json();
  const login = await fetch(network.urls[0] + '/', { method: 'POST', redirect: 'manual', headers: { Origin: network.urls[0], 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ passphrase: network.passphrase }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  assert.equal((await fetch(network.urls[0] + '/api/tunnel-config', { headers: { Cookie: cookie } })).status, 403);
  await writeFile(path, '{broken');
  assert.equal((await f.view('/api/tunnel-config')).status, 400);
  assert.equal((await f.view('/api/network', { enabled: false })).status, 200);
});

test('Cloudflare launcher requires its provider and an already enabled protected listener', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-cloudflare-'));
  const f = await fixture(t, 20, root);
  const { gateway, configPath: path, run: cli } = await gatewayCli(t, root);
  const run = () => promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname, 'cloudflare', '--owner', `claude-${f.owner.sessionId}`], {
    env: { ...process.env, SIDECAR_STATE_DIR: root, SIDECAR_CONFIG: path },
  });
  await assert.rejects(run(), /requires tunnel.provider to be cloudflare/);
  await writeFile(path, JSON.stringify({ gateway, tunnel: { provider: 'cloudflare', publicUrl: 'https://sidecar.example.com', configPath: join(root, 'tunnel.yml') } }));
  await assert.rejects(run(), /Enable the protected listener/);
  assert.equal((await (await f.view('/api/network')).json()).enabled, false);
  const checkout = join(root, 'checkout'), configPath = join(checkout, 'cloudflare.yml');
  await mkdir(checkout);
  await promisify(execFile)('git', ['init', '--quiet', checkout]);
  await writeFile(configPath, '# local config');
  await writeFile(path, JSON.stringify({ gateway, tunnel: { provider: 'cloudflare', publicUrl: 'https://sidecar.example.com', configPath } }));
  await cli('network', 'on');
  await assert.rejects(run(), /outside Git checkouts/);
});

test('enabling a verified public origin cannot race a protected-listener change or app restart', async t => {
  const f = await fixture(t);
  const { instanceId } = await (await f.agent('/agent/status')).json();
  const { tunnelTarget } = await (await f.view('/api/network', { enabled: true })).json();
  const connect = { enabled: true, publicUrl: 'https://sidecar.example.com', expectedInstanceId: instanceId, expectedTunnelTarget: tunnelTarget };
  assert.equal((await f.agent('/agent/network', { ...connect, expectedInstanceId: 'old-instance' })).status, 409);
  assert.equal((await (await f.view('/api/network')).json()).publicUrl, null);
  await f.view('/api/network', { enabled: false });
  assert.equal((await f.agent('/agent/network', connect)).status, 409);
  assert.equal((await (await f.view('/api/network')).json()).enabled, false);
  const next = await (await f.view('/api/network', { enabled: true })).json();
  assert.equal((await f.agent('/agent/network', { ...connect, expectedTunnelTarget: next.tunnelTarget })).status, 200);
});

test('gateway CLI reuses a compatible unrelated connector and leaves it running across app restart and stale-port refusal', { skip: process.platform === 'win32' && 'POSIX executable fixture' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-shared-'));
  const f = await fixture(t, 20, root), key = `claude-${f.owner.sessionId}`;
  const { gateway, configPath: path, run: cli } = await gatewayCli(t, root);
  const network = await cli('network', 'on');
  const id = '11111111-1111-4111-8111-111111111111', connectorId = '22222222-2222-4222-8222-222222222222';
  const ingress = [{ hostname: 'sidecar.example.com', service: network.tunnelTarget }, { hostname: 'unrelated.example.com', service: 'http://127.0.0.1:8123' }, { service: 'http_status:404' }];
  const metrics = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/diag/tunnel') response.end(JSON.stringify({ tunnelID: id, connectorID: connectorId }));
    else if (request.url === '/config') response.end(JSON.stringify({ version: -1, config: { ingress } }));
    else if (request.url === '/ready') response.end('{}');
    else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise<void>(resolve => metrics.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { metrics.closeAllConnections(); metrics.close(() => resolve()); }));
  const address = metrics.address(); assert.ok(address && typeof address !== 'string');
  const configPath = join(root, 'shared.yml'), bin = join(root, 'bin');
  const original = JSON.stringify({ tunnel: id, 'credentials-file': join(root, 'credentials.json'), metrics: `127.0.0.1:${address.port}`, ingress });
  await writeFile(configPath, original); await writeFile(join(root, 'credentials.json'), '{}');
  await writeFile(path, JSON.stringify({ gateway, tunnel: { provider: 'cloudflare', publicUrl: 'https://sidecar.example.com', configPath } }));
  await mkdir(bin);
  const info = { id, conns: [{ id: connectorId, conns: [{ id: '33333333-3333-4333-8333-333333333333', is_pending_reconnect: false, colo_name: 'test', origin_ip: '127.0.0.1', opened_at: '2026-01-01T00:00:00Z' }] }] };
  await writeFile(join(bin, 'cloudflared'), `#!${process.execPath}\nif (process.argv.includes('validate')) process.exit(0); if (process.argv.includes('info')) { console.log(${JSON.stringify(JSON.stringify(info))}); process.exit(0); } process.exit(9);`, { mode: 0o755 });
  const run = () => promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname, 'cloudflare', '--owner', key], {
    env: { ...process.env, SIDECAR_STATE_DIR: root, SIDECAR_CONFIG: path, HOME: root, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(JSON.parse((await run()).stdout).status, 'reused');
  assert.equal((await cli('network')).publicUrl, 'https://sidecar.example.com');
  assert.equal(await readFile(configPath, 'utf8'), original);
  await f.reopen();
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/ready`)).status, 200);
  assert.equal((await cli('network')).tunnelTarget, network.tunnelTarget);
  assert.equal(JSON.parse((await run()).stdout).status, 'reused');
  ingress[0].service = 'http://127.0.0.1:1';
  await writeFile(configPath, JSON.stringify({ tunnel: id, 'credentials-file': join(root, 'credentials.json'), metrics: `127.0.0.1:${address.port}`, ingress }));
  const stale = await readFile(configPath, 'utf8');
  await assert.rejects(run(), /missing or stale/);
  assert.equal((await cli('network')).publicUrl, 'https://sidecar.example.com');
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/ready`)).status, 200);
  assert.equal(await readFile(configPath, 'utf8'), stale);
});
