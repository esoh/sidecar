import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockRenderer } from '@plannotator/ui/components/BlockRenderer';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { blockMap, sourceSpan, type BlockKind } from '../web/source-map.ts';

function pick(source: string, kind: BlockKind, text: string | null): string {
  const map = blockMap(source, kind);
  assert.ok(map, `no map for ${source}`);
  const at = text === null ? 0 : map.visible.indexOf(text);
  assert.ok(at >= 0, `"${text}" not in "${map.visible}"`);
  const span = sourceSpan(map, at, at + (text === null ? map.visible.length : text.length));
  return source.slice(span.start, span.end);
}

// ---- Conformance: visible must equal the text nodes Plannotator really renders. ----
const EXCLUDED_TAGS = new Set(['button', 'input', 'textarea', 'svg', 'style', 'script']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#x27': "'", '#39': "'" };

/** Mirrors selectionText: text nodes minus the excluded elements. */
function renderedText(html: string): string {
  let out = '';
  const stack: boolean[] = []; // true = element is excluded
  let hidden = 0;
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      if (!hidden) out += m[4].replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (w, e: string) => ENTITY[e] ?? w);
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      if (m[1]) {
        if (stack.pop()) hidden--;
      } else if (!VOID_TAGS.has(tag)) {
        const cls = /class="([^"]*)"/.exec(m[3])?.[1].split(/\s+/) ?? [];
        const skip =
          EXCLUDED_TAGS.has(tag) || cls.includes('annotation-exclude') || cls.includes('katex') || /aria-hidden="true"/.test(m[3]);
        stack.push(skip);
        if (skip) hidden++;
      }
    }
  }
  return out;
}

const KIND_OF: Record<string, BlockKind> = {
  paragraph: 'paragraph', heading: 'heading', blockquote: 'blockquote', 'list-item': 'list-item', code: 'code', table: 'table',
};

const corpus = [
  'Hello **world**',
  'see [click here](https://x.y "t") now',
  'run `npm i` now',
  'a &amp; b \\* c',
  '## Title',
  '#NoSpace',
  '- item',
  '- [ ] task',
  '- [x]task',
  '1. first',
  '- a\n  continued **b**\n\n  second para',
  '> one\n> two',
  '> a\n>\n> b',
  '> - not a list',
  '```ts\nconst a = 1;\n```',
  '```\nplain\n\ntext\n```',
  '| a | b |\n| - | - |\n| c | d |',
  '| a \\| b | **c** |\n| - | - |\n| `x` | y |',
  'one\ntwo',
  'one  \ntwo',
  'one\\\ntwo',
  '__bold__ and _em_ and snake_case_name',
  'x ** a ** y',
  '2 * 3 * 4',
  'a ``x`` b',
  'a \\<x b \\q',
  '3...2 --- 3--5 a--b :rocket: :nope:',
  'say "hi" and \'there\' (“q”) "',
  '"leading" quote',
  'see [a](u "x) y") z',
  '[**not bold**](u) and ![img](a.png) and <https://x.y> and <me@x.y>',
  '<custom:thing> and <b>raw</b> and <!-- gone --> end',
  'visit https://example.com/a_(b). now #12 and @user #fff',
  '~~gone~~ ***both*** *i* **b**',
  '[ ] [x](y',
  'cost $5 and $10 total',
  '::: not a directive',
];

for (const source of corpus) {
  test(`conforms to Plannotator rendering: ${JSON.stringify(source)}`, () => {
    const blocks = parseMarkdownToBlocks(source);
    assert.equal(blocks.length, 1, 'corpus entries are single blocks');
    const kind = KIND_OF[blocks[0].type];
    assert.ok(kind, `unexpected block type ${blocks[0].type}`);
    const map = blockMap(source, kind);
    assert.ok(map, 'mapped');
    const html = renderToStaticMarkup(createElement(BlockRenderer, { block: blocks[0] }));
    assert.equal(map.visible, renderedText(html));
    // Every visible char points at real source.
    for (let i = 0; i < map.visible.length; i++) assert.ok(map.toSource[i] >= 0 && map.ends[i] <= source.length && map.toSource[i] < map.ends[i]);
  });
}

test('kinds that are not mapped return null, matching Plannotator block types', () => {
  assert.equal(parseMarkdownToBlocks('<div>x</div>')[0].type, 'html');
  assert.equal(parseMarkdownToBlocks('> [!NOTE]\n> body')[0].alertKind, 'note');
  assert.equal(parseMarkdownToBlocks('::: note\nbody\n:::')[0].type, 'directive');
  assert.equal(blockMap('::: note\nbody\n:::', 'directive'), null);
});

test('CRLF fenced code without a language keeps the carriage returns', () => {
  const s = '```\r\nplain\r\nb\r\n```';
  assert.equal(blockMap(s, 'code')!.visible, 'plain\r\nb\r');
  assert.equal(pick(s, 'code', null), s);
});

test('CRLF fenced code with a language drops the carriage returns', () => {
  const s = '```ts\r\nconst a = 1;\r\nb\r\n```';
  assert.equal(blockMap(s, 'code')!.visible, 'const a = 1;\nb');
  assert.equal(pick(s, 'code', null), s);
});

test('multi-char output keeps the whole source span', () => {
  const s = 'a... b';
  assert.equal(blockMap(s, 'paragraph')!.visible, 'a… b');
  assert.equal(pick(s, 'paragraph', '…'), '...');
  assert.equal(pick('x :rocket: y', 'paragraph', '🚀'), ':rocket:');
  assert.equal(pick('say "hi"', 'paragraph', '“hi”'), '"hi"');
});
