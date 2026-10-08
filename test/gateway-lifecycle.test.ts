import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
test('concurrent browse starts one stable gateway without any owner and restart retains shared access', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-gateway-cli-')), config = join(root, 'config.json');
  const port = await freePort(), networkPort = await freePort();
  await writeFile(config, JSON.stringify({ gateway: { port, networkPort } }));
  const env: NodeJS.ProcessEnv = { ...process.env, SIDECAR_STATE_DIR: root, SIDECAR_CONFIG: config };
  delete env.CODEX_THREAD_ID; delete env.CLAUDE_CODE_SESSION_ID; delete env.CLAUDE_SESSION_ID;
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname, ...args], { env })).stdout);
  t.after(async () => { await cli('gateway', 'stop').catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const [a, b] = await Promise.all([cli('browse', '--no-browser'), cli('browse', '--no-browser')]);
  assert.equal(a.url, `http://127.0.0.1:${port}/`); assert.equal(b.url, a.url);
  assert.equal((await readdir(root)).some(name => /^(codex|claude)-/.test(name)), false);
  const status = await cli('gateway', 'status'); assert.equal(status.state, 'running');
  const token = await readFile(join(root, 'gateway/agent-token'), 'utf8');
  const management = (path: string, body?: unknown) => fetch(a.url.slice(0, -1) + path, { method: body ? 'POST' : 'GET', headers: { 'X-Sidecar-Token': token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const enabled = await (await management('/gateway/network', { enabled: true })).json();
  assert.equal(enabled.tunnelTarget, `http://127.0.0.1:${networkPort}`);
  const login = await fetch(enabled.urls[0], { method: 'POST', redirect: 'manual', headers: { Origin: enabled.urls[0], 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ passphrase: enabled.passphrase }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  await cli('gateway', 'stop');
  assert.equal((await cli('gateway', 'status')).state, 'stopped');
  assert.equal((await cli('browse', '--no-browser')).url, a.url);
  const after = await cli('gateway', 'status'); assert.notEqual(after.instanceId, status.instanceId);
  assert.equal(after.network.enabled, true);
  assert.equal((await fetch(enabled.urls[0] + '/api/library', { headers: { Cookie: cookie } })).status, 200);
  await writeFile(config, JSON.stringify({ gateway: { port: await freePort(), networkPort } }));
  await assert.rejects(cli('browse', '--no-browser'), /configured ports changed/);
  await writeFile(config, JSON.stringify({ gateway: { port, networkPort } }));
});

test('configured gateway port conflict fails rather than silently choosing another port', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-gateway-conflict-')), path = join(root, 'config.json'), server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  await writeFile(path, JSON.stringify({ gateway: { port: address.port, networkPort: await freePort() } }));
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname, 'browse', '--no-browser'], { env: { ...process.env, SIDECAR_STATE_DIR: root, SIDECAR_CONFIG: path } }), /configured port/);
});

test('gateway config defaults are fixed and invalid or equal ports fail', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-gateway-config-')), path = join(root, 'config.json'); t.after(() => rm(root, { recursive: true, force: true }));
  const run = () => promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname, 'config'], { env: { ...process.env, SIDECAR_CONFIG: path } });
  assert.deepEqual(JSON.parse((await run()).stdout).gateway, { port: 43120, networkPort: 43121 });
  for (const gateway of [null, { port: null }, { networkPort: null }, { port: 0 }, { port: 65536 }, { port: '43120' }, { networkPort: 1.5 }, { port: 43121 }, { typo: 1 }]) {
    await writeFile(path, JSON.stringify({ gateway })); await assert.rejects(run(), /gateway/);
  }
});

test('network command targets the shared gateway regardless of optional owner argument', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-network-gateway-'));
  const path = join(root, 'config.json'), port = await freePort(), networkPort = await freePort();
  await writeFile(path, JSON.stringify({ gateway: { port, networkPort } }));
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname, ...args], { env: { ...process.env, SIDECAR_STATE_DIR: root, SIDECAR_CONFIG: path } })).stdout);
  t.after(async () => { await cli('gateway', 'stop').catch(() => {}); await rm(root, { recursive: true, force: true }); });
  assert.equal((await cli('network')).enabled, false);
  const result = await cli('network', 'on', '--owner', 'o4');
  assert.equal(result.tunnelTarget, `http://127.0.0.1:${networkPort}`);
  assert.deepEqual((await cli('network')).urls, result.urls);
  assert.equal((await readdir(root)).some(name => /^(claude|codex)-/.test(name)), false);
  await cli('network', 'off'); assert.equal((await cli('network')).enabled, false);
});
