import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { basename, join, dirname, relative, isAbsolute, extname } from 'node:path';
import { notifyCodex } from './agent.ts';
import { observeCodex, readCodexActivity } from './codex-stream.ts';
import { ReplyStream, isStreamEvent } from './stream.ts';
import { readDocument } from './documents.ts';
import { claim, createThread, nameThread, DomainError, get, isObject, isQuote, openStore, ownerKey, registerDocument, reply, resolveThread, setTitle, submit, type DocumentRecord, type Owner, type SubmitInput } from './store.ts';

const rendererRequire = createRequire(import.meta.resolve('@plannotator/ui/components/BlockRenderer'));
const rendererFonts = {
  katex: rendererRequire.resolve('katex/dist/katex.min.css'),
  inter: rendererRequire.resolve('@fontsource-variable/inter/index.css'),
  geist: rendererRequire.resolve('@fontsource-variable/geist-mono/index.css'),
};

type DocumentData = Awaited<ReturnType<typeof readDocument>>;
type Cached = { data: DocumentData } | { error: string; status: number };
export type ServerOptions = { owner: Owner; directory: string; port?: number; pollMs?: number };
function errorInfo(error: unknown): { error: string; status: number } {
  if (error instanceof DomainError) return { error: error.message, status: error.status };
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { error: 'The registered file is unavailable', status: 404 };
  return { error: error instanceof Error ? error.message : 'Unexpected server error', status: 500 };
}
function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new DomainError(`Expected ${key} to be text`);
  return value;
}
function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  return body[key] === undefined ? undefined : text(body, key);
}
function boolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') throw new DomainError(`Expected ${key} to be a boolean`);
  return value;
}
async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size <= 256 * 1024) chunks.push(bytes);
  }
  if (size > 256 * 1024) throw new DomainError('Request exceeds 256 KiB', 413);
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DomainError('Invalid JSON'); }
  if (!isObject(value)) throw new DomainError('Expected a JSON object');
  return value;
}
function sameSecret(value: unknown, secret: string): boolean {
  return typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(secret) && timingSafeEqual(Buffer.from(value), Buffer.from(secret));
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
export async function startServer({ owner, directory, port = 0, pollMs = 1000 }: ServerOptions) {
  const store = await openStore(directory, owner);
  const tokenPath = join(directory, 'agent-token');
  try { await writeFile(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const agentToken = (await readFile(tokenPath, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(agentToken)) throw new Error('Invalid agent capability file');
  const viewerToken = randomBytes(32).toString('hex');
  const cookieName = `sidecar_${ownerKey(owner).replaceAll('-', '_')}`;
  const cache = new Map<string, Cached>();
  const viewers = new Set<ServerResponse>();
  const agents = new Map<ServerResponse, Set<string>>();
  let url = '';
  let closed = false;
  let refreshing = false;
  let closePromise: Promise<void> | undefined;
  const instanceId = randomUUID();
  const transportAbort = new AbortController();
  const announced = new Set<string>();
  let dispatching = false;
  let dispatchWork: Promise<void> | undefined;
  let connectionError: string | null = null;
  let compacting = false;
  let agentActivity = 'unknown';
  let activityTurnId: string | undefined;
  let stream: ReplyStream | undefined;
  let stopObserver: (() => void) | undefined;
  let streamTimer: NodeJS.Timeout | undefined;
  let finalizing: Promise<void> | undefined;
  function streamChanged() { if (!closed && !streamTimer) streamTimer = setTimeout(() => { streamTimer = undefined; changed(); }, 50); }
  async function acceptStream(event: import('./stream.ts').StreamEvent) {
    const active = stream;
    if (!active || closed) return;
    active.accept(event);
    streamChanged();
    if (active.done && !finalizing) {
      finalizing = (async () => {
        await store.update(state => reply(state, { ...active.route, text: active.text }));
        if (stream === active) { stream = undefined; stopObserver?.(); stopObserver = undefined; }
        changed();
      })();
      try { await finalizing; }
      catch { active.error = 'Could not save the streamed reply. Send a complete reply to recover.'; changed(); }
      finally { finalizing = undefined; }
    }
  }
  let lastLifecycle: { event: string; turnId?: string } | null = null;
  let finish!: () => void;
  const done = new Promise<void>(resolveDone => { finish = resolveDone; });
  function title(document: DocumentRecord): string {
    const cached = cache.get(document.id);
    return document.userTitle ?? document.providedTitle ?? (cached && 'data' in cached ? cached.data.heading : null) ?? basename(document.path);
  }
  async function refresh(document: DocumentRecord): Promise<Cached> {
    let result: Cached;
    try { result = { data: await readDocument(document.path) }; }
    catch (error) { result = errorInfo(error); }
    const previous = cache.get(document.id);
    const oldKey = previous && ('data' in previous ? previous.data.version : previous.error);
    const newKey = 'data' in result ? result.data.version : result.error;
    cache.set(document.id, result);
    if (oldKey !== newKey) changed();
    return result;
  }
  function pending() {
    const head = Object.values(store.read().requests).find(r => ['queued', 'claimed', 'uncertain'].includes(r.status));
    return head && head.status !== 'claimed' ? head : undefined;
  }
  function notifyAgent(response: ServerResponse, sent: Set<string>) {
    const request = pending();
    if (request && !sent.has(request.id) && !response.destroyed) {
      response.write(JSON.stringify({ type: 'sidecar.request', ownerKey: ownerKey(owner), requestId: request.id }) + '\n');
      sent.add(request.id);
    }
  }
  async function dispatchCodex() {
    if (closed || owner.agent !== 'codex' || dispatching) return;
    const request = pending();
    if (!request || announced.has(request.id)) return;
    dispatching = true; announced.add(request.id);
    try {
      await notifyCodex(owner, request.id, transportAbort.signal);
      await store.update(state => { get(state.requests, request.id).acceptedAt = Date.now(); });
      connectionError = null;
    } catch (error) {
      if (!closed) connectionError = 'Codex notification failed. Restart Sidecar to retry; the question is retained.';
    } finally { dispatching = false; changed(); }
  }
  function changed() {
    if (closed) return;
    for (const response of viewers) if (!response.destroyed) response.write('event: change\ndata: {}\n\n');
    for (const [response, sent] of agents) notifyAgent(response, sent);
    if (!dispatching) dispatchWork = dispatchCodex();
  }
  function snapshot() {
    const state = store.read();
    return { ...state, stream: stream?.snapshot() ?? null, lastLifecycle, activity: compacting ? 'compacting' : agentActivity, connection: connectionError ? 'error' : agents.size ? 'connected' : 'waiting', connectionError, documents: Object.fromEntries(Object.values(state.documents).map(document => {
      const cached = cache.get(document.id);
      return [document.id, { ...document, title: title(document), version: cached && 'data' in cached ? cached.data.version : null, error: cached && 'error' in cached ? cached.error : null }];
    })) };
  }
  async function documentContext(document: DocumentRecord) {
    const result = await refresh(document);
    return 'data' in result ? { id: document.id, path: document.path, title: title(document), ...result.data } : { id: document.id, path: document.path, title: title(document), error: result.error };
  }
  const server = createServer((request, response) => { void handle(request, response); });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (request.headers.host !== new URL(url).host) throw new DomainError('Invalid host', 403);
      if (request.headers.origin !== undefined && request.headers.origin !== url) throw new DomainError('Foreign origin', 403);
      const target = new URL(request.url ?? '/', url);
      if (target.origin !== url) throw new DomainError('Foreign request target', 403);
      const path = decodeURIComponent(target.pathname);
      const method = request.method ?? 'GET';
      if (method === 'GET' && path === '/') {
        if (['cross-site', 'same-site'].includes(String(request.headers['sec-fetch-site']))) throw new DomainError('Open Sidecar from the agent', 403);
        response.setHeader('Set-Cookie', `${cookieName}=${viewerToken}; HttpOnly; SameSite=Strict; Path=/`);
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        let html = '<!doctype html><html lang="en"><title>Sidecar</title><body><p>Sidecar document server is running.</p></body></html>';
        try { html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8'); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        response.end(html);
        return;
      }
      const isAgent = path.startsWith('/agent/');
      if (isAgent) {
        if (!sameSecret(request.headers['x-sidecar-token'], agentToken)) throw new DomainError('Agent capability required', 403);
      } else {
        const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
        if (!sameSecret(cookie, viewerToken)) throw new DomainError('Open Sidecar from the agent', 403);
        if (method !== 'GET' && request.headers.origin !== url) throw new DomainError('Origin required', 403);
      }
      if (method === 'GET' && path === '/app.js') {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        // ponytail: one ~18 MiB local bundle; split renderer chunks if page startup becomes a problem.
        // Bundle on load so the CLI remains the only process needed for the viewer.
        const bundle = await build({ entryPoints: [fileURLToPath(new URL('../web/app.tsx', import.meta.url))], bundle: true, write: false, minify: true, format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
        response.end(bundle.outputFiles[0].contents);
        return;
      }
      if (method === 'GET' && path === '/renderer.css') {
        response.setHeader('Content-Type', 'text/css; charset=utf-8');
        const styles = await readFile(new URL(import.meta.resolve('@plannotator/ui/styles.css')), 'utf8');
        const fonts = await Promise.all(Object.entries(rendererFonts).map(async ([family, cssPath]) =>
          (await readFile(cssPath, 'utf8')).replaceAll(/url\((?:\.\/files|fonts)\//g, `url(/renderer-fonts/${family}/`)));
        response.end([styles, ...fonts].join('\n'));
        return;
      }
      const font = path.match(/^\/renderer-fonts\/(katex|inter|geist)\/([A-Za-z0-9_-]+\.(?:woff2?|ttf))$/);
      if (method === 'GET' && font) {
        const family = font[1], name = font[2];
        if (family !== 'katex' && family !== 'inter' && family !== 'geist') throw new DomainError('Unknown font', 404);
        response.setHeader('Content-Type', name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.woff') ? 'font/woff' : 'font/ttf');
        response.end(await readFile(join(dirname(rendererFonts[family]), family === 'katex' ? 'fonts' : 'files', name)));
        return;
      }
      if (method === 'GET' && path === '/api/image') {
        const document = get(store.read().documents, target.searchParams.get('document') ?? '');
        const base = dirname(document.path);
        const imageUrl = new URL(target.searchParams.get('path') ?? '', pathToFileURL(document.path));
        if (imageUrl.protocol !== 'file:') throw new DomainError('Expected a local image', 400);
        const imagePath = await realpath(fileURLToPath(imageUrl));
        const fromBase = relative(base, imagePath);
        if (fromBase.startsWith('..') || isAbsolute(fromBase)) throw new DomainError('Image must be inside the document directory', 403);
        const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };
        const mime = types[extname(imagePath).toLowerCase()];
        if (!mime) throw new DomainError('Unsupported image type', 415);
        // SVG remains an image even if opened directly; it cannot execute or fetch resources.
        response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
        response.setHeader('Content-Type', mime);
        response.end(await readFile(imagePath));
        return;
      }
      if (method === 'GET' && path === '/app.css') {
        response.setHeader('Content-Type', 'text/css; charset=utf-8');
        response.end(await readFile(new URL('../web/app.css', import.meta.url), 'utf8'));
        return;
      }
      if (method === 'GET' && path === '/api/state') { json(response, snapshot()); return; }
      if (method === 'GET' && path.startsWith('/api/documents/')) {
        const document = get(store.read().documents, path.slice('/api/documents/'.length));
        const result = await refresh(document);
        if ('error' in result) { json(response, { error: result.error }, result.status); return; }
        json(response, { ...document, ...result.data, title: title(document) }); return;
      }
      if (method === 'GET' && (path === '/api/events' || path === '/agent/events')) {
        response.writeHead(200, { 'Content-Type': isAgent ? 'application/x-ndjson' : 'text/event-stream', Connection: 'keep-alive' });
        response.flushHeaders();
        if (isAgent) {
          const sent = new Set<string>(); agents.set(response, sent); notifyAgent(response, sent); changed();
          response.on('close', () => { agents.delete(response); changed(); });
        } else { viewers.add(response); response.write('event: change\ndata: {}\n\n'); response.on('close', () => viewers.delete(response)); }
        return;
      }
      if (method === 'GET' && path === '/agent/status') { json(response, { ownerKey: ownerKey(owner), instanceId, state: 'running', connection: connectionError ? 'error' : agents.size ? 'connected' : 'waiting', connectionError }); return; }
      if (method === 'POST' && path === '/agent/stop') { json(response, { ok: true }); setImmediate(() => { void close(); }); return; }
      const body = ['POST', 'PATCH'].includes(method) ? await bodyOf(request) : {};
      if (method === 'POST' && path === '/agent/lifecycle') {
        if (text(body, 'ownerKey') !== ownerKey(owner)) throw new DomainError('Lifecycle belongs to another owner', 409);
        const event = text(body, 'event');
        if (!['compaction-started', 'compaction-completed', 'interrupted', 'agent-busy', 'agent-idle', 'agent-waiting', 'agent-disconnected', 'agent-unknown'].includes(event) || (event === 'interrupted' && owner.agent !== 'codex')) throw new DomainError('Unsupported lifecycle event');
        const turnId = optionalText(body, 'turnId');
        if (turnId && activityTurnId && turnId !== activityTurnId && ['agent-idle', 'interrupted', 'compaction-completed'].includes(event)) {
          json(response, { ok: true }); return;
        }
        if (event === 'compaction-started') compacting = true;
        else if (event === 'compaction-completed') compacting = false;
        else {
          compacting = false;
          agentActivity = event === 'interrupted' ? 'idle' : event.slice('agent-'.length);
          if (turnId) activityTurnId = turnId;
          else if (event === 'agent-unknown' || event === 'agent-disconnected') activityTurnId = undefined;
        }
        lastLifecycle = { event, turnId };
        changed(); json(response, { ok: true }); return;
      }
      if (method === 'POST' && path === '/agent/documents') {
        const canonical = await realpath(text(body, 'path'));
        await readDocument(canonical);
        const document = await store.update(state => registerDocument(state, { path: canonical, title: optionalText(body, 'title'), generated: body.generated === undefined ? false : boolean(body, 'generated') }));
        await refresh(document); changed(); json(response, { ...document, title: title(document) }); return;
      }
      if (method === 'POST' && path === '/api/threads') {
        const input = { id: text(body, 'id'), documentId: text(body, 'documentId') };
        const thread = await store.update(state => createThread(state, input));
        changed(); json(response, thread); return;
      }
      const threadTitle = path.match(/^\/agent\/threads\/([^/]+)\/title$/);
      if (method === 'POST' && threadTitle?.[1]) {
        const id = threadTitle[1], value = text(body, 'title');
        await store.update(state => nameThread(state, id, value)); changed(); json(response, { ok: true }); return;
      }
      if (method === 'POST' && path === '/api/questions') {
        const input: SubmitInput = { documentId: text(body, 'documentId'), text: text(body, 'text'), clientMessageId: text(body, 'clientMessageId') };
        if (body.threadId !== undefined) input.threadId = text(body, 'threadId');
        if (body.quote !== undefined) { if (!isQuote(body.quote)) throw new DomainError('Invalid selection'); input.quote = body.quote; }
        const result = await store.update(state => submit(state, input));
        changed(); json(response, result); return;
      }
      const resolution = path.match(/^\/api\/threads\/([^/]+)\/resolution$/);
      if (method === 'POST' && resolution?.[1]) {
        const id = resolution[1], isResolved = boolean(body, 'isResolved');
        await store.update(state => resolveThread(state, id, isResolved)); changed(); json(response, { ok: true }); return;
      }
      const renameTitle = path.match(/^\/api\/documents\/([^/]+)\/title$/);
      if (method === 'PATCH' && renameTitle?.[1]) {
        const id = renameTitle[1], value = text(body, 'title');
        await store.update(state => setTitle(state, id, value)); changed(); json(response, { ok: true }); return;
      }
      const claimPath = path.match(/^\/agent\/requests\/([^/]+)\/claim$/);
      if (method === 'POST' && claimPath?.[1]) {
        const id = claimPath[1];
        const result = await store.update(state => claim(state, id, { resume: body.resume === undefined ? false : boolean(body, 'resume') }));
        const state = store.read();
        const document = await documentContext(get(state.documents, result.request.documentId));
        changed(); json(response, { ...result, document, thread: get(state.threads, result.request.threadId) }); return;
      }
      if (method === 'POST' && path === '/agent/streams') {
        const route = { requestId: text(body, 'requestId'), documentId: text(body, 'documentId'), threadId: text(body, 'threadId') };
        const current = get(store.read().requests, route.requestId);
        if (current.status !== 'claimed' || current.documentId !== route.documentId || current.threadId !== route.threadId) throw new DomainError('Claim the matching request before streaming', 409);
        if (!stream || stream.route.requestId !== current.id) {
          stopObserver?.(); stopObserver = undefined;
          const created = new ReplyStream(route); stream = created;
          if (owner.agent === 'codex') {
            try {
              const stop = await observeCodex(owner.sessionId, event => { if (stream === created) void acceptStream(event); }, message => { if (stream === created) { created.fail(message); changed(); } });
              if (closed || stream !== created) { stop(); throw new Error('Sidecar stopped'); }
              stopObserver = stop;
            } catch (error) { created.fail('Streaming unavailable. Use a complete reply.'); changed(); throw error; }
          }
        }
        changed(); json(response, { prefix: stream.prefix, suffix: stream.suffix }); return;
      }
      if (method === 'POST' && path === '/agent/stream-events') {
        if (text(body, 'ownerKey') !== ownerKey(owner) || owner.agent !== 'claude') throw new DomainError('Stream belongs to another owner', 409);
        if (!isStreamEvent(body)) throw new DomainError('Invalid stream event');
        await acceptStream(body); json(response, { ok: true }); return;
      }
      if (method === 'POST' && path === '/agent/replies') {
        const input = { requestId: text(body, 'requestId'), documentId: text(body, 'documentId'), threadId: text(body, 'threadId'), text: '', isError: body.isError === undefined ? false : boolean(body, 'isError') };
        if (body.stream === true) {
          const previous = get(store.read().requests, input.requestId).answer;
          input.text = previous?.text ?? (stream ? stream.finish(input) : (() => { throw new DomainError('No completed stream; send a complete reply', 409); })());
        } else input.text = text(body, 'text');
        await store.update(state => reply(state, input));
        if (stream?.route.requestId === input.requestId) { stream = undefined; stopObserver?.(); stopObserver = undefined; }
        changed(); json(response, { ok: true }); return;
      }
      throw new DomainError('Not found', 404);
    } catch (error) {
      const info = error instanceof URIError ? { error: 'Invalid URL', status: 400 } : errorInfo(error);
      if (!response.headersSent) json(response, { error: info.error }, info.status);
      else response.end();
    }
  }
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolveListen(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  url = `http://127.0.0.1:${address.port}`;
  await Promise.all(Object.values(store.read().documents).map(refresh));
  const polling = setInterval(() => {
    if (closed || refreshing) return;
    refreshing = true;
    void (async () => {
      for (const document of Object.values(store.read().documents)) await refresh(document);
    })().finally(() => { refreshing = false; });
  }, pollMs);
  let readingActivity = false;
  const activityPolling = owner.agent === 'codex' ? setInterval(() => {
    if (closed || readingActivity || !viewers.size) return;
    readingActivity = true;
    void readCodexActivity(owner.sessionId, transportAbort.signal).then(activity => {
      if (!closed && activity !== agentActivity) { agentActivity = activity; changed(); }
    }).finally(() => { readingActivity = false; });
  }, 1000) : undefined;
  const heartbeat = setInterval(() => {
    for (const response of viewers) if (!response.destroyed) response.write(': keepalive\n\n');
    for (const response of agents.keys()) if (!response.destroyed) response.write('\n');
  }, 5000);
  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true; stopObserver?.(); clearTimeout(streamTimer); transportAbort.abort(); clearInterval(polling); clearInterval(heartbeat); clearInterval(activityPolling);
    for (const response of [...viewers, ...agents.keys()]) response.end();
    closePromise = new Promise<void>((resolveClose, reject) => {
      const timer = setTimeout(() => server.closeAllConnections(), 100); timer.unref();
      server.close(error => { clearTimeout(timer); if (error) reject(error); else resolveClose(); });
    });
    await closePromise; await dispatchWork; await finalizing; finish();
  }
  changed();
  return { url, close, instanceId, done };
}
