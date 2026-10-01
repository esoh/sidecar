import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locateQuote } from '../web/selection.ts';

test('selection anchors use UTF-16 context and reject ambiguous matches', () => {
  const quote = { exact: '😀 code', prefix: 'prefix ', suffix: ' suffix', start: 7, end: 14, version: 'old' };
  assert.deepEqual(locateQuote('Moved prefix 😀 code suffix', quote), { start: 13, end: 20 });
  assert.equal(locateQuote('prefix 😀 code suffix prefix 😀 code suffix', quote), null);
  assert.equal(locateQuote('prefix different suffix', quote), null);
});
