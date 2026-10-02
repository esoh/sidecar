import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locateQuote, surroundingSentence } from '../web/selection.ts';

test('selection anchors use UTF-16 context and reject ambiguous matches', () => {
  const quote = { exact: '😀 code', prefix: 'prefix ', suffix: ' suffix', start: 7, end: 14, version: 'old' };
  assert.deepEqual(locateQuote('Moved prefix 😀 code suffix', quote), { start: 13, end: 20 });
  assert.equal(locateQuote('prefix 😀 code suffix prefix 😀 code suffix', quote), null);
  assert.equal(locateQuote('prefix different suffix', quote), null);
});

test('sentence context is mechanical, bounded, and omitted for whole or multi-sentence selections', () => {
  const text = 'Previous sentence. The widget retries three times. Next sentence.';
  const start = text.indexOf('three');
  assert.equal(surroundingSentence(text, start, start + 5), 'The widget retries three times.');
  const sentenceStart = text.indexOf('The widget');
  const sentenceEnd = text.indexOf(' Next');
  assert.equal(surroundingSentence(text, sentenceStart, sentenceEnd), undefined);
  assert.equal(surroundingSentence(text, sentenceStart, text.length), undefined);
  assert.equal(surroundingSentence('word ' + 'x'.repeat(600) + '.', 0, 4), undefined);
  assert.equal(surroundingSentence('Use 😀 twice. Done.', 4, 6), 'Use 😀 twice.');
});
