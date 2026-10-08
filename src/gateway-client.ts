import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { stateDirectory } from './agent.ts';
import { acquireLock } from './owner-lock.ts';
import { startGateway } from './gateway.ts';
import { readTunnelConfig } from './tunnel-config.ts';
import { isObject } from './store.ts';

async function runtime(root: string) {
  const value: unknown = JSON.parse(await readFile(join(root, 'gateway/runtime.json'), 'utf8'));
  if (!isObject(value) || value.kind !== 'gateway' || typeof value.instanceId !== 'string' || typeof value.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.url)) throw new Error('Invalid gateway runtime record');
  return { url: value.url, instanceId: value.instanceId };
}
export async function gatewayCall(path: string, body?: unknown, root = stateDirectory()): Promise<any> {
  const current = await runtime(root), token = (await readFile(join(root, 'gateway/agent-token'), 'utf8')).trim();
  const response = await fetch(current.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Sidecar-Token': token, 'X-Sidecar-Instance': current.instanceId, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000), redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Gateway HTTP ${response.status}`);
  if (path === '/gateway/status' && (result.instanceId !== current.instanceId || result.gatewayProtocol !== 1 || result.url !== current.url)) throw new Error('Gateway runtime identity mismatch');
  return result;
}
export async function gatewayStatus(root = stateDirectory()): Promise<any> {
  try { return await gatewayCall('/gateway/status', undefined, root); }
  catch (error) { return { state: 'stopped', error: error instanceof Error ? error.message : 'Unavailable' }; }
}
export async function serveGateway(root = stateDirectory()) {
  const { gateway: config } = await readTunnelConfig(), directory = join(root, 'gateway');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireLock(directory); if (!release) return;
  let server: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    server = await startGateway({ stateRoot: root, ...config });
    const temporary = join(directory, `runtime-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify({ kind: 'gateway', url: server.url, instanceId: server.instanceId }), { mode: 0o600 }); await rename(temporary, join(directory, 'runtime.json')); }
    finally { await rm(temporary, { force: true }); }
    const stop = () => { void server?.close(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try { await server.done; } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
  } finally { await server?.close(); await release(); }
}
export async function ensureGateway(root = stateDirectory()): Promise<{ url: string; instanceId: string }> {
  const { gateway: config } = await readTunnelConfig();
  const accept = (status: any) => {
    if (status.state !== 'running') return false;
    if (status.url !== `http://127.0.0.1:${config.port}` || status.networkPort !== config.networkPort) throw new Error('Gateway configured ports changed. Stop the gateway explicitly, then reopen it; update the tunnel target if needed.');
    return true;
  };
  const existing = await gatewayStatus(root); if (accept(existing)) return { url: existing.url, instanceId: existing.instanceId };
  const directory = join(root, 'gateway'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await open(join(directory, 'server.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./cli.ts', import.meta.url)), 'gateway-serve'], {
    cwd: root, env: { ...process.env, SIDECAR_STATE_DIR: root }, detached: true, stdio: ['ignore', log.fd, log.fd], shell: false,
  });
  let failed = false; child.on('error', () => { failed = true; }); child.unref(); await log.close();
  for (let i = 0; i < 100; i++) {
    const status = await gatewayStatus(root); if (accept(status)) return { url: status.url, instanceId: status.instanceId };
    if (failed || child.exitCode !== null && child.exitCode !== 0) break;
    await delay(100);
  }
  throw new Error(`Gateway did not start on configured port ${config.port} (protected ${config.networkPort}). Check for port conflicts and inspect ${join(directory, 'server.log')} and owner.lock. No viewer or tunnel was restarted.`);
}
export async function stopGateway(root = stateDirectory()) {
  if ((await gatewayStatus(root)).state === 'running') await gatewayCall('/gateway/stop', {}, root);
  for (let i = 0; i < 100; i++) {
    const status = await gatewayStatus(root);
    const lock = await readFile(join(root, 'gateway/owner.lock'), 'utf8').catch(() => '');
    if (status.state !== 'running' && !lock) return status;
    await delay(25);
  }
  throw new Error('Gateway has not finished stopping; inspect its runtime and owner.lock.');
}
