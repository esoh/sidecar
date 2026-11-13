import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorY, mapY, targetScrollTop, type Segment } from '../web/scroll-sync.ts';

const segments: Segment[] = [
  { source: [0, 100], preview: [0, 40] },
  { source: [100, 300], preview: [40, 240] },
  { source: [300, 400], preview: [240, 300] },
];

test('anchor slides from the top of the viewport to the bottom', () => {
  assert.equal(anchorY(0, 1000, 200), 0);
  assert.equal(anchorY(400, 1000, 200), 400 + 100);
  assert.equal(anchorY(800, 1000, 200), 1000);
});

test('mapY keeps the fraction within the containing segment, both ways', () => {
  assert.equal(mapY(segments, 'source', 100 + 80), 40 + 80);
  assert.equal(mapY(segments, 'preview', 40 + 80), 100 + 80);
  assert.equal(mapY(segments, 'source', 50), 20);
  assert.equal(mapY(segments, 'source', 400), 300);
  assert.equal(mapY(segments, 'source', 999), 300);
});

test('mapY skips zero-height segments', () => {
  const gap: Segment[] = [{ source: [0, 10], preview: [0, 0] }, { source: [10, 20], preview: [0, 30] }];
  assert.equal(mapY(gap, 'preview', 15), 15);
  assert.equal(mapY(gap, 'source', 5), 0);
});

test('targetScrollTop: ends align and the start is zero', () => {
  const from = { scrollHeight: 400, clientHeight: 100 }, to = { scrollHeight: 300, clientHeight: 100 };
  assert.equal(targetScrollTop(segments, 'source', 0, from, to), 0);
  assert.equal(targetScrollTop(segments, 'source', 300, from, to), 200);
  assert.equal(targetScrollTop(segments, 'preview', 200, to, from), 300);
});

test('targetScrollTop puts the mapped point at the target anchor and clamps', () => {
  const from = { scrollHeight: 400, clientHeight: 100 }, to = { scrollHeight: 300, clientHeight: 100 };
  const top = targetScrollTop(segments, 'source', 150, from, to);
  assert.ok(Math.abs(anchorY(top, 300, 100) - mapY(segments, 'source', anchorY(150, 400, 100))) < 1e-9);
  assert.equal(targetScrollTop(segments, 'source', 5000, from, { scrollHeight: 50, clientHeight: 100 }), 0);
});
