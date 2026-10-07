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

test('interleaved thread output sends small runtime events without repeating document or history', async t => {
  const f = await fixture(t, 10000);
  const doc = await f.register('large.md', '# Large\n' + 'DOCUMENT_BANDWIDTH_SENTINEL '.repeat(10000));
  for (let i = 0; i < 12; i++) {
    const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'HISTORY_BANDWIDTH_SENTINEL '.repeat(100), clientMessageId: `history-${i}` })).json();
    await f.agent(`/agent/requests/${request.id}/claim`, {});
    await f.agent('/agent/replies', { requestId: request.id, threadId: request.threadId, documentId: doc.id, text: 'Saved answer' });
  }
  const abort = new AbortController(); t.after(() => abort.abort());
  const response = await fetch(f.url + '/api/events?updates=1', { headers: { Cookie: f.cookie }, signal: abort.signal });
  let received = '';
  const reading = (async () => { try { for await (const chunk of response.body!) received += new TextDecoder().decode(chunk); } catch { /* Deliberate close after measurement. */ } })();
  const prepared = [];
  for (let i = 0; i < 2; i++) {
    const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'New question', clientMessageId: `live-${i}` })).json();
    const event = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
    await f.agent(`/agent/requests/${request.id}/accepted`, {}); prepared.push(event);
  }
  for (let i = 0; i < 25; i++) for (let thread = 0; thread < 2; thread++) {
    const event = prepared[thread];
    await f.agent('/agent/stream-events', { ownerKey: `claude-${f.owner.sessionId}`, messageId: `reply-${thread}`, turnId: 'native-turn', index: i, delta: (i === 0 ? event.stream.prefix : '') + 'Small streamed chunk. ', final: false });
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  const measuredBytes = Buffer.byteLength(received);
  t.diagnostic(`50 interleaved chunks: ${measuredBytes} SSE bytes`);
  assert.ok(received.includes('event: runtime'));
  assert.ok(!received.includes('DOCUMENT_BANDWIDTH_SENTINEL') && !received.includes('HISTORY_BANDWIDTH_SENTINEL'));
  assert.ok(measuredBytes < 32 * 1024, `50 chunks used ${measuredBytes} bytes; history must not ride with output`);
  const beforeIdle = received;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(received, beforeIdle, 'idle runtime does not emit repeated state');
  abort.abort(); await reading;
});
