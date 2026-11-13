import assert from 'node:assert/strict';
import { test } from 'node:test';
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

test('entities and escapes', () => {
  const s = 'a &amp; b \\* c';
  assert.equal(blockMap(s, 'paragraph')!.visible, 'a & b * c');
  assert.equal(pick(s, 'paragraph', '&'), '&amp;');
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
  assert.equal(pick(s, 'table', 'c d'), '| c | d |');
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
  assert.equal(blockMap('a <b>x</b>', 'paragraph'), null);
  assert.equal(blockMap('a &bogus; b', 'paragraph'), null);
});

test('sameVisible', () => {
  assert.ok(sameVisible('say “hi”', 'say "hi"'));
  assert.ok(!sameVisible('say hi', 'say ho'));
});
