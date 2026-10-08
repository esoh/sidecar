import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { networkInterfaces } from 'node:os';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError, isObject } from './store.ts';

export type ViewerContext = { target: URL; path: string; method: string; origin: string; isLocal: boolean; isAgent: boolean };
type ViewerHostOptions = {
  directory: string; port?: number; networkPort?: number; persistNetwork?: boolean;
  cookieName: string; capability: string; capabilityPrefix?: string; instanceId: string;
  isPage?: (path: string) => boolean;
  handle: (request: IncomingMessage, response: ServerResponse, context: ViewerContext) => Promise<void>;
};
export async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
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
export function sameSecret(value: unknown, secret: string): boolean {
  return typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(secret) && timingSafeEqual(Buffer.from(value), Buffer.from(secret));
}
export function sendBody(response: ServerResponse, body: string | Uint8Array, isAsset = false): void {
  const bytes = Buffer.from(body);
  response.setHeader('Vary', 'Accept-Encoding');
  if (isAsset) {
    const etag = `W/"${createHash('sha256').update(bytes).digest('hex')}"`;
    // Revalidate after authentication, including after an upgrade or passphrase change.
    response.setHeader('Cache-Control', 'private, no-cache');
    response.setHeader('ETag', etag);
    if (response.req.headers['if-none-match']?.split(',').map(value => value.trim()).some(value => value === etag || value === '*')) {
      response.writeHead(304); response.end(); return;
    }
  }
  const encodings = (response.req.headers['accept-encoding'] ?? '').toLowerCase().split(',').map(value => value.trim().split(/;\s*/));
  const encoding = encodings.find(([name]) => name === 'gzip') ?? encodings.find(([name]) => name === '*');
  const quality = encoding?.slice(1).find(value => value.startsWith('q='))?.slice(2);
  const canCompress = !!encoding && (quality === undefined || (Number(quality) > 0 && Number(quality) <= 1));
  const finish = (data: Buffer) => { response.setHeader('Content-Length', data.length); response.end(data); };
  if (canCompress && bytes.length >= 1024) {
    gzip(bytes, (error, compressed) => {
      if (response.destroyed) return;
      if (error) { response.destroy(error); return; }
      response.setHeader('Content-Encoding', 'gzip'); finish(compressed);
    });
  } else finish(bytes);
}
export function json(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  sendBody(response, JSON.stringify(value));
}
function closeListener(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => server.closeAllConnections(), 100); timer.unref();
    server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
  });
}
export async function createViewerHost({ directory, port = 0, networkPort = 0, persistNetwork = false, cookieName, capability, capabilityPrefix = '/agent/', instanceId, isPage = path => path === '/', handle: handler }: ViewerHostOptions) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let closed = false, url = '';
  const viewerToken = randomBytes(32).toString('hex');
  async function saveNetwork() {
    const path = join(directory, 'network.json'), temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ enabled: !!lanServer, publicUrl }), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  function createListener(isLan = false) {
    const listener = createServer((request, response) => { void handle(request, response, isLan); });
    listener.requestTimeout = 10000;
    listener.headersTimeout = 10000;
    return listener;
  }
  const server = createListener();
  let lanServer: ReturnType<typeof createServer> | undefined;
  let lanChange: Promise<void> = Promise.resolve();
  let lanAuth: { passphrase: string; token: string } | undefined;
  let publicUrl: string | null = null;
  let failedLogins = 0, loginWindow = 0;
  const lanCookieName = `${cookieName}_lan`;
  // No Sidecar sign-in timeout. Renew persistent browser storage on authenticated visits.
  const networkCookie = (isSecure: boolean) => `${lanCookieName}=${lanAuth?.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000${isSecure ? '; Secure' : ''}`;
  async function prepareNetworkAuth(passphrase?: string) {
    const path = join(directory, 'network-auth.json');
    if (!lanAuth) {
      try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isObject(saved) || typeof saved.passphrase !== 'string' || saved.passphrase.length < 8 || saved.passphrase.length > 128 || typeof saved.token !== 'string' || !/^[a-f0-9]{64}$/.test(saved.token)) throw new Error('Saved network credentials are invalid');
        lanAuth = { passphrase: saved.passphrase, token: saved.token };
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    if (lanAuth && (passphrase === undefined || passphrase === lanAuth.passphrase)) return;
    const next = { passphrase: passphrase ?? randomBytes(6).toString('hex'), token: randomBytes(32).toString('hex') };
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    lanAuth = next; failedLogins = 0;
    // Revoke connected browsers too, so an old SSE connection cannot keep receiving updates.
    lanServer?.closeAllConnections();
  }
  const lanAddresses = () => [...new Set(Object.values(networkInterfaces()).flatMap(addresses =>
    addresses?.filter(address => address.family === 'IPv4' && !address.internal).map(address => address.address) ?? []))];
  function networkStatus(isLocal: boolean) {
    const address = lanServer?.address();
    const urls = address && typeof address !== 'string' ? lanAddresses().map(ip => `http://${ip}:${address.port}`) : [];
    return { enabled: !!lanServer, urls, publicUrl, isLocal, ...(isLocal ? {
      passphrase: lanServer ? lanAuth?.passphrase ?? null : null,
      tunnelTarget: address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : null,
    } : {}) };
  }
  function setNetworkAccess(enabled: boolean, passphrase?: string, nextPublicUrl?: string, expectedTunnelTarget?: string, expectedInstanceId?: string) {
    if (nextPublicUrl) {
      let parsed: URL;
      try { parsed = new URL(nextPublicUrl); } catch { throw new DomainError('Enter an HTTPS address without a path, query, or fragment.'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || nextPublicUrl.length > 2048)
        throw new DomainError('Enter an HTTPS address without credentials, a path, query, or fragment.');
      nextPublicUrl = parsed.origin;
    }
    if (passphrase !== undefined && (passphrase.length < 8 || passphrase.length > 128)) throw new DomainError('Use a passphrase between 8 and 128 characters.');
    // Serialize toggles so a late enable cannot reopen access after Disable.
    const change = lanChange.then(async () => {
      if (closed) throw new DomainError('Sidecar is stopping', 503);
      if ((expectedInstanceId !== undefined && expectedInstanceId !== instanceId) ||
          (expectedTunnelTarget !== undefined && expectedTunnelTarget !== networkStatus(true).tunnelTarget))
        throw new DomainError('Sidecar or its protected listener changed. Recheck the tunnel target before reconnecting.', 409);
      if (enabled) await prepareNetworkAuth(passphrase);
      if (enabled && !lanServer) {
        if (!lanAddresses().length) throw new DomainError('No local IPv4 network found. Connect to Wi-Fi or Ethernet and try again.');
        const listener = createListener(true);
        await new Promise<void>((resolve, reject) => {
          listener.once('error', reject);
          listener.listen(networkPort, '0.0.0.0', () => { listener.off('error', reject); resolve(); });
        });
        lanServer = listener;
      } else if (!enabled && lanServer) {
        const listener = lanServer; lanServer = undefined;
        await closeListener(listener);
      }
      const next = enabled ? nextPublicUrl === undefined ? publicUrl : nextPublicUrl || null : null;
      if (next !== publicUrl) { publicUrl = next; lanServer?.closeAllConnections(); }
      if (persistNetwork) await saveNetwork();
    });
    lanChange = change.catch(() => {});
    return change;
  }
  async function handle(request: IncomingMessage, response: ServerResponse, isLan: boolean) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (closed) throw new DomainError('Sidecar is stopping. Reopen it from your agent.', 503);
      const isTunnel = !!(isLan && publicUrl && request.headers.host === new URL(publicUrl).host);
      // Only a loopback proxy for the explicitly allowed HTTPS origin can use this route.
      // Forwarded headers never select an origin or grant localhost/agent privileges.
      if (isTunnel && (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') || request.headers['x-forwarded-proto'] !== 'https'))
        throw new DomainError('Use an HTTPS tunnel forwarded through localhost', 403);
      const origin = isTunnel && publicUrl ? publicUrl : isLan ? `http://${request.headers.host}` : url;
      if (isLan ? !isTunnel && !networkStatus(false).urls.includes(origin) : request.headers.host !== new URL(url).host) throw new DomainError('Invalid host', 403);
      if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new DomainError('Foreign origin', 403);
      const target = new URL(request.url ?? '/', origin);
      if (target.origin !== origin) throw new DomainError('Foreign request target', 403);
      let path = decodeURIComponent(target.pathname);
      const method = request.method ?? 'GET';
      const name = isLan ? lanCookieName : cookieName;
      const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
      const hasViewer = isLan ? !!lanAuth && sameSecret(cookie, lanAuth.token) : sameSecret(cookie, viewerToken);
      if (isLan && hasViewer) response.setHeader('Set-Cookie', networkCookie(isTunnel));
      async function unlockPage(error = '', status = 200) {
        response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end((await readFile(new URL('../web/unlock.html', import.meta.url), 'utf8')).replace('<!-- error -->', error ? `<p role="alert">${error}</p>` : ''));
      }
      if (isLan && isPage(path) && method === 'POST') {
        if (request.headers.origin !== origin) throw new DomainError('Origin required', 403);
        if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new DomainError('Expected a login form', 415);
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 2048) throw new DomainError('Login form is too large', 413); chunks.push(chunk); }
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        // One budget per viewer also limits distributed guesses at the shared passphrase.
        if (Date.now() - loginWindow >= 60000) { failedLogins = 0; loginWindow = Date.now(); }
        if (failedLogins >= 10) { response.setHeader('Retry-After', '60'); await unlockPage('Too many attempts. Try again in a minute.', 429); return; }
        if (!lanAuth || !sameSecret(form.get('passphrase'), lanAuth.passphrase)) {
          failedLogins++; await unlockPage('Incorrect passphrase.', 401); return;
        }
        failedLogins = 0;
        response.setHeader('Set-Cookie', networkCookie(isTunnel));
        response.writeHead(303, { Location: target.pathname + target.search }); response.end(); return;
      }
      if (method === 'GET' && isPage(path)) {
        if (!isLan && ['cross-site', 'same-site'].includes(String(request.headers['sec-fetch-site']))) throw new DomainError('Open Sidecar from the agent', 403);
        if (isLan && !hasViewer) { await unlockPage(); return; }
        if (!isLan) response.setHeader('Set-Cookie', `${cookieName}=${viewerToken}; HttpOnly; SameSite=Strict; Path=/`);
        await handler(request, response, { target, path, method, origin, isLocal: !isLan, isAgent: false }); return;
      }
      const isAgent = path.startsWith(capabilityPrefix);
      if (isAgent) {
        if (isLan) throw new DomainError('Agent endpoints are local only', 403);
        if (!sameSecret(request.headers['x-sidecar-token'], capability)) throw new DomainError('Agent capability required', 403);
      } else {
        if (!hasViewer) throw new DomainError(isLan ? 'Reload this page to enter the network passphrase.' : 'Open Sidecar from the agent', isLan ? 401 : 403);
        if (method !== 'GET' && method !== 'HEAD' && request.headers.origin !== origin) throw new DomainError('Origin required', 403);
      }
      await handler(request, response, { target, path, method, origin, isLocal: !isLan, isAgent });
    } catch (error) {
      const status = error instanceof DomainError ? error.status : error instanceof URIError ? 400 : 500;
      if (!response.headersSent) json(response, { error: error instanceof Error ? error.message : 'Unexpected server error' }, status);
      else response.end();
    }
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  url = `http://127.0.0.1:${address.port}`;
  try {
    if (persistNetwork) {
      let saved: unknown;
      try { saved = JSON.parse(await readFile(join(directory, 'network.json'), 'utf8')); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      if (saved !== undefined) {
        if (!isObject(saved) || typeof saved.enabled !== 'boolean' || !(saved.publicUrl === null || typeof saved.publicUrl === 'string')) throw new Error('Invalid saved network setting');
        if (saved.enabled) await setNetworkAccess(true, undefined, saved.publicUrl ?? undefined);
      }
    }
  } catch (error) { await close(); throw error; }
  async function close() {
    if (closed) return; closed = true;
    await Promise.all([closeListener(server), lanChange.then(async () => {
      if (lanServer) { const listener = lanServer; lanServer = undefined; await closeListener(listener); }
    })]);
  }
  return { url, close, networkStatus, setNetworkAccess };
}
