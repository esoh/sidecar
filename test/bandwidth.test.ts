import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './support.ts';

test('large viewer responses compress without caching conversation data or ignoring encoding preferences', async t => {
  const f = await fixture(t), doc = await f.register('large.md', '# Review\n\n' + 'Some repeated document text. '.repeat(300));
  const path = `/api/documents/${doc.id}`;
  const compressed = await fetch(f.url + path, { headers: { Cookie: f.cookie, 'Accept-Encoding': 'gzip' } });
  const text = await compressed.text();
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.ok(Number(compressed.headers.get('content-length')) < Buffer.byteLength(text) / 2);
  assert.equal(compressed.headers.get('cache-control'), 'no-store');
  assert.match(compressed.headers.get('vary') ?? '', /Accept-Encoding/i);
  for (const encoding of ['identity', 'gzip;q=0, *;q=1']) {
    const response = await fetch(f.url + path, { headers: { Cookie: f.cookie, 'Accept-Encoding': encoding } });
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(await response.text(), text);
  }
});

test('static assets are compressed and revalidated only after viewer authentication', async t => {
  const f = await fixture(t);
  for (const path of ['/app.js', '/app.css', '/renderer.css']) {
    const response = await fetch(f.url + path, { headers: { Cookie: f.cookie, 'Accept-Encoding': 'gzip' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    const body = await response.text(), etag = response.headers.get('etag');
    assert.ok(body.length > 1000); assert.ok(etag);
    assert.equal(response.headers.get('cache-control'), 'private, no-cache');
    const cached = await fetch(f.url + path, { headers: { Cookie: f.cookie, 'If-None-Match': etag } });
    assert.equal(cached.status, 304); assert.equal(await cached.text(), '');
    const unauthenticated = await fetch(f.url + path, { headers: { 'If-None-Match': etag } });
    assert.equal(unauthenticated.status, 403);
    await unauthenticated.text();
  }
});

test('saved progress retires by message identity even when later history is still in flight', async t => {
  const { mergeRuntime } = await import('../web/api.ts');
  const f = await fixture(t), doc = await f.register();
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Explain', clientMessageId: 'handoff' })).json();
  await f.agent(`/agent/requests/${request.id}/claim`, {});
  const markers = await (await f.agent('/agent/streams', { requestId: request.id, documentId: doc.id, threadId: request.threadId })).json();
  const emit = (messageId: string, index: number, delta: string, final = false) => f.agent('/agent/stream-events', { ownerKey: `claude-${f.owner.sessionId}`, messageId, turnId: 'handoff', index, delta, final });
  const state = async () => (await (await f.view('/api/state')).json());
  await emit('progress', 0, markers.progress.prefix + 'Progress text');
  const visible = await state();
  await emit('progress', 1, markers.progress.suffix, true);
  const firstHistory = await state();
  await emit('final', 0, markers.prefix + 'Final answer');
  await f.view(`/api/documents/${doc.id}/title`, { title: 'Another change' }, 'PATCH');
  const latest = await state();
  // The first HTTP response integrates saved progress while a newer refresh is still pending.
  const { stateRevision, runtimeRevision, stream, activity, reset, connectionError } = latest;
  const merged = mergeRuntime({ ...firstHistory, stream: visible.stream }, { stateRevision, runtimeRevision, stream, activity, reset, connectionError });
  assert.equal(merged.stream?.text, 'Final answer');
  assert.equal(merged.threads[request.threadId].messages.filter(message => message.role === 'agent').length, 1);
  assert.equal(visible.stream.progressMessageId, firstHistory.threads[request.threadId].messages.at(-1).id);
});
