import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { EditorState } from '@codemirror/state';
import { minimalChange, quoteOfSelection, setTracked, trackedQuote, trackedRange } from '../web/editor-view.ts';

test('minimal change trims shared prefix and suffix', () => {
  assert.deepEqual(minimalChange('abcXdef', 'abcYYdef'), { from: 3, to: 4, insert: 'YY' });
});
test('equal text yields null', () => {
  assert.equal(minimalChange('same', 'same'), null);
});
test('pure insert and pure delete', () => {
  assert.deepEqual(minimalChange('abcd', 'abXXcd'), { from: 2, to: 2, insert: 'XX' });
  assert.deepEqual(minimalChange('abXXcd', 'abcd'), { from: 2, to: 4, insert: '' });
  assert.deepEqual(minimalChange('aa', 'aaa'), { from: 2, to: 2, insert: 'a' });
});

test('a selection becomes a source quote of the saved version', () => {
  const state = EditorState.create({ doc: '# Title\n\nHello **world** now.', selection: { anchor: 15, head: 24 } });
  const quote = quoteOfSelection(state, 'v1')!;
  assert.equal(quote.exact, '**world**');
  assert.deepEqual([quote.start, quote.end, quote.version], [15, 24, 'v1']);
  assert.equal(quote.prefix, '# Title\n\nHello ');
  assert.equal(quoteOfSelection(EditorState.create({ doc: 'abc' }), 'v1'), null);
});

test('the tracked range follows edits and drops once its text is edited away', () => {
  let state = EditorState.create({ doc: 'one two three', extensions: [trackedRange] });
  state = state.update({ effects: setTracked.of({ from: 4, to: 7, exact: 'two' }) }).state;
  state = state.update({ changes: { from: 0, insert: 'zero ' } }).state;
  assert.deepEqual([trackedQuote(state, 'v2')!.start, trackedQuote(state, 'v2')!.end, trackedQuote(state, 'v2')!.exact], [9, 12, 'two']);
  state = state.update({ changes: { from: 9, to: 11, insert: '' } }).state;
  assert.equal(trackedQuote(state, 'v2'), null);
});

test('no Plannotator editor remains under web/', () => {
  const found = readdirSync(new URL('../web/', import.meta.url), { recursive: true, encoding: 'utf8' })
    .filter(file => /\.(tsx?|css)$/.test(file))
    .filter(file => /atomic-editor|markdown-editor|MarkdownEditor/.test(readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8')));
  assert.deepEqual(found, []);
});
