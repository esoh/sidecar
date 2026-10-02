import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, open, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { agentCall, appStatus, ownerDirectory, parseOwner, readRuntime, selectOwner, watchClaude } from './agent.ts';
import { isObject, isOwner, ownerKey } from './store.ts';
import { startServer } from './server.ts';
import { readAppVersion } from './version.ts';
const cliPath = fileURLToPath(import.meta.url);
const tsx = import.meta.resolve('tsx');
async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); }
}
async function acquireLock(directory: string): Promise<(() => Promise<void>) | null> {
  const lock = join(directory, 'owner.lock'), reclaim = join(directory, 'reclaim.lock');
  async function create() {
    const file = await open(lock, 'wx', 0o600);
    try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
    return async () => { if (Number(await readFile(lock, 'utf8').catch(() => '0')) === process.pid) await rm(lock, { force: true }); };
  }
  try { return await create(); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const pid = Number(await readFile(lock, 'utf8').catch(() => '0'));
  if (isAlive(pid)) return null;
  // Serialize stale-lock recovery. A crashed recovery fails closed until this tiny marker is removed.
  try { await mkdir(reclaim, { mode: 0o700 }); } catch { return null; }
  try {
    const current = Number(await readFile(lock, 'utf8').catch(() => '0'));
    if (isAlive(current)) return null;
    await rm(lock, { force: true });
    try { return await create(); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return null;
      throw error;
    }
  } finally { await rm(reclaim, { recursive: true, force: true }); }
}
async function serve(key: string) {
  const directory = ownerDirectory(key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireLock(directory);
  if (!release) return;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const previous = await readRuntime(key).catch(() => undefined);
    const port = previous ? Number(new URL(previous.url).port) : 0;
    try { server = await startServer({ owner: parseOwner(key), directory, port }); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) throw error;
      server = await startServer({ owner: parseOwner(key), directory });
    }
    const runtime = { url: server.url, instanceId: server.instanceId, ownerKey: key };
    const temporary = join(directory, `runtime-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(runtime), { mode: 0o600 });
    await rename(temporary, join(directory, 'runtime.json'));
    const stop = () => { void server?.close(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    await server.done;
  } finally { await server?.close(); await release(); }
}
async function ensureApp(key: string): Promise<void> {
  if ((await appStatus(key)).state === 'running') return;
  const directory = ownerDirectory(key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await open(join(directory, 'server.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['--import', tsx, cliPath, 'serve', '--owner', key], { detached: true, stdio: ['ignore', log.fd, log.fd], shell: false });
  child.unref(); await log.close();
  for (let i = 0; i < 100; i++) {
    if ((await appStatus(key)).state === 'running') return;
    await delay(100);
  }
  throw new Error(`Sidecar did not start; inspect ${join(directory, 'server.log')} and owner.lock. No agent was restarted.`);
}
async function openBrowser(url: string) {
  const program = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(program, [url], { stdio: 'ignore', shell: false });
  await new Promise<void>((resolveOpen, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolveOpen() : reject(new Error(`Browser opener exited ${code}`))); });
}
export async function forwardHook(agent: string | undefined, payload: unknown): Promise<void> {
  if (!isObject(payload)) throw new Error('Expected native hook JSON');
  const owner = { agent, sessionId: payload.session_id };
  if (!isOwner(owner)) throw new Error('Expected hook agent and native session UUID');
  if (payload.agent_id) return; // Subagent hooks must not overwrite the original agent's activity.
  if (agent === 'claude' && payload.hook_event_name === 'MessageDisplay') {
    await agentCall(ownerKey(owner), '/agent/stream-events', { ownerKey: ownerKey(owner), messageId: payload.message_id, turnId: payload.turn_id, index: payload.index, delta: payload.delta, final: payload.final }).catch(() => {});
    return;
  }
  const events = new Map([
    ['UserPromptSubmit', 'agent-busy'], ['PreToolUse', 'agent-busy'], ['PostToolUse', 'agent-busy'], ['PostToolUseFailure', 'agent-busy'],
    ['Stop', 'agent-idle'], ['PermissionRequest', 'agent-waiting'], ['SessionEnd', 'agent-disconnected'], ['SessionStart', 'agent-unknown'],
    ['PreCompact', 'compaction-started'], ['PostCompact', 'compaction-completed'],
  ]);
  if (agent === 'codex') events.set('Interrupt', 'interrupted');
  else events.set('StopFailure', 'agent-idle');
  const notification = agent === 'claude' && payload.hook_event_name === 'Notification' ? payload.notification_type : undefined;
  const event = ['idle_prompt', 'agent_completed'].includes(String(notification)) ? 'agent-idle'
    : ['permission_prompt', 'agent_needs_input'].includes(String(notification)) ? 'agent-waiting'
    : typeof payload.hook_event_name === 'string' ? events.get(payload.hook_event_name) : undefined;
  if (!event) return;
  const key = ownerKey(owner);
  if ((await appStatus(key)).state !== 'running') return;
  await agentCall(key, '/agent/lifecycle', { ownerKey: key, event, ...(typeof payload.turn_id === 'string' ? { turnId: payload.turn_id } : {}) }).catch(error => {
    // Hooks do not start or block on an app that stopped between status and delivery.
    process.stderr.write(`Sidecar lifecycle delivery unavailable: ${error instanceof Error ? error.message : 'connection closed'}\n`);
  });
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, agent: { type: 'string' }, session: { type: 'string' }, owner: { type: 'string' }, file: { type: 'string' }, title: { type: 'string' }, document: { type: 'string' }, thread: { type: 'string' }, stdin: { type: 'boolean' }, resume: { type: 'boolean' }, error: { type: 'boolean' }, 'no-browser': { type: 'boolean' }, stream: { type: 'boolean' } } });
  if (values.version) {
    process.stdout.write(`${await readAppVersion()}\n`);
    return;
  }
  if (values.help || !positionals.length) {
    process.stdout.write('Sidecar — document conversations with your existing agent.\n\nUsage: sidecar COMMAND [options]\nCommands: open, browse, status, request, name-thread, stream, reply, watch, stop, hook\n\nOpen: sidecar open --agent codex|claude --session UUID --file /absolute/document.md\nUse the Sidecar skill in the original agent to establish live delivery.\n');
    return;
  }
  const [command, requestId] = positionals;
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  if (command === 'hook') {
    const payload = JSON.parse(await stdin());
    await forwardHook(values.agent, payload);
    if (values.agent === 'codex' && payload.hook_event_name === 'Stop') output({});
    return;
  }
  if (command === 'browse') {
    const nativeKinds = [process.env.CODEX_THREAD_ID && 'codex', (process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID) && 'claude'].filter(Boolean);
    const owner = selectOwner(values.agent ?? (nativeKinds.length === 1 ? nativeKinds[0] : undefined), values.session);
    const key = ownerKey(owner);
    await ensureApp(key);
    const runtime = await readRuntime(key), url = `${runtime.url}/?library=1`;
    output({ ownerKey: key, url });
    if (!values['no-browser']) await openBrowser(url);
    return;
  }
  if (command === 'open') {
    if (Boolean(values.file) === Boolean(values.stdin)) throw new Error('Choose exactly one of --file or --stdin');
    const owner = selectOwner(values.agent, values.session), key = ownerKey(owner);
    await ensureApp(key);
    let path = values.file ? resolve(values.file) : '';
    if (values.stdin) { path = join(ownerDirectory(key), `generated-${randomUUID()}.md`); await writeFile(path, await stdin(), { mode: 0o600, flag: 'wx' }); }
    const document = await agentCall(key, '/agent/documents', { path, title: values.title, generated: Boolean(values.stdin) });
    const runtime = await readRuntime(key), url = `${runtime.url}/?document=${document.id}`;
    output({ ownerKey: key, documentId: document.id, url });
    if (!values['no-browser']) await openBrowser(url);
    return;
  }
  if (!values.owner) throw new Error('Provide --owner KEY');
  const key = ownerKey(parseOwner(values.owner));
  if (command === 'serve') { await serve(key); return; }
  if (command === 'status') { output(await appStatus(key)); return; }
  if (command === 'stop') {
    if ((await appStatus(key)).state === 'running') {
      await agentCall(key, '/agent/stop', {});
      for (let i = 0; i < 100; i++) {
        const lockPid = Number(await readFile(join(ownerDirectory(key), 'owner.lock'), 'utf8').catch(() => '0'));
        if ((await appStatus(key)).state !== 'running' && (!lockPid || !isAlive(lockPid))) break;
        await delay(25);
      }
    }
    output(await appStatus(key)); return;
  }
  if (command === 'watch') {
    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
    await watchClaude(key, abort.signal); return;
  }
  if (command === 'request' && requestId) {
    const result = await agentCall(key, `/agent/requests/${encodeURIComponent(requestId)}/claim`, { resume: Boolean(values.resume) });
    if (values.stream && result.claimStatus === 'claimed') {
      const { documentId, threadId } = result.request;
      try { result.stream = await agentCall(key, '/agent/streams', { requestId, documentId, threadId }); }
      // The claim succeeded; retain its context so the agent can send a complete reply.
      catch (error) { result.stream = { error: error instanceof Error ? error.message : 'Streaming unavailable' }; }
    }
    output(result); return;
  }
  if (command === 'name-thread' && requestId) { output(await agentCall(key, `/agent/threads/${encodeURIComponent(requestId)}/title`, { title: values.title })); return; }
  if (command === 'stream' && requestId) { output(await agentCall(key, '/agent/streams', { requestId, documentId: values.document, threadId: values.thread })); return; }
  if (command === 'reply' && requestId) {
    output(await agentCall(key, '/agent/replies', { requestId, documentId: values.document, threadId: values.thread, ...(values.stream ? { stream: true } : { text: await stdin() }), isError: Boolean(values.error) })); return;
  }
  throw new Error('Commands: open, browse, status, request, name-thread, stream, reply, watch, stop, hook');
}
if (process.argv[1] && resolve(process.argv[1]) === cliPath) {
  main().catch(error => { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; });
}
