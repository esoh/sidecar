import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './support.ts';
import { readSavedState } from '../src/store.ts';

test('one same-thread batch preserves per-message context and completes once without absorbing later work', async t => {
  const f = await fixture(t), doc = await f.register(), otherDoc = await f.register('other.md');
  const post = async (body: object) => (await f.view('/api/questions', body)).json();
  const first = await post({ documentId: doc.id, text: 'Explain this', clientMessageId: 'first' });
  const other = await post({ documentId: doc.id, text: 'Separate thread', clientMessageId: 'other' });
  const otherDocument = await post({ documentId: otherDoc.id, text: 'Other document', clientMessageId: 'other-doc' });
  const quote = { exact: 'world', prefix: 'Hello ', suffix: '.', start: 6, end: 11, version: 'saved', sentence: 'Hello world.' };
  const second = await post({ documentId: doc.id, threadId: first.threadId, text: 'Especially this word', quote, clientMessageId: 'second' });
  const before = await (await f.view('/api/state')).json();
  const messageQuote = { threadId: first.threadId, messageId: before.threads[first.threadId].messages[0].id, exact: 'Explain this' };
  const third = await post({ documentId: doc.id, threadId: first.threadId, text: 'And this question', messageQuote, clientMessageId: 'third' });
  const prepared = await (await f.agent(`/agent/requests/${first.id}/prepare`, {})).json();
  assert.deepEqual(prepared.messages, [
    { requestId: first.id, text: 'Explain this' },
    { requestId: second.id, text: 'Especially this word', quote: { exact: 'world', sentence: 'Hello world.' } },
    { requestId: third.id, text: 'And this question', messageQuote },
  ]);
  assert.equal(prepared.text, undefined, 'batch questions appear once');
  assert.equal(prepared.thread.lastRequestId, null);
  const late = await post({ documentId: doc.id, threadId: first.threadId, text: 'Arrived later', clientMessageId: 'late' });
  await f.agent(`/agent/requests/${first.id}/accepted`, {});
  let saved = await (await f.view('/api/state')).json();
  for (const request of [first, second, third]) {
    assert.equal(saved.requests[request.id].status, 'claimed');
    assert.ok(saved.requests[request.id].acceptedAt);
  }
  for (const request of [other, otherDocument, late]) assert.equal(saved.requests[request.id].status, 'queued');
  assert.equal((await f.agent(`/agent/requests/${second.id}/claim`, {})).status, 409, 'only the batch leader owns reply capture');
  const recovery = await (await f.agent(`/agent/requests/${first.id}/claim`, {})).json();
  assert.equal(recovery.claimStatus, 'already-claimed');
  assert.deepEqual(recovery.messages, prepared.messages);
  assert.deepEqual(recovery.stream, prepared.stream);
  const answer = { requestId: first.id, documentId: doc.id, threadId: first.threadId, text: 'One combined answer' };
  assert.equal((await f.agent('/agent/replies', answer)).status, 200);
  assert.equal((await f.agent('/agent/replies', answer)).status, 200);
  saved = await (await f.view('/api/state')).json();
  for (const request of [first, second, third]) assert.equal(saved.requests[request.id].status, 'completed');
  assert.deepEqual(saved.threads[first.threadId].messages.filter((m: any) => m.role === 'agent').map((m: any) => m.text), ['One combined answer']);
  assert.deepEqual(saved.threads[first.threadId].messages.filter((m: any) => m.role === 'user').map((m: any) => m.text), ['Explain this', 'Especially this word', 'And this question', 'Arrived later']);
  const next = await (await f.agent(`/agent/requests/${late.id}/prepare`, {})).json();
  assert.equal(next.text, 'Arrived later');
  assert.equal(next.thread.lastRequestId, third.id, 'continuity points to the last batched input');
});

test('interrupted batches resume the same membership and failure completes every member', async t => {
  const f = await fixture(t), doc = await f.register();
  const first = await (await f.view('/api/questions', { documentId: doc.id, text: 'First', clientMessageId: 'first' })).json();
  const second = await (await f.view('/api/questions', { documentId: doc.id, threadId: first.threadId, text: 'Second', clientMessageId: 'second' })).json();
  await f.agent(`/agent/requests/${first.id}/prepare`, {});
  await f.reopen();
  const late = await (await f.view('/api/questions', { documentId: doc.id, threadId: first.threadId, text: 'Late', clientMessageId: 'late' })).json();
  const uncertain = await (await f.agent(`/agent/requests/${first.id}/claim`, {})).json();
  assert.equal(uncertain.claimStatus, 'uncertain');
  assert.deepEqual(uncertain.messages.map((m: any) => m.requestId), [first.id, second.id]);
  const resumed = await (await f.agent(`/agent/requests/${first.id}/claim`, { resume: true })).json();
  assert.equal(resumed.claimStatus, 'claimed');
  await f.agent('/agent/replies', { requestId: first.id, documentId: doc.id, threadId: first.threadId, text: 'Cannot finish', isError: true });
  const saved = await (await f.view('/api/state')).json();
  assert.equal(saved.requests[first.id].status, 'failed');
  assert.equal(saved.requests[second.id].status, 'failed');
  assert.equal(saved.requests[late.id].status, 'queued');
  assert.equal(saved.threads[first.threadId].messages.filter((m: any) => m.role === 'agent').length, 1);
});

test('oversized batches freeze before ID-only handoff and recover every question', async t => {
  const f = await fixture(t), doc = await f.register();
  const first = await (await f.view('/api/questions', { documentId: doc.id, text: 'a'.repeat(30000), clientMessageId: 'first' })).json();
  const second = await (await f.view('/api/questions', { documentId: doc.id, threadId: first.threadId, text: 'b'.repeat(30000), clientMessageId: 'second' })).json();
  const event = await (await f.agent(`/agent/requests/${first.id}/prepare`, {})).json();
  assert.equal(event.stream, undefined);
  assert.equal(event.messages, undefined);
  const late = await (await f.view('/api/questions', { documentId: doc.id, threadId: first.threadId, text: 'Late', clientMessageId: 'late' })).json();
  const recovered = await (await f.agent(`/agent/requests/${first.id}/claim`, {})).json();
  assert.equal(recovered.claimStatus, 'claimed');
  assert.deepEqual(recovered.messages.map((m: any) => [m.requestId, m.text.length]), [[first.id, 30000], [second.id, 30000]]);
  assert.equal((await (await f.view('/api/state')).json()).requests[late.id].status, 'queued');
});

test('batched file questions retain each input’s own file quote', async t => {
  const f = await fixture(t), doc = await f.register();
  const registered = await (await f.agent('/agent/documents', { path: doc.path, workspace: f.directory })).json();
  const firstQuote = { path: `${registered.workspace}/first.ts`, kind: 'code', exact: 'return true;', startLine: 2, endLine: 2 };
  const secondQuote = { path: `${registered.workspace}/second.yml`, kind: 'doc', exact: 'enabled: true', startLine: 1, endLine: 1 };
  const first = await (await f.view('/api/questions', { documentId: doc.id, text: 'Explain this code', fileQuote: firstQuote, clientMessageId: 'file-first' })).json();
  const second = await (await f.view('/api/questions', { documentId: doc.id, threadId: first.threadId, text: 'Compare with this setting', fileQuote: secondQuote, clientMessageId: 'file-second' })).json();
  const event = await (await f.agent(`/agent/requests/${first.id}/prepare`, {})).json();
  assert.deepEqual(event.messages, [
    { requestId: first.id, text: 'Explain this code', fileQuote: firstQuote },
    { requestId: second.id, text: 'Compare with this setting', fileQuote: secondQuote },
  ]);
});

test('saved batch membership cannot cross threads or disagree about completion', async t => {
  const f = await fixture(t), doc = await f.register();
  const first = await (await f.view('/api/questions', { documentId: doc.id, text: 'First', clientMessageId: 'first' })).json();
  const second = await (await f.view('/api/questions', { documentId: doc.id, threadId: first.threadId, text: 'Second', clientMessageId: 'second' })).json();
  const other = await (await f.view('/api/questions', { documentId: doc.id, text: 'Other thread', clientMessageId: 'other' })).json();
  await f.agent(`/agent/requests/${first.id}/prepare`, {});
  await f.agent(`/agent/requests/${first.id}/accepted`, {});
  const saved = await (await f.view('/api/state')).json();
  assert.equal(readSavedState(saved).requests[second.id].batchId, first.id);
  for (const mutation of [
    { batchId: 1 },
    { batchId: other.id },
    { status: 'completed' },
  ]) {
    const bad = structuredClone(saved);
    Object.assign(bad.requests[second.id], mutation);
    assert.throws(() => readSavedState(bad), /Malformed/);
  }
});
