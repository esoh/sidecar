import { ensureGateway, serveGateway, gatewayStatus, stopGateway, gatewayCall } from './gateway-client.ts';
import { openAgentIds, isAgentAlias, type IdKind } from './agent-ids.ts';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, open, rename, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { agentCall, appStatus, ownerDirectory, parseOwner, readRuntime, selectOwner, watchClaude, stateDirectory } from './agent.ts';
import { isObject, isOwner, ownerKey } from './store.ts';
import { acquireLock, isAlive } from './owner-lock.ts';
import { startServer } from './server.ts';
import { readAppVersion } from './version.ts';
import { readTunnelConfig } from './tunnel-config.ts';
const cliPath = fileURLToPath(import.meta.url);
const tsx = import.meta.resolve('tsx');
// Capture the opening workspace, including linked worktrees and generated documents.
export async function repositoryInfo(cwd = process.cwd()) {
  const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd, timeout: 2000 })).stdout.trim();
  try {
    const common = await git('rev-parse', '--path-format=absolute', '--git-common-dir');
    const display = basename(common) === '.git' ? basename(dirname(common)) : basename(common).replace(/\.git$/, '');
    const branch = await git('symbolic-ref', '--short', 'HEAD').catch(() => '');
    return { display, ...(branch ? { branch } : {}) };
  } catch { return undefined; }
}
// The browsed root: the worktree the agent declares, else the Git top-level of its working directory.
export async function workspaceMetadata(explicit?: string, cwd = process.cwd()) {
  let workspace: string | undefined;
  if (explicit) workspace = await realpath(resolve(cwd, explicit));
  else {
    const topLevel = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 2000 }).then(result => result.stdout.trim(), () => '');
    if (topLevel) workspace = await realpath(topLevel);
  }
  const repoInfo = await repositoryInfo(workspace ?? cwd);
  return { ...(workspace ? { workspace } : {}), ...(repoInfo ? { repoInfo } : {}) };
}
async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
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
    try { server = await startServer({ owner: parseOwner(key), directory, stateRoot: dirname(directory), port }); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) throw error;
      server = await startServer({ owner: parseOwner(key), directory, stateRoot: dirname(directory) });
    }
    const runtime = { url: server.url, instanceId: server.instanceId, ownerKey: key, ownerAlias: server.ownerAlias };
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
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, agent: { type: 'string' }, session: { type: 'string' }, owner: { type: 'string' }, file: { type: 'string' }, title: { type: 'string' }, workspace: { type: 'string' }, 'base-branch': { type: 'string' }, document: { type: 'string' }, thread: { type: 'string' }, stdin: { type: 'boolean' }, resume: { type: 'boolean' }, error: { type: 'boolean' }, 'no-browser': { type: 'boolean' }, stream: { type: 'boolean' }, 'public-url': { type: 'string' } } });
  if (values.version) {
    process.stdout.write(`${await readAppVersion()}\n`);
    return;
  }
  if (values.help || !positionals.length) {
    process.stdout.write('Sidecar — document conversations with your existing agent.\n\nUsage: sidecar COMMAND [options]\nCommands: open, browse, status, gateway, config, network, cloudflare, request, name-thread, stream, reply, watch, stop, hook\n\nOpen: sidecar open --agent codex|claude --session UUID --file /absolute/document.md [--workspace /absolute/worktree] [--base-branch NAME]\nConfig: sidecar config (read machine-local tunnel preferences)\nGateway: sidecar gateway status|stop\nNetwork: sidecar network [on|off] [--public-url https://sidecar.example.com]\nCloudflare: sidecar cloudflare (start/reuse configured protected tunnel)\nUse the Sidecar skill in the original agent to establish live delivery.\n');
    return;
  }
  const [command, inputId] = positionals;
  let requestId: string | undefined = inputId;
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  if (command === 'config') { output(await readTunnelConfig()); return; }
  if (command === 'hook') {
    const payload = JSON.parse(await stdin());
    await forwardHook(values.agent, payload);
    if (values.agent === 'codex' && payload.hook_event_name === 'Stop') output({});
    return;
  }
  if (command === 'gateway-serve') { await serveGateway(); return; }
  if (command === 'gateway') {
    if (inputId === 'stop') output(await stopGateway());
    else if (inputId === undefined || inputId === 'status') output(await gatewayStatus());
    else throw new Error('Use gateway status|stop');
    return;
  }
  if (command === 'browse') {
    const gateway = await ensureGateway(), url = `${gateway.url}/`;
    output({ url });
    if (!values['no-browser']) await openBrowser(url);
    return;
  }
  if (command === 'open') {
    if (Boolean(values.file) === Boolean(values.stdin)) throw new Error('Choose exactly one of --file or --stdin');
    const owner = selectOwner(values.agent, values.session), key = ownerKey(owner);
    await ensureApp(key);
    let path = values.file ? resolve(values.file) : '';
    if (values.stdin) { path = join(ownerDirectory(key), `generated-${randomUUID()}.md`); await writeFile(path, await stdin(), { mode: 0o600, flag: 'wx' }); }
    const document = await agentCall(key, '/agent/documents', { path, title: values.title, generated: Boolean(values.stdin), ...(values['base-branch'] ? { baseBranch: values['base-branch'] } : {}), ...(await workspaceMetadata(values.workspace)) });
    const gateway = await ensureGateway();
    const ids = await openAgentIds(dirname(ownerDirectory(key)));
    await ids.allocate(key, [{ kind: 'd', id: document.id }]);
    const url = `${gateway.url}/a/${ids.encode(key, 'o', key)}/?document=${document.id}`;
    output({ ownerKey: ids.encode(key, 'o', key), nativeOwnerKey: key, documentId: ids.encode(key, 'd', document.id), url });
    if (!values['no-browser']) await openBrowser(url);
    return;
  }
  if (command === 'network') {
    if (requestId !== undefined && requestId !== 'on' && requestId !== 'off') throw new Error('Use network [on|off]');
    if (values['public-url'] !== undefined && requestId !== 'on') throw new Error('--public-url requires network on');
    await ensureGateway();
    output(await gatewayCall('/gateway/network', requestId === undefined ? undefined : { enabled: requestId === 'on', ...(values['public-url'] === undefined ? {} : { publicUrl: values['public-url'] }) }));
    return;
  }
  if (command === 'cloudflare') {
    const { tunnel } = await readTunnelConfig();
    if (tunnel.provider !== 'cloudflare') throw new Error('This command requires tunnel.provider to be cloudflare in Sidecar config');
    const runtime = await ensureGateway(), network = await gatewayCall('/gateway/network');
    if (!network.enabled || !/^http:\/\/127\.0\.0\.1:\d+$/.test(network.tunnelTarget ?? ''))
      throw new Error('Enable the protected listener with sidecar network on first');
    const configPath = await realpath(tunnel.configPath);
    const isInCheckout = await promisify(execFile)('git', ['-C', dirname(configPath), 'rev-parse', '--show-toplevel'], { timeout: 2000 }).then(() => true, () => false);
    if (isInCheckout) throw new Error('Keep the shared Cloudflare config outside Git checkouts (for example ~/.cloudflared/shared.yml) so worktree cleanup cannot stop its connector');
    const helper = fileURLToPath(new URL('../scripts/cloudflare-tunnel.mjs', import.meta.url));
    const result = await promisify(execFile)(process.execPath, [helper, '--config', configPath, '--public-url', tunnel.publicUrl, '--target', network.tunnelTarget], { maxBuffer: 65536 });
    const current = await gatewayCall('/gateway/network');
    if ((await gatewayStatus()).instanceId !== runtime.instanceId || current.tunnelTarget !== network.tunnelTarget)
      throw new Error('Sidecar restarted or network access changed. Recheck the protected target before reconnecting the tunnel. The shared connector was left running.');
    await gatewayCall('/gateway/network', { enabled: true, publicUrl: tunnel.publicUrl, expectedTunnelTarget: network.tunnelTarget, expectedInstanceId: runtime.instanceId });
    output({ ...JSON.parse(result.stdout), publicUrl: tunnel.publicUrl }); return;
  }
  if (!values.owner) throw new Error('Provide --owner KEY');
  const ownerIsAlias = isAgentAlias(values.owner, 'o');
  const root = stateDirectory();
  const aliases = ownerIsAlias || [requestId, values.document, values.thread].some(value => value && /^[rdt][1-9A-Z][0-9A-Z]*$/.test(value)) ? await openAgentIds(root) : undefined;
  const key = ownerKey(parseOwner(ownerIsAlias && aliases ? await aliases.resolveOwner(values.owner) : values.owner));
  const resolveId = async (kind: IdKind, value?: string) => value && aliases && isAgentAlias(value, kind) ? aliases.resolve(key, kind, value) : value;
  if (command && ['request', 'name-thread', 'stream', 'reply'].includes(command)) requestId = await resolveId(command === 'name-thread' ? 't' : 'r', requestId);
  values.document = await resolveId('d', values.document); values.thread = await resolveId('t', values.thread);
  const call = (path: string, body?: unknown) => agentCall(key, path, body, true);
  if (command === 'serve') { await serve(key); return; }
  if (command === 'status') { const status = await appStatus(key); if (ownerIsAlias) { status.ownerKey = values.owner; delete status.instanceId; } output(status); return; }
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
    const result = await call(`/agent/requests/${encodeURIComponent(requestId)}/claim`, { resume: Boolean(values.resume) });
    if (values.stream && result.claimStatus === 'claimed') {
      const { documentId, threadId } = result.request;
      try { result.stream = await call('/agent/streams', { requestId, documentId, threadId }); }
      // The claim succeeded; retain its context so the agent can send a complete reply.
      catch (error) { result.stream = { error: error instanceof Error ? error.message : 'Streaming unavailable' }; }
    }
    output(result); return;
  }
  if (command === 'name-thread' && requestId) { output(await call(`/agent/threads/${encodeURIComponent(requestId)}/title`, { title: values.title })); return; }
  if (command === 'stream' && requestId) { output(await call('/agent/streams', { requestId, documentId: values.document, threadId: values.thread })); return; }
  if (command === 'reply' && requestId) {
    output(await call('/agent/replies', { requestId, documentId: values.document, threadId: values.thread, ...(values.stream ? { stream: true } : { text: await stdin() }), isError: Boolean(values.error) })); return;
  }
  throw new Error('Commands: open, browse, status, gateway, config, network, cloudflare, request, name-thread, stream, reply, watch, stop, hook');
}
if (process.argv[1] && resolve(process.argv[1]) === cliPath) {
  main().catch(error => { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; });
}
