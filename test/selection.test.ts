import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locateQuote, surroundingSentence } from '../web/selection.ts';

test('selection anchors use UTF-16 context and reject ambiguous matches', () => {
  const quote = { exact: '😀 code', prefix: 'prefix ', suffix: ' suffix', start: 7, end: 14, version: 'old' };
  assert.deepEqual(locateQuote('Moved prefix 😀 code suffix', quote), { start: 13, end: 20 });
  assert.equal(locateQuote('prefix 😀 code suffix prefix 😀 code suffix', quote), null);
  assert.equal(locateQuote('prefix different suffix', quote), null);
});

test('renderer smart quotes preserve source anchors and DOM offsets without hiding ambiguity', () => {
  const first = "Before admission: the transfer chain must identify the same surviving party and referring CallSessions. The admission's recorded route and session destinations must also agree.";
  const second = "The graph compares the original requested extension or phone number with the admission's recorded dialed address.";
  for (const exact of [first, second]) {
    const rendered = '😀 “' + exact.replaceAll("'", '’') + '” tail';
    const quote = { exact, prefix: '😀 "', suffix: '" tail', start: 4, end: 4 + exact.length, version: 'same' };
    assert.deepEqual(locateQuote(rendered, quote), { start: 4, end: 4 + exact.length });
    assert.equal(locateQuote(rendered.replace('admission', 'completion'), quote), null);
  }
  const quote = { exact: "admission's", prefix: '', suffix: '', start: 0, end: 11, version: 'same' };
  assert.equal(locateQuote("admission’s admission's", quote), null);
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
