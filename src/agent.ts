import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError, isObject, isOwner, ownerKey, type Owner } from './store.ts';
const exec = promisify(execFile);
export function parseOwner(key: string): Owner {
  const match = /^(codex|claude)-(.+)$/.exec(key);
  const owner = { agent: match?.[1], sessionId: match?.[2] };
  if (!isOwner(owner)) throw new DomainError('Invalid owner key');
  return owner;
}
export function selectOwner(agent: string | undefined, sessionId?: string, env: NodeJS.ProcessEnv = process.env): Owner {
  if (agent !== 'codex' && agent !== 'claude') throw new DomainError('Choose --agent codex or claude');
  if (agent === 'claude' && env.CLAUDE_CODE_SESSION_ID && env.CLAUDE_SESSION_ID && env.CLAUDE_CODE_SESSION_ID.toLowerCase() !== env.CLAUDE_SESSION_ID.toLowerCase()) throw new DomainError('Claude native session variables conflict');
  const native = agent === 'codex' ? env.CODEX_THREAD_ID : env.CLAUDE_CODE_SESSION_ID ?? env.CLAUDE_SESSION_ID;
  if (native && sessionId && native.toLowerCase() !== sessionId.toLowerCase()) throw new DomainError('Explicit session conflicts with native session');
  const owner = { agent, sessionId: sessionId ?? native };
  if (!isOwner(owner)) throw new DomainError('A native session UUID is required');
  return { ...owner, sessionId: owner.sessionId.toLowerCase() };
}
export function ownerDirectory(key: string): string {
  return join(process.env.SIDECAR_STATE_DIR ?? join(homedir(), '.local/state/sidecar'), ownerKey(parseOwner(key)));
}
export type Runtime = { url: string; instanceId: string; ownerKey: string };
export async function readRuntime(key: string, directory = ownerDirectory(key)): Promise<Runtime> {
  const value: unknown = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
  if (!isObject(value) || value.ownerKey !== ownerKey(parseOwner(key)) || typeof value.url !== 'string' || typeof value.instanceId !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.url)) throw new Error('Invalid Sidecar runtime record');
  return { url: value.url, instanceId: value.instanceId, ownerKey: value.ownerKey };
}
export async function agentFetch(key: string, path: string, body?: unknown, signal?: AbortSignal, directory = ownerDirectory(key), compact = false): Promise<Response> {
  const runtime = await readRuntime(key, directory);
  const token = (await readFile(join(directory, 'agent-token'), 'utf8')).trim();
  return fetch(runtime.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Sidecar-Token': token, 'Content-Type': 'application/json', ...(compact ? { 'X-Sidecar-Protocol': 'sc1' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(5000), redirect: 'error' });
}
export async function agentCall(key: string, path: string, body?: unknown, compact = false): Promise<any> {
  const response = await agentFetch(key, path, body, undefined, undefined, compact);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Sidecar HTTP ${response.status}`);
  return result;
}
export async function appStatus(key: string, directory = ownerDirectory(key)): Promise<any> {
  try {
    const runtime = await readRuntime(key, directory);
    const response = await agentFetch(key, '/agent/status', undefined, undefined, directory);
    if (!response.ok) throw new Error(`Sidecar HTTP ${response.status}`);
    const status = await response.json();
    if (status.ownerKey !== key || status.instanceId !== runtime.instanceId) throw new Error('Runtime identity mismatch');
    return status;
  } catch (error) {
    return { ownerKey: key, state: 'stopped', error: error instanceof Error ? error.message : 'Unavailable' };
  }
}
export async function notifyCodex(owner: Owner, notification: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  if (owner.agent !== 'codex') throw new Error('Codex owner required');
  const message = JSON.stringify(notification);
  await exec('codex', ['queue', '--thread', owner.sessionId, '--message', message], { shell: false, timeout: 15000, signal, maxBuffer: 65536 });
}
export async function watchClaude(key: string, signal: AbortSignal): Promise<void> {
  if (parseOwner(key).agent !== 'claude') throw new Error('Claude owner required');
  while (!signal.aborted) {
    if ((await appStatus(key)).state !== 'running') return;
    try {
      const response = await agentFetch(key, '/agent/events', undefined, signal);
      if (!response.ok || !response.body) throw new Error(`Sidecar stream HTTP ${response.status}`);
      let buffer = '';
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (line) {
            const event: unknown = JSON.parse(line);
            if (!isObject(event) || !['sidecar.request', 'sidecar.recovery'].includes(String(event.type)) || event.ownerKey !== key || typeof event.requestId !== 'string') throw new Error('Invalid Sidecar notification');
            const isRecovery = event.type === 'sidecar.recovery';
            const path = `/agent/requests/${encodeURIComponent(event.requestId)}`;
            try {
              const prepared = await agentCall(key, `${path}/${isRecovery ? 'recover' : 'prepare'}`, isRecovery ? { recoveryId: event.recoveryId } : {}, true);
              if (!prepared.claimStatus || prepared.claimStatus === 'claimed') {
                await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(prepared) + '\n', error => error ? reject(error) : resolve()));
                await agentCall(key, `${path}/accepted`, {});
              }
            } catch (error) {
              // The output may already have reached Monitor; do not repeat it.
              if (isRecovery) await agentCall(key, `${path}/recovery-failed`, { recoveryId: event.recoveryId }).catch(() => {});
              throw error;
            }
          }
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      process.stderr.write('Sidecar stream disconnected; checking app before reconnect.\n');
    }
    if (signal.aborted || (await appStatus(key)).state !== 'running') return;
    await delay(1000, undefined, { signal }).catch(() => {});
  }
}
