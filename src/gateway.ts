import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { openAgentIds, isAgentAlias } from './agent-ids.ts';
import { readRuntime } from './agent.ts';
import { DomainError } from './store.ts';
import { readDocument } from './documents.ts';
import { listLibrary, libraryDocument, closeLibraryDocument, recordDocumentOpen } from './library.ts';
import { readTunnelConfig } from './tunnel-config.ts';
import { createViewerHost, bodyOf, json, type ViewerContext } from './viewer-http.ts';
import { viewerHtml, serveViewerAsset, serveDocumentImage } from './viewer-assets.ts';

export async function startGateway({ stateRoot, port = 43120, networkPort = 43121 }: { stateRoot: string; port?: number; networkPort?: number }) {
  const directory = join(stateRoot, 'gateway'), instanceId = randomUUID();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tokenPath = join(directory, 'agent-token');
  try { await writeFile(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const capability = (await readFile(tokenPath, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(capability)) throw new Error('Invalid gateway capability file');
  const ids = await openAgentIds(stateRoot);
  const cookies = new Map<string, { instanceId: string; cookie: string }>();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const host = await createViewerHost({ directory, port, networkPort, persistNetwork: true, instanceId, cookieName: 'sidecar_gateway', capability, capabilityPrefix: '/gateway/',
    isPage: path => path === '/' || /^\/a\/o[1-9A-Z][0-9A-Z]*\/$/.test(path), handle });
  async function close() { await host.close(); finish(); }

  async function backend(key: string) {
    const directory = join(stateRoot, key);
    let runtime;
    try { runtime = await readRuntime(key, directory); }
    catch { throw new DomainError('This agent viewer is stopped. Open it from its original agent or use the saved preview.', 503); }
    let status;
    try {
      const token = (await readFile(join(directory, 'agent-token'), 'utf8')).trim();
      const response = await fetch(runtime.url + '/agent/status', { headers: { 'X-Sidecar-Token': token }, signal: AbortSignal.timeout(3000), redirect: 'error' });
      status = response.ok ? await response.json() : null;
    } catch { throw new DomainError('This agent viewer is unavailable. Open it from its original agent or use the saved preview.', 503); }
    if (!status || status.ownerKey !== key || status.instanceId !== runtime.instanceId) throw new DomainError('Original viewer identity changed. Refresh and retry.', 503);
    if (status.gatewayProtocol !== 1) throw new DomainError('Update this agent’s Sidecar viewer before using it through the shared gateway. Its existing direct link still works.', 409);
    let session = cookies.get(key);
    if (session?.instanceId !== runtime.instanceId) {
      const response = await fetch(runtime.url + '/', { signal: AbortSignal.timeout(3000), redirect: 'error' });
      const cookie = response.headers.get('set-cookie')?.split(';')[0]; await response.body?.cancel();
      if (!response.ok || !cookie) throw new DomainError('Original viewer could not authenticate the gateway', 503);
      session = { instanceId: runtime.instanceId, cookie }; cookies.set(key, session);
    }
    return { ...runtime, cookie: session.cookie };
  }
  async function proxy(key: string, target: string, request: IncomingMessage, response: ServerResponse) {
    const upstream = await backend(key);
    // Allow only viewer headers; never carry browser capabilities or forwarded identities.
    const headers: Record<string, string> = { Cookie: upstream.cookie, Origin: upstream.url, 'X-Sidecar-Instance': upstream.instanceId };
    for (const name of ['content-type', 'content-length', 'accept', 'accept-encoding', 'if-none-match']) {
      const value = request.headers[name]; if (typeof value === 'string') headers[name] = value;
    }
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(upstream.url + target, { method: request.method, headers }, incoming => {
        outgoing.setTimeout(0);
        response.statusCode = incoming.statusCode ?? 502;
        for (const name of ['content-type', 'content-length', 'content-encoding', 'cache-control', 'etag', 'vary', 'content-security-policy', 'content-disposition', 'retry-after']) {
          const value = incoming.headers[name]; if (value !== undefined) response.setHeader(name, value);
        }
        response.flushHeaders(); incoming.pipe(response);
        incoming.on('error', error => response.destroy(error));
        resolve();
      });
      outgoing.setTimeout(10000, () => outgoing.destroy(new Error('Original viewer did not respond')));
      outgoing.on('error', () => { if (response.headersSent) response.destroy(); else reject(new DomainError('Original viewer disconnected. Reopen or retry when it is available.', 503)); });
      response.once('close', () => outgoing.destroy());
      request.once('aborted', () => outgoing.destroy());
      request.pipe(outgoing);
    });
  }
  async function handle(request: IncomingMessage, response: ServerResponse, context: ViewerContext) {
    const { target, method, isLocal } = context;
    if (request.headers['x-sidecar-instance'] && context.isAgent && request.headers['x-sidecar-instance'] !== instanceId) throw new DomainError('Gateway instance changed', 409);
    const rawPath = (request.url ?? '/').split('?')[0];
    if (/%(?:2e|2f|5c|25)/i.test(rawPath) || rawPath.includes('\\') || /(?:^|\/)\.\.?(?:\/|$)/.test(rawPath)) throw new DomainError('Invalid viewer route', 400);
    let path = context.path, key: string | undefined;
    const routed = /^\/a\/([^/]+)(\/.*)$/.exec(path);
    if (routed) {
      if (!isAgentAlias(routed[1], 'o')) throw new DomainError('Unknown agent route', 404);
      key = await ids.resolveOwner(routed[1]); path = routed[2];
    }
    if (path === '/agent' || path.startsWith('/agent/') || (key && path.startsWith('/gateway/'))) throw new DomainError('Native agent endpoints are unavailable through the gateway', 403);
    if (context.isAgent) {
      if (path === '/gateway/status' && method === 'GET') { json(response, { state: 'running', gatewayProtocol: 1, instanceId, url: host.url, networkPort, network: host.networkStatus(true) }); return; }
      if (path === '/gateway/stop' && method === 'POST') { json(response, { ok: true }); setImmediate(() => { void close(); }); return; }
    }
    if (path === '/api/network' || path === '/gateway/network') {
      if (method === 'GET') { json(response, host.networkStatus(isLocal)); return; }
      if (method === 'POST') {
        if (!isLocal) throw new DomainError('Manage network access from the local viewer', 403);
        const body = await bodyOf(request);
        if (typeof body.enabled !== 'boolean') throw new DomainError('Expected enabled to be a boolean');
        for (const field of ['passphrase', 'publicUrl', 'expectedTunnelTarget', 'expectedInstanceId']) if (body[field] !== undefined && typeof body[field] !== 'string') throw new DomainError(`Expected ${field} to be text`);
        const string = (field: string) => typeof body[field] === 'string' ? body[field] : undefined;
        await host.setNetworkAccess(body.enabled, string('passphrase'), string('publicUrl'), string('expectedTunnelTarget'), string('expectedInstanceId'));
        json(response, host.networkStatus(true)); return;
      }
      throw new DomainError('Not found', 404);
    }
    if (path === '/api/tunnel-config') {
      if (!isLocal) throw new DomainError('Manage tunnel settings from the local viewer', 403);
      if (method !== 'GET') throw new DomainError('Not found', 404);
      json(response, await readTunnelConfig()); return;
    }
    if (method === 'GET' && path === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(await viewerHtml(true)); return;
    }
    if (await serveViewerAsset(path, method, response)) return;
    if (method === 'GET' && path === '/api/library') {
      const library = await listLibrary(stateRoot, true);
      for (const session of library.sessions) {
        await ids.allocate(session.ownerKey, []); session.ownerAlias = ids.encode(session.ownerKey, 'o', session.ownerKey);
        session.url = session.url ? `/a/${session.ownerAlias}` : null;
      }
      if (key) library.sessions = library.sessions.filter(session => session.ownerKey === key);
      json(response, library); return;
    }
    const entry = /^\/api\/library\/([^/]+)\/documents\/([^/]+)(\/opened)?$/.exec(path);
    if (entry) {
      if (key && entry[1] !== key) throw new DomainError('Document belongs to another agent', 404);
      const document = await libraryDocument(stateRoot, entry[1], entry[2]);
      if (entry[3] && method === 'POST') { await recordDocumentOpen(join(stateRoot, entry[1]), document.id); json(response, { ok: true }); return; }
      if (!entry[3] && method === 'DELETE') { json(response, await closeLibraryDocument(stateRoot, entry[1], document.id)); return; }
      if (!entry[3] && method === 'GET') {
        const content = await readDocument(document.path);
        json(response, { ...content, title: document.userTitle ?? document.providedTitle ?? content.heading ?? basename(document.path) }); return;
      }
    }
    if (method === 'GET' && path === '/api/image' && target.searchParams.has('owner')) {
      const owner = target.searchParams.get('owner')!;
      if (key && owner !== key) throw new DomainError('Document belongs to another agent', 404);
      const document = await libraryDocument(stateRoot, owner, target.searchParams.get('document') ?? '');
      await serveDocumentImage(document.path, target, response); return;
    }
    if (key && path.startsWith('/api/')) {
      // Preserve literal path characters across the second URL parse; encoded delimiters cannot become management routes.
      await proxy(key, path.split('/').map(encodeURIComponent).join('/') + target.search, request, response); return;
    }
    throw new DomainError('Not found', 404);
  }
  return { ...host, close, done, instanceId };
}
