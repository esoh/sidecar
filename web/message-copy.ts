import MarkdownIt, { type Env } from 'markdown-it';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';

export type CopyFormat = 'markdown' | 'rich' | 'plain';
const markdown = new MarkdownIt({ html: false, breaks: true });

export function messageClipboard(text: string) {
  // Let the Markdown parser identify code blocks; copy their source byte for byte.
  const environment: Env = {}, tokens = markdown.parse(text, environment);
  const internalReference = (label: string) => /^#selection-[1-9]\d*$/.test(environment.references?.[markdown.utils.normalizeReference(label)]?.href ?? '');
  const stripJumps = (value: string) => value
    .replace(/^ {0,3}\[([^\]\n]+)\]:[ \t]*#selection-[1-9]\d*(?:[ \t]+["'][^\n]*["'])?[ \t]*(?:\r?\n|$)/gm, (whole, label: string) => internalReference(label) ? '' : whole)
    .replace(/(`+)[\s\S]*?\1|(?<!!)\[([^\]\n]*)\](?:\(([^)\n]*)\)|\[([^\]\n]*)\])?/g,
      (whole, _code: string | undefined, label: string | undefined, destination: string | undefined, reference: string | undefined) => {
        if (label === undefined) return whole;
        return (destination === undefined ? internalReference(reference || label) : /^#selection-[1-9]\d*(?:\s+["'][^\n]*["'])?$/.test(destination)) ? label : whole;
      });
  const lineOffsets = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') lineOffsets.push(index + 1);
  let cursor = 0, raw = '';
  for (const token of tokens) {
    if (!token.map || (token.type !== 'fence' && token.type !== 'code_block')) continue;
    const start = lineOffsets[token.map[0]], end = lineOffsets[token.map[1]] ?? text.length;
    raw += stripJumps(text.slice(cursor, start)) + text.slice(start, end);
    cursor = end;
  }
  raw += stripJumps(text.slice(cursor));
  const template = document.createElement('template');
  template.innerHTML = markdown.render(raw);
  for (const link of template.content.querySelectorAll('a[href]')) {
    if (/^#selection-[1-9]\d*$/.test(link.getAttribute('href') ?? '')) link.replaceWith(...link.childNodes);
  }
  const html = template.innerHTML;
  for (const image of template.content.querySelectorAll('img')) image.replaceWith(image.alt);
  for (const br of template.content.querySelectorAll('br')) br.replaceWith('\n');
  for (const cell of template.content.querySelectorAll('td, th')) cell.append('\t');
  for (const block of template.content.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, tr, pre, blockquote')) block.append('\n');
  return { raw, html, plain: template.content.textContent?.replace(/\n{3,}/g, '\n\n').trim() ?? '' };
}

export const messagePreview = (text: string) => messageClipboard(text).plain.replace(/\s+/g, ' ');

export async function copyMessage(text: string, format: CopyFormat) {
  const value = messageClipboard(text);
  if (format === 'rich' && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([value.html], { type: 'text/html' }),
        'text/plain': new Blob([value.plain], { type: 'text/plain' }),
      })]);
      return;
    } catch { /* Fall back to readable text if rich clipboard access is unavailable. */ }
  }
  if (!await copyTextToClipboard(format === 'markdown' ? value.raw : value.plain)) throw new Error('Could not copy this message.');
}
