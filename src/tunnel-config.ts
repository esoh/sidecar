import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DomainError, isObject } from './store.ts';

export type TunnelConfig = { provider: 'ngrok'; publicUrl?: string } | { provider: 'cloudflare'; publicUrl: string; configPath: string };

// Preferences only: reading this file must never enable access or launch a process.
export async function readTunnelConfig(): Promise<{ path: string; tunnel: TunnelConfig; gateway: { port: number; networkPort: number } }> {
  const path = process.env.SIDECAR_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'sidecar/config.json');
  const invalid = (reason: string): never => { throw new DomainError(`Sidecar config (${path}): ${reason}`); };
  let content: string;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { path, tunnel: { provider: 'ngrok' }, gateway: { port: 43120, networkPort: 43121 } };
    return invalid('Cannot read the file. Check its path and permissions.');
  }
  if (content.length > 65536) return invalid('File exceeds 64 KiB.');
  let value: unknown;
  try { value = JSON.parse(content); } catch { return invalid('Expected valid JSON.'); }
  if (!isObject(value)) return invalid('Expected an object.');
  const configured = value.gateway === undefined ? {} : value.gateway;
  if (!isObject(configured) || Object.keys(configured).some(key => !['port', 'networkPort'].includes(key))) return invalid('gateway must contain only port and networkPort.');
  const port = configured.port === undefined ? 43120 : configured.port, networkPort = configured.networkPort === undefined ? 43121 : configured.networkPort;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || typeof networkPort !== 'number' || !Number.isInteger(networkPort) || networkPort < 1 || networkPort > 65535 || port === networkPort)
    return invalid('gateway.port and gateway.networkPort must be distinct integer ports from 1 to 65535.');
  const gateway = { port, networkPort };
  const tunnel = value.tunnel === undefined ? {} : value.tunnel;
  if (!isObject(tunnel)) return invalid('tunnel must be an object.');
  const provider = tunnel.provider === undefined ? 'ngrok' : tunnel.provider;
  if (provider !== 'ngrok' && provider !== 'cloudflare') return invalid('tunnel.provider must be ngrok or cloudflare.');
  const keys = provider === 'cloudflare' ? ['provider', 'publicUrl', 'configPath'] : ['provider', 'publicUrl'];
  if (Object.keys(tunnel).some(key => !keys.includes(key))) return invalid('Unknown tunnel setting. Use provider, publicUrl, and (Cloudflare only) configPath.');
  let publicUrl: string | undefined;
  if (tunnel.publicUrl !== undefined) {
    if (typeof tunnel.publicUrl !== 'string' || tunnel.publicUrl.length > 2048) return invalid('tunnel.publicUrl must be an HTTPS origin.');
    let url: URL;
    try { url = new URL(tunnel.publicUrl); } catch { return invalid('tunnel.publicUrl must be an HTTPS origin.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port || url.hostname.includes('*'))
      return invalid('tunnel.publicUrl must be HTTPS with no credentials, port, path, query, wildcard, or fragment.');
    publicUrl = url.origin;
  }
  if (provider === 'ngrok') return { path, gateway, tunnel: { provider, ...(publicUrl ? { publicUrl } : {}) } };
  if (!publicUrl) return invalid('Cloudflare requires tunnel.publicUrl.');
  if (typeof tunnel.configPath !== 'string' || !tunnel.configPath || /[\x00-\x1f]/.test(tunnel.configPath)) return invalid('Cloudflare requires tunnel.configPath.');
  const configPath = tunnel.configPath.startsWith('~/') ? join(homedir(), tunnel.configPath.slice(2)) : tunnel.configPath;
  if (!isAbsolute(configPath)) return invalid('tunnel.configPath must be absolute or start with ~/.');
  return { path, gateway, tunnel: { provider, publicUrl, configPath } };
}
