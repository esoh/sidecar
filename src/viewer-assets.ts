import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, relative, isAbsolute, extname } from 'node:path';
import type { ServerResponse } from 'node:http';
import { DomainError } from './store.ts';
import { sendBody } from './viewer-http.ts';
const rendererRequire = createRequire(import.meta.resolve('@plannotator/ui/components/BlockRenderer'));
const rendererFonts = {
  katex: rendererRequire.resolve('katex/dist/katex.min.css'),
  inter: rendererRequire.resolve('@fontsource-variable/inter/index.css'),
  geist: rendererRequire.resolve('@fontsource-variable/geist-mono/index.css'),
};

// The app and its lazily imported chunks (Prettier), built once per server; paths are relative to /.
let appBundle: Promise<Map<string, Uint8Array>> | undefined;
export async function viewerHtml(gateway = false) {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  return gateway ? html.replace('<head>', '<head><meta name="sidecar-gateway" content="1">') : html;
}
export async function serveViewerAsset(path: string, method: string, response: ServerResponse): Promise<boolean> {
      const chunk = path.match(/^\/(app\.js|chunks\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.js)$/);
      if (method === 'GET' && chunk) {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        // One build per server; the browser revalidates the content hash on later loads. Code splitting needs an outdir.
        appBundle ??= build({ entryPoints: [fileURLToPath(new URL('../web/app.tsx', import.meta.url))], outdir: 'bundle', entryNames: 'app', chunkNames: 'chunks/[name]-[hash]', bundle: true, splitting: true, write: false, minify: true, format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
          .then(bundle => new Map(bundle.outputFiles.map(file => [relative(join(process.cwd(), 'bundle'), file.path), file.contents]))).catch(error => { appBundle = undefined; throw error; });
        const file = (await appBundle).get(chunk[1]);
        if (!file) throw new DomainError('Not found', 404);
        sendBody(response, file, true);
        return true;
      }
      if (method === 'GET' && path === '/renderer.css') {
        response.setHeader('Content-Type', 'text/css; charset=utf-8');
        const styles = await readFile(new URL(import.meta.resolve('@plannotator/ui/styles.css')), 'utf8');
        const fonts = await Promise.all(Object.entries(rendererFonts).map(async ([family, cssPath]) =>
          (await readFile(cssPath, 'utf8')).replaceAll(/url\((?:\.\/files|fonts)\//g, `url(/renderer-fonts/${family}/`)));
        sendBody(response, [styles, ...fonts].join('\n'), true);
        return true;
      }
      const font = path.match(/^\/renderer-fonts\/(katex|inter|geist)\/([A-Za-z0-9_-]+\.(?:woff2?|ttf))$/);
      if (method === 'GET' && font) {
        const family = font[1], name = font[2];
        if (family !== 'katex' && family !== 'inter' && family !== 'geist') throw new DomainError('Unknown font', 404);
        response.setHeader('Content-Type', name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.woff') ? 'font/woff' : 'font/ttf');
        sendBody(response, await readFile(join(dirname(rendererFonts[family]), family === 'katex' ? 'fonts' : 'files', name)), true);
        return true;
      }
      if (method === 'GET' && path === '/favicon.svg') {
        response.setHeader('Content-Type', 'image/svg+xml');
        sendBody(response, await readFile(new URL('../web/favicon.svg', import.meta.url), 'utf8'), true); return true;
      }
      if (method === 'GET' && path === '/app.css') {
        response.setHeader('Content-Type', 'text/css; charset=utf-8');
        sendBody(response, await readFile(new URL('../web/app.css', import.meta.url), 'utf8'), true);
        return true;
      }
  return false;
}

export async function serveDocumentImage(documentPath: string, target: URL, response: ServerResponse) {
        const base = dirname(documentPath);
        const imageUrl = new URL(target.searchParams.get('path') ?? '', pathToFileURL(documentPath));
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
}
