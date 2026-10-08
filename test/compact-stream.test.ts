import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReplyStream, ThreadReplyRouter, compactReplyMarkers, findReplyBlocks } from '../src/stream.ts';
import { parseReply } from '../src/reply-metadata.ts';
const route = { requestId: 'request-a', documentId: 'doc', threadId: 'thread-a' };
test('compact delimiters split at every position preserve final metadata and text', () => {
  assert.deepEqual(compactReplyMarkers('rC'), { prefix: '[[sc:rC]]\n', suffix: '\n[[/sc:rC]]', progress: { prefix: '[[scp:rC]]\n', suffix: '\n[[/scp:rC]]' } });
  const raw = '[[sc:rC]]\n[[sc-meta {"threadTitle":"Changed","highlights":[{"exact":"heading"}]}]]\nAnswer.\n[[/sc:rC]]';
  for (let split = 1; split < raw.length; split++) {
    const stream = new ReplyStream(route, true, 'rC');
    stream.accept({ messageId: 'm', turnId: 't', index: 1, delta: raw.slice(split), final: true });
    stream.accept({ messageId: 'm', turnId: 't', index: 0, delta: raw.slice(0, split), final: false });
    assert.equal(stream.done, true); assert.equal(stream.text, 'Answer.');
    assert.deepEqual(stream.metadata, { threadTitle: 'Changed', highlights: [{ exact: 'heading' }] });
  }
});
test('compact progress does not finalize and a later answer does', () => {
  const stream = new ReplyStream(route, true, 'r1');
  const update = stream.accept({ messageId: 'p', turnId: 'a', index: 0, delta: '[[scp:r1]]\nChecking.\n[[/scp:r1]]', final: true });
  assert.equal(update?.text, 'Checking.'); assert.equal(stream.done, false); assert.equal(stream.hasFinalStarted, false);
  stream.accept({ messageId: 'f', turnId: 'b', index: 0, delta: '[[sc:r1]]\nDone.\n[[/sc:r1]]', final: true });
  assert.equal(stream.done, true);
});
test('fenced marker examples cannot finalize or route another request', () => {
  for (const fence of ['```', '~~~~']) {
    const a = new ReplyStream(route, true, 'r1'), b = new ReplyStream({ ...route, requestId: 'b', threadId: 'b' }, true, 'r2');
    const streams = new Map([[route.requestId, a], ['b', b]]), router = new ThreadReplyRouter();
    const body = `Example:\n${fence}\n[[/sc:r1]]\n[[sc:r2]]\nNot an answer\n[[/sc:r2]]\n${fence}\nActual answer.`;
    const raw = `[[sc:r1]]\n${body}\n[[/sc:r1]]\n[[sc:r2]]\nSecond answer.\n[[/sc:r2]]`;
    assert.equal(findReplyBlocks(raw, streams).length, 2);
    for (let i = 0; i < raw.length; i++) for (const item of router.accept({ messageId: 'm', turnId: 't', index: i, delta: raw[i], final: i === raw.length - 1 }, streams)) item.stream.accept(item.event);
    assert.equal(a.text, body); assert.equal(b.text, 'Second answer.'); assert.equal(a.done && b.done, true);
  }
});
test('unknown receipts and wrong closing IDs cannot complete an active request', () => {
  const stream = new ReplyStream(route, true, 'r1'), streams = new Map([[route.requestId, stream]]);
  assert.deepEqual(findReplyBlocks('[[sc:r2]]\nWrong owner\n[[/sc:r2]]', streams), []);
  stream.accept({ messageId: 'm', turnId: 't', index: 0, delta: '[[sc:r1]]\nIncomplete\n[[/sc:r2]]', final: true });
  assert.equal(stream.done, false); assert.ok(stream.error);
});
test('partial compact metadata is hidden and malformed metadata preserves the answer', () => {
  const raw = '[[sc-meta {"threadTitle":"Title"}]]\n';
  for (let n = 1; n < raw.length; n++) assert.equal(parseReply(raw.slice(0, n)).text, '');
  assert.deepEqual(parseReply('[[sc-meta bad]]\nAnswer'), { text: 'Answer', metadata: {} });
});
