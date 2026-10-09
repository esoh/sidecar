import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnits, foldUnchanged, splitSegments, wrapInline } from '../web/markdown-diff.ts';

test('segments split on blank lines but keep fenced blocks whole', () => {
  assert.deepEqual(splitSegments('# A\n\ntext\nmore\n\n```js\na\n\nb\n```\n'), ['# A', 'text\nmore', '```js\na\n\nb\n```']);
});

test('inline tokens keep their block wrapper', () => {
  const tokens = [{ type: 'unchanged' as const, value: 'Keep ' }, { type: 'removed' as const, value: 'old' }, { type: 'added' as const, value: 'new' }];
  assert.match(wrapInline(tokens, { type: 'heading', level: 2 }), /^## Keep oldnew$/);
  assert.match(wrapInline(tokens, { type: 'list-item', ordered: true, orderedStart: 3, listLevel: 1, checked: false }), /^ {2}3\. \[ \] Keep /);
});

test('unchanged runs over three blocks fold, keeping one block beside each change', () => {
  const units = (...types: string[]) => types.map((type, i) => ({ type, markdown: `u${i}` }));
  type U = ReturnType<typeof units>[number];
  const shape = (items: ReturnType<typeof foldUnchanged<U>>) => items.map(item => 'fold' in item ? `fold${item.fold.units.length}` : (item.unit as unknown as { markdown: string }).markdown);
  const key = (unit: { markdown: string }) => unit.markdown;
  assert.deepEqual(shape(foldUnchanged(units('unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'added', 'unchanged', 'unchanged', 'unchanged'), new Set(), key)), ['fold4', 'u4', 'u5', 'u6', 'u7', 'u8']);
  assert.deepEqual(shape(foldUnchanged(units('added', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'removed'), new Set(), key)), ['u0', 'u1', 'fold3', 'u5', 'u6']);
  const folded = foldUnchanged(units('added', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'removed'), new Set(), key)[2];
  assert.deepEqual(shape(foldUnchanged(units('added', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'removed'), new Set(['fold' in folded ? folded.fold.key : '']), key)), ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  assert.equal(foldUnchanged(units('unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged'), new Set(), key).length, 5);
  assert.equal(foldUnchanged(units('unchanged', 'unchanged', 'unchanged', 'added', 'unchanged'), new Set(), key).length, 5);
});

test('block diffs become units with split unchanged text', () => {
  const units = buildUnits([{ type: 'unchanged', content: 'a\n\nb\n', lines: 3 }, { type: 'removed', content: 'gone\n', lines: 1 }]);
  assert.deepEqual(units.map(unit => unit.type), ['unchanged', 'unchanged', 'removed']);
});

test('a table split across diff blocks becomes one unit with whole old and new tables', () => {
  const body = '|---|---|\n| a | 1 |\n';
  const header = buildUnits([{ type: 'removed', content: '| Check | Codex |\n', lines: 1 }, { type: 'added', content: '| Check | Codex verified |\n', lines: 1 }, { type: 'unchanged', content: body, lines: 2 }]);
  assert.equal(header.length, 1);
  assert.equal(header[0].type, 'modified');
  assert.equal(header[0].old, '| Check | Codex |\n|---|---|\n| a | 1 |');
  assert.equal(header[0].markdown, '| Check | Codex verified |\n|---|---|\n| a | 1 |');
  assert.equal(header[0].tokens, undefined);
  const row = buildUnits([{ type: 'unchanged', content: '| H |\n|---|\n| a |\n', lines: 3 }, { type: 'modified', content: '| b |\n', oldContent: '| c |\n', lines: 1, inlineTokens: [{ type: 'removed', value: 'c' }, { type: 'added', value: 'b' }], inlineWrap: { type: 'paragraph' } }, { type: 'unchanged', content: '| z |\n', lines: 1 }]);
  assert.equal(row.length, 1);
  assert.equal(row[0].old, '| H |\n|---|\n| a |\n| c |\n| z |');
  assert.equal(row[0].markdown, '| H |\n|---|\n| a |\n| b |\n| z |');
  const added = buildUnits([{ type: 'unchanged', content: '| H |\n|---|\n', lines: 2 }, { type: 'added', content: '| n |\n', lines: 1 }]);
  assert.deepEqual(added.map(unit => unit.type), ['modified']);
  assert.equal(buildUnits([{ type: 'added', content: '| a |\n', lines: 1 }, { type: 'added', content: '| b |\n', lines: 1 }])[0].type, 'added');
});

test('text around a table and unchanged tables stay separate', () => {
  const units = buildUnits([{ type: 'modified', content: 'new intro\n', oldContent: 'intro\n', lines: 1 }, { type: 'unchanged', content: '\n| H |\n|---|\n| a |\n\n', lines: 5 }, { type: 'added', content: 'outro\n', lines: 1 }]);
  assert.deepEqual(units.map(unit => unit.type), ['modified', 'unchanged', 'added']);
  assert.equal(buildUnits([{ type: 'unchanged', content: '| H |\n|---|\n\n| G |\n|---|\n', lines: 5 }]).length, 2);
});
