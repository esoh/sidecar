import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locateQuote, matchQuote, resolveQuote, surroundingSentence } from '../web/selection.ts';

test('duplicate agent quotes are ambiguous, not changed, and need explicit disambiguation', () => {
  const text = 'Review\nAuthor Summary\nNew introduction.\nSee Author Summary.';
  const quote = { exact: 'Author Summary', prefix: '', suffix: '', start: 0, end: 14, version: 'original' };
  const result = matchQuote(text, quote, 'original');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.matches.length, 2);
  assert.equal(matchQuote(text, { ...quote, suffix: '\nNew introduction.' }).status, 'found');
  const resolved = resolveQuote(text, quote, result.matches[0]!);
  assert.equal(resolved.isPositionVerified, true);
  assert.equal(resolved.version, 'original');
  assert.deepEqual(locateQuote(text, resolved, 'original'), result.matches[0]);
  const shifted = 'Added above.\n' + text;
  assert.deepEqual(locateQuote(shifted, resolved, 'later'), { start: 20, end: 34 });
  assert.equal(matchQuote('No heading here.', resolved).status, 'missing');
  assert.equal(matchQuote('Author Summary\nA different introduction.', resolved).status, 'context-changed');
});

test('verified positions disambiguate only their own immutable version', () => {
  const text = ('x'.repeat(600) + 'same' + 'x'.repeat(600)).repeat(2);
  const quote = { exact: 'same', prefix: '', suffix: '', start: 0, end: 4, version: 'original' };
  const result = matchQuote(text, quote);
  const resolved = resolveQuote(text, quote, result.matches[1]!);
  assert.deepEqual(locateQuote(text, resolved, 'original'), result.matches[1]);
  assert.equal(locateQuote(text, resolved, 'later'), null);
  assert.equal(locateQuote(text, { ...resolved, isPositionVerified: undefined }, 'original'), null);
  assert.throws(() => resolveQuote(text, quote, { start: 0, end: 4 }));
});

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
