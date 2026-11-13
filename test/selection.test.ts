import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshQuote, locateQuote, matchQuote, resolveQuote, sourceQuote } from '../web/selection.ts';

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

test('sourceQuote carries 32 characters of source context that matchQuote finds at the same position', () => {
  const source = '# Title\n\nHello **world**. ' + 'x'.repeat(40) + '\n';
  const start = source.indexOf('Hello **wor'), end = start + 'Hello **wor'.length;
  const quote = sourceQuote(source, start, end, 'v1');
  assert.equal(quote.exact, 'Hello **wor');
  assert.equal(quote.prefix, '# Title\n\n');
  assert.equal(quote.suffix.length, 32);
  assert.deepEqual(matchQuote(source, quote, 'v1'), { status: 'found', matches: [{ start, end }] });
});

test('a duplicate passage resolves to the second occurrence through its source context', () => {
  const source = 'Intro.\n\nSame **line**.\n\nMiddle.\n\nSame **line**.\n';
  const second = source.lastIndexOf('Same **line**.');
  const quote = sourceQuote(source, second, second + 'Same **line**.'.length, 'v1');
  assert.deepEqual(locateQuote(source, quote, 'v1'), { start: second, end: second + 14 });
  assert.deepEqual(locateQuote(source, { ...quote, isPositionVerified: false }, 'v1'), { start: second, end: second + 14 });
});

test('freshQuote passes a valid quote through, restamps a stale one and blocks a lost or ambiguous one', () => {
  const source = '# Title\n\nBody with a marker inside.\n';
  const valid = sourceQuote(source, source.indexOf('marker'), source.indexOf('marker') + 6, 'v2');
  assert.equal(freshQuote(valid, source, 'v2'), valid);
  // Made against unsaved text (typed text before it), stamped with the version before the save.
  const stale = sourceQuote('Intro.\n\n' + source, 'Intro.\n\n'.length + source.indexOf('marker'), 'Intro.\n\n'.length + source.indexOf('marker') + 6, 'v1');
  const fresh = freshQuote(stale, 'Intro.\n\n' + source, 'v2') as ReturnType<typeof sourceQuote>;
  assert.equal(fresh.version, 'v2');
  assert.equal(('Intro.\n\n' + source).slice(fresh.start, fresh.end), fresh.exact);
  const unsavedSource = source;
  const restamped = freshQuote(stale, unsavedSource, 'v2');
  assert.equal(typeof restamped, 'string');
  assert.equal(freshQuote(valid, 'Nothing here.', 'v3'), 'Passage changed');
  const twice = 'a marker and another marker';
  assert.equal(freshQuote({ ...valid, prefix: '', suffix: '' }, twice, 'v3'), 'Multiple matching passages');
});
