import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FileQuote } from '../src/quote.ts';
import { locateFileQuote } from '../web/edit-quotes.ts';

const quote = (exact: string, startLine?: number): FileQuote => ({ path: '/a.md', kind: 'doc', exact, ...(startLine ? { startLine, endLine: startLine } : {}) });
const lines = ['one', 'target', 'x', 'x', 'x', 'x', 'x', 'x', 'target', 'end'];

test('finds the occurrence nearest the quoted start line', () => {
  const source = lines.join('\n');
  const at = source.lastIndexOf('target');
  assert.deepEqual(locateFileQuote(source, quote('target', 8)), { from: at, to: at + 6 });
  assert.deepEqual(locateFileQuote(source, quote('target', 3)), { from: 4, to: 10 });
});
test('finds text that moved to other lines', () => {
  assert.deepEqual(locateFileQuote('a\nb\nc\nmoved here\n', quote('moved', 1)), { from: 6, to: 11 });
});
test('returns null when the text is gone', () => {
  assert.equal(locateFileQuote('nothing here', quote('target', 1)), null);
});
test('handles a multi-line exact', () => {
  assert.deepEqual(locateFileQuote('a\nb\nc\nd\n', quote('b\nc', 2)), { from: 2, to: 5 });
});
test('a one-character quote in a large document resolves quickly and correctly', () => {
  const source = 'a\n'.repeat(100000) + 'b';
  const started = Date.now();
  assert.deepEqual(locateFileQuote(source, quote('a', 100000)), { from: 199998, to: 199999 });
  assert.ok(Date.now() - started < 2000);
});
