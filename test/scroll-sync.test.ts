import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorFraction, anchorY, mapY, targetScrollTop, type Segment } from '../web/scroll-sync.ts';

const segments: Segment[] = [
  { source: [0, 100], preview: [0, 40] },
  { source: [100, 300], preview: [40, 240] },
  { source: [300, 400], preview: [240, 300] },
];

test('anchorFraction is the chosen fraction mid-document and eases to the edges in the first and last screen', () => {
  // scrollHeight 1000, clientHeight 200: max scroll 800.
  for (const f of [0.25, 0.5]) {
    assert.equal(anchorFraction(0, 1000, 200, f), 0);
    assert.equal(anchorFraction(100, 1000, 200, f), f / 2);
    assert.equal(anchorFraction(200, 1000, 200, f), f);
    assert.equal(anchorFraction(400, 1000, 200, f), f);
    assert.equal(anchorFraction(600, 1000, 200, f), f);
    assert.equal(anchorFraction(700, 1000, 200, f), 1 - (1 - f) / 2);
    assert.equal(anchorFraction(800, 1000, 200, f), 1);
  }
  assert.equal(anchorFraction(0, 100, 200, 0.25), 0.25); // fits in the viewport
});

test('anchorFraction is continuous and monotonic, including in a document shorter than two screens', () => {
  for (const [scrollHeight, clientHeight] of [[1000, 200], [350, 200], [250, 200]]) {
    let last = 0;
    const max = scrollHeight - clientHeight;
    for (let s = 0; s <= max; s += max / 400) {
      const fraction = anchorFraction(s, scrollHeight, clientHeight, 0.25);
      assert.ok(fraction >= last - 1e-12 && fraction - last < 0.02, `${scrollHeight} at ${s}`);
      last = fraction;
    }
    assert.equal(anchorFraction(0, scrollHeight, clientHeight, 0.25), 0);
    assert.ok(Math.abs(anchorFraction(max, scrollHeight, clientHeight, 0.25) - 1) < 1e-12);
  }
});

test('anchorY places the anchor at scrollTop plus the fraction of the viewport', () => {
  assert.equal(anchorY(400, 1000, 200, 0.25), 450);
  assert.equal(anchorY(0, 1000, 200, 0.25), 0);
  assert.equal(anchorY(800, 1000, 200, 0.25), 1000);
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

test('targetScrollTop: both panes reach 0 and their maximum together', () => {
  const from = { scrollHeight: 400, clientHeight: 100 }, to = { scrollHeight: 300, clientHeight: 100 };
  for (const f of [0.25, 0.5]) {
    assert.equal(targetScrollTop(segments, 'source', 0, from, to, f), 0);
    assert.ok(Math.abs(targetScrollTop(segments, 'source', 300, from, to, f) - 200) < 1e-6);
    assert.ok(Math.abs(targetScrollTop(segments, 'preview', 200, to, from, f) - 300) < 1e-6);
  }
});

test('targetScrollTop puts the mapped point at the target anchor and round-trips', () => {
  const from = { scrollHeight: 1000, clientHeight: 200 }, to = { scrollHeight: 800, clientHeight: 200 };
  const wide: Segment[] = [{ source: [0, 1000], preview: [0, 800] }];
  for (const f of [0.25, 0.5]) for (const s of [0, 60, 200, 450, 700, 800]) {
    const top = targetScrollTop(wide, 'source', s, from, to, f);
    assert.ok(Math.abs(anchorY(top, 800, 200, f) - mapY(wide, 'source', anchorY(s, 1000, 200, f))) < 1e-6);
    assert.ok(Math.abs(targetScrollTop(wide, 'preview', top, to, from, f) - s) < 1e-6);
  }
});

test('targetScrollTop clamps to the target scroll range', () => {
  const from = { scrollHeight: 400, clientHeight: 100 };
  assert.equal(targetScrollTop(segments, 'source', 5000, from, { scrollHeight: 50, clientHeight: 100 }, 0.25), 0);
  assert.equal(targetScrollTop(segments, 'source', 300, from, { scrollHeight: 120, clientHeight: 100 }, 0.25), 20);
  assert.equal(targetScrollTop(segments, 'source', 0, from, { scrollHeight: 300, clientHeight: 100 }, 0.5), 0);
});

test('anchorFraction and targetScrollTop hold at the extremes of f and in documents barely over one screen', () => {
  for (const f of [0, 1]) for (const [scrollHeight, clientHeight] of [[1000, 200], [201, 200], [350, 200]]) {
    const max = scrollHeight - clientHeight;
    assert.equal(anchorFraction(0, scrollHeight, clientHeight, f), 0);
    assert.ok(Math.abs(anchorFraction(max, scrollHeight, clientHeight, f) - 1) < 1e-12);
    let last = -1;
    for (let s = 0; s <= max; s += max / 100) { const y = anchorY(s, scrollHeight, clientHeight, f); assert.ok(y >= last - 1e-9); last = y; }
  }
  // Zone = max / 2 (under two screens), and a target shorter than its viewport.
  const wide: Segment[] = [{ source: [0, 350], preview: [0, 100] }];
  assert.equal(targetScrollTop(wide, 'source', 150, { scrollHeight: 350, clientHeight: 200 }, { scrollHeight: 100, clientHeight: 200 }, 0.25), 0);
  assert.equal(anchorFraction(75, 350, 200, 0.25), 0.25);
  assert.equal(anchorFraction(37.5, 350, 200, 0.25), 0.125);
});
