import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockRenderer } from '@plannotator/ui/components/BlockRenderer';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { blockMap, sameVisible, sourceSpan, visibleSpan, type BlockKind } from '../web/source-map.ts';

function pick(source: string, kind: BlockKind, text: string | null): string {
  const map = blockMap(source, kind);
  assert.ok(map, `no map for ${source}`);
  const at = text === null ? 0 : map.visible.indexOf(text);
  assert.ok(at >= 0, `"${text}" not in "${map.visible}"`);
  const span = sourceSpan(map, at, at + (text === null ? map.visible.length : text.length));
  return source.slice(span.start, span.end);
}

test('emphasis edge rule', () => {
  const s = 'Hello **world**';
  assert.equal(pick(s, 'paragraph', 'Hello wor'), 'Hello **wor');
  assert.equal(pick(s, 'paragraph', 'world'), '**world**');
  assert.equal(pick(s, 'paragraph', 'wor'), 'wor');
});

test('links', () => {
  const s = 'see [click here](https://x.y "t") now';
  assert.equal(blockMap(s, 'paragraph')!.visible, 'see click here now');
  assert.equal(pick(s, 'paragraph', 'click here'), '[click here](https://x.y "t")');
  assert.equal(pick(s, 'paragraph', 'here'), 'here');
});

test('inline code', () => {
  const s = 'run `npm i` now';
  assert.equal(pick(s, 'paragraph', 'npm i'), '`npm i`');
  assert.equal(pick(s, 'paragraph', 'npm'), 'npm');
});

test('entities stay literal, escapes are hidden', () => {
  const s = 'a &amp; b \\* c';
  assert.equal(blockMap(s, 'paragraph')!.visible, 'a &amp; b * c');
  assert.equal(pick(s, 'paragraph', '&amp;'), '&amp;');
  assert.equal(pick(s, 'paragraph', '*'), '\\*');
});

test('heading', () => {
  assert.equal(pick('## Title', 'heading', null), '## Title');
  assert.equal(pick('## Title', 'heading', 'Tit'), 'Tit');
});

test('list items', () => {
  assert.equal(pick('- item', 'list-item', null), '- item');
  assert.equal(pick('- [ ] task', 'list-item', null), '- [ ] task');
  assert.equal(pick('1. first', 'list-item', null), '1. first');
  assert.equal(pick('- [ ] task', 'list-item', 'ta'), 'ta');
});

test('blockquote', () => {
  const s = '> one\n> two';
  assert.equal(pick(s, 'blockquote', null), s);
  assert.equal(pick(s, 'blockquote', 'two'), 'two');
});

test('fenced code', () => {
  const s = '```ts\nconst a = 1;\n```';
  assert.equal(pick(s, 'code', null), s);
  assert.equal(pick(s, 'code', 'a = 1'), 'a = 1');
});

test('table', () => {
  const s = '| a | b |\n| - | - |\n| c | d |';
  assert.equal(pick(s, 'table', 'c'), 'c');
  assert.equal(blockMap(s, 'table')!.visible, 'abcd');
  assert.equal(pick(s, 'table', 'cd'), '| c | d |');
});

test('soft break', () => {
  const map = blockMap('one\ntwo', 'paragraph')!;
  assert.ok(/^one\s+two$/.test(map.visible));
  assert.ok(sameVisible(map.visible, 'one two'));
});

test('CRLF offsets index the source exactly', () => {
  const s = 'Hello **world**\r\n';
  assert.equal(pick(s, 'paragraph', 'world'), '**world**');
  assert.equal(pick('one\r\ntwo', 'paragraph', 'two'), 'two');
});

test('autolink and image', () => {
  assert.equal(blockMap('<https://x.y>', 'paragraph')!.visible, 'https://x.y');
  assert.equal(blockMap('a ![alt](i.png) b', 'paragraph')!.visible, 'a  b');
  assert.equal(pick('a ![alt](i.png) b', 'paragraph', 'a  b'), 'a ![alt](i.png) b');
});

test('visibleSpan', () => {
  const map = blockMap('Hello **world**', 'paragraph')!;
  assert.deepEqual(visibleSpan(map, 6, 15), { start: 6, end: 11 });
  const link = 'see [click here](https://x.y "t") now';
  const lm = blockMap(link, 'paragraph')!;
  const from = link.indexOf('(https');
  assert.equal(visibleSpan(lm, from, link.indexOf(')') + 1), null);
});

test('unmappable kinds and syntax', () => {
  assert.equal(blockMap('<div>x</div>', 'html'), null);
  assert.equal(blockMap('x $a^2$ y', 'paragraph'), null);
  assert.equal(blockMap('[[wiki]]', 'paragraph'), null);
  assert.equal(blockMap('> [!NOTE]\n> body', 'blockquote'), null);
  assert.equal(blockMap('x &#99999999; y', 'paragraph')!.visible, 'x &#99999999; y');
});

test('sameVisible', () => {
  assert.ok(sameVisible('say “hi”', 'say "hi"'));
  assert.ok(!sameVisible('say hi', 'say ho'));
});

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

test('CRLF fenced code drops the carriage returns', () => {
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
