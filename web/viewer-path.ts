export const isGateway = typeof document !== 'undefined' && !!document.querySelector('meta[name="sidecar-gateway"]');
export function viewerBase(pathname = typeof location === 'undefined' ? '/' : location.pathname): string {
  return /^\/a\/o[1-9A-Z][0-9A-Z]*(?=\/)/.exec(pathname)?.[0] ?? '';
}
export function viewerPath(path: string, pathname?: string): string {
  return path.startsWith('/a/') ? path : viewerBase(pathname) + path;
}
export const libraryPath = () => isGateway ? '/' : '/?library=1';
