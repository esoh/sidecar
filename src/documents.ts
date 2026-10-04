import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import { DomainError } from './store.ts';

const renderer = new MarkdownIt({ html: false });
renderer.validateLink = (link: string) => {
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(link, 'http://sidecar.invalid').protocol); }
  catch { return false; }
};
export type SourceFile = { path: string; bytes: Buffer; markdown: string; version: string; identity: { dev: number; ino: number; mode: number } };
export async function readSourceFile(path: string): Promise<SourceFile> {
  if (await realpath(path) !== resolve(path)) throw new DomainError('The backing path changed to a symlink; register its target explicitly', 409);
  if (!(await stat(path)).isFile()) throw new DomainError('A regular Markdown file is required');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await file.stat();
    if (!identity.isFile()) throw new DomainError('A regular Markdown file is required');
    const bytes = await file.readFile();
    const markdown = bytes.toString('utf8');
    return { path: resolve(path), bytes, markdown, version: createHash('sha256').update(bytes).digest('hex'), identity: { dev: identity.dev, ino: identity.ino, mode: identity.mode } };
  } finally { await file.close(); }
}
export async function readDocument(path: string) {
  const { markdown, version } = await readSourceFile(path);
  const tokens = renderer.parse(markdown, {});
  const headingIndex = tokens.findIndex(token => token.type === 'heading_open');
  const inline = headingIndex >= 0 ? tokens[headingIndex + 1] : undefined;
  const heading = inline?.children?.map(token => token.type === 'text' || token.type === 'code_inline' ? token.content : token.type === 'softbreak' ? ' ' : '').join('') || null;
  return { markdown, html: renderer.render(markdown), heading, version };
}
