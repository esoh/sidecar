import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { ServerResponse } from 'node:http';
import { DomainError } from './store.ts';
import { sendBody } from './viewer-http.ts';
const rendererRequire = createRequire(import.meta.resolve('@plannotator/ui/components/BlockRenderer'));
const rendererFonts = {
  katex: rendererRequire.resolve('katex/dist/katex.min.css'),
  inter: rendererRequire.resolve('@fontsource-variable/inter/index.css'),
  geist: rendererRequire.resolve('@fontsource-variable/geist-mono/index.css'),
};

let appBundle: Promise<Uint8Array> | undefined;
export async function viewerHtml(gateway = false) {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  return gateway ? html.replace('<head>', '<head><meta name="sidecar-gateway" content="1">') : html;
}
export async function serveViewerAsset(path: string, method: string, response: ServerResponse): Promise<boolean> {
      if (method === 'GET' && path === '/app.js') {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        // One build per server; the browser revalidates the content hash on later loads.
        appBundle ??= build({ entryPoints: [fileURLToPath(new URL('../web/app.tsx', import.meta.url))], bundle: true, write: false, minify: true, format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
          .then(bundle => bundle.outputFiles[0].contents).catch(error => { appBundle = undefined; throw error; });
        sendBody(response, await appBundle, true);
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
