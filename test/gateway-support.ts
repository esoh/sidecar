import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gatewayConfig } from './support.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../src/server.ts';
import { startGateway } from '../src/gateway.ts';
import { ownerKey, type Owner } from '../src/store.ts';

export async function setupGateway(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-gateway-'));
  const owners = await Promise.all((['codex', 'claude'] as const).map(async agent => {
    const owner: Owner = { agent, sessionId: randomUUID() }, key = ownerKey(owner), directory = join(root, key);
    let app = await startServer({ owner, directory, stateRoot: root, pollMs: 60000 });
    const token = await readFile(join(directory, 'agent-token'), 'utf8');
    const runtime = () => writeFile(join(directory, 'runtime.json'), JSON.stringify({ url: app.url, instanceId: app.instanceId, ownerKey: key }));
    await runtime();
    const agentCall = (path: string, body?: unknown) => fetch(app.url + path, { method: body ? 'POST' : 'GET', headers: { 'X-Sidecar-Token': token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const path = join(directory, 'review.md'); await writeFile(path, `# ${agent}\n\nOwn document.`);
    const doc = await (await agentCall('/agent/documents', { path, generated: false, workspace: directory })).json();
    return { owner, key, directory, doc, alias: app.ownerAlias, agentCall, stop: () => app.close(), async restart() { await app.close(); app = await startServer({ owner, directory, stateRoot: root, pollMs: 60000 }); await runtime(); } };
  }));
  const gateway = await startGateway({ stateRoot: root, port: 0, networkPort: 0 });
  const cookie = (await fetch(gateway.url)).headers.get('set-cookie')!.split(';')[0];
  const view = (path: string, body?: unknown, method = body ? 'POST' : 'GET') => fetch(gateway.url + path, { method, headers: { Cookie: cookie, Origin: gateway.url, 'Content-Type': 'application/json', 'X-Sidecar-Token': 'browser-cannot-choose', 'X-Forwarded-Host': 'evil.example' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  t.after(async () => { await gateway.close(); await Promise.all(owners.map(owner => owner.stop())); await rm(root, { recursive: true, force: true }); });
  return { root, owners, gateway, cookie, view };
}


export async function gatewayCli(t: { after: (callback: () => Promise<void>) => void }, root: string) {
  const configPath = await gatewayConfig(root), { gateway } = JSON.parse(await readFile(configPath, 'utf8'));
  const run = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
    ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname, ...args],
    { env: { ...process.env, SIDECAR_STATE_DIR: root, SIDECAR_CONFIG: configPath } })).stdout);
  t.after(async () => { await run('gateway', 'stop').catch(() => {}); await rm(root, { recursive: true, force: true }); });
  return { gateway, configPath, run };
}
