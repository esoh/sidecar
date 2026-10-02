import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './support.ts';

async function setup(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const doc = await f.register();
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Explain', clientMessageId: 'stream' })).json();
  await f.agent(`/agent/requests/${request.id}/claim`, {});
  const route = { requestId: request.id, documentId: doc.id, threadId: request.threadId };
  const started = await f.agent('/agent/streams', route);
  assert.equal(started.status, 200);
  const markers = await started.json();
  const emit = (index: number, delta: string, final = false, messageId = 'message-a') => f.agent('/agent/stream-events', { ownerKey: `claude-${f.owner.sessionId}`, messageId, turnId: 'turn-a', index, delta, final });
  const snapshot = async () => (await f.view('/api/state')).json();
  return { f, request, route, markers, emit, snapshot };
}

test('streamed text stays routed, incomplete, and escaped until native completion', async t => {
  const { f, request, route, markers, emit, snapshot } = await setup(t);
  await emit(0, 'Unrelated conversation.', true, 'unrelated');
  assert.equal((await snapshot()).stream.text, '');
  await emit(0, markers.prefix.slice(0, 8));
  await emit(1, markers.prefix.slice(8) + 'First <script>');
  assert.equal((await snapshot()).stream.text, 'First <script>');
  assert.equal((await snapshot()).requests[request.id].status, 'claimed');
  assert.equal((await f.agent('/agent/replies', { ...route, stream: true })).status, 409);
  await emit(1, markers.prefix.slice(8) + 'First <script>'); // Duplicate delivery.
  await emit(2, ' second.' + markers.suffix.slice(0, 9));
  assert.equal((await snapshot()).stream.text, 'First <script> second.');
  await emit(3, markers.suffix.slice(9) + '\n', true); // Native Codex appends a trailing newline.
  assert.equal((await f.agent('/agent/replies', { ...route, threadId: 'wrong', stream: true })).status, 409);
  assert.equal((await f.agent('/agent/replies', { ...route, stream: true })).status, 200);
  assert.equal((await f.agent('/agent/replies', { ...route, stream: true })).status, 200);
  await emit(4, 'late', true);
  const state = await snapshot();
  assert.equal(state.stream, null);
  assert.equal(state.requests[request.id].status, 'completed');
  assert.equal(state.threads[request.threadId].messages.at(-1).text, 'First <script> second.');
  assert.equal(state.threads[request.threadId].messages.length, 2);
});

test('missing chunks cannot finalize a partial answer; ordinary replies recover', async t => {
  const { f, route, markers, emit, snapshot } = await setup(t);
  await emit(0, markers.prefix + 'Partial');
  await emit(2, ' lost text' + markers.suffix, true);
  assert.equal((await snapshot()).stream.done, false);
  assert.equal((await f.agent('/agent/replies', { ...route, stream: true })).status, 409);
  await f.agent('/agent/replies', { ...route, text: 'Complete replacement' });
  assert.equal((await snapshot()).stream, null);
});

test('owner boundary, missing end marker and restart never complete a reply', async t => {
  const { f, request, route, markers, emit, snapshot } = await setup(t);
  assert.equal((await f.view('/agent/stream-events', {})).status, 403);
  assert.equal((await f.agent('/agent/stream-events', { ownerKey: 'claude-wrong' })).status, 409);
  await emit(0, markers.prefix + 'Interrupted', true);
  assert.equal((await f.agent('/agent/replies', { ...route, stream: true })).status, 409);
  await f.reopen();
  const state = await snapshot();
  assert.equal(state.stream, null);
  assert.equal(state.requests[request.id].status, 'uncertain');
  assert.equal(state.threads[request.threadId].messages.length, 1);
});


test('native completion saves a reply even when Claude hook batches arrive out of order', async t => {
  const { f, request, route, markers, emit, snapshot } = await setup(t);
  await emit(2, ' last.' + markers.suffix, true);
  await emit(1, ' middle');
  assert.equal((await snapshot()).requests[request.id].status, 'claimed');
  await emit(0, markers.prefix + 'First');
  const state = await snapshot();
  assert.equal(state.requests[request.id].status, 'completed');
  assert.equal(state.threads[request.threadId].messages.at(-1).text, 'First middle last.');
  await emit(0, markers.prefix + 'First');
  assert.equal((await f.agent('/agent/replies', { ...route, stream: true })).status, 200);
  assert.equal((await snapshot()).threads[request.threadId].messages.length, 2);
});


test('progress updates stream and persist once without completing or blocking the final answer', async t => {
  const { f, request, markers, emit, snapshot } = await setup(t);
  assert.ok(markers.progress);
  await emit(1, ' the file.' + markers.progress.suffix, true, 'progress-a');
  await emit(0, markers.progress.prefix + 'I’ll read', false, 'progress-a');
  let state = await snapshot();
  assert.equal(state.requests[request.id].status, 'claimed');
  assert.equal(state.requests[request.id].answer, undefined);
  assert.equal(state.threads[request.threadId].messages.at(-1).text, 'I’ll read the file.');
  await emit(0, markers.progress.prefix + 'I’ll read', false, 'progress-a');
  await emit(1, ' the file.' + markers.progress.suffix, true, 'progress-a');
  assert.equal((await snapshot()).threads[request.threadId].messages.length, 2);
  await emit(0, markers.progress.prefix + 'Found the setting.', false, 'progress-b');
  assert.equal((await snapshot()).stream.text, 'Found the setting.');
  await emit(1, markers.progress.suffix, true, 'progress-b');
  await emit(0, markers.prefix + 'Three retries.' + markers.suffix, true, 'answer');
  state = await snapshot();
  assert.equal(state.requests[request.id].status, 'completed');
  assert.equal(state.requests[request.id].answer.text, 'Three retries.');
  assert.deepEqual(state.threads[request.threadId].messages.map((m: any) => m.text), ['Explain', 'I’ll read the file.', 'Found the setting.', 'Three retries.']);
  await f.reopen();
  assert.deepEqual((await snapshot()).threads[request.threadId].messages, state.threads[request.threadId].messages);
});
