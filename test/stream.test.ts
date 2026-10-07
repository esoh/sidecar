import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './support.ts';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ReplyStream, ThreadReplyRouter, type StreamEvent } from '../src/stream.ts';

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

test('proposal capture waits for a complete final reply and recovery reuses its identities', async t => {
  const { f, request, route, markers, emit, snapshot } = await setup(t);
  const header = '[[sidecar-meta {"highlights":[{"exact":"Hello world.","proposal":{"before":"Hello **world**.","after":"Goodbye **world**."}}]}]]\n';
  await emit(0, markers.prefix + header + 'Review this.');
  assert.deepEqual((await snapshot()).proposals, {});
  await emit(1, markers.suffix, true);
  const saved = await snapshot(); assert.equal(Object.keys(saved.proposals).length, 1);
  await emit(1, markers.suffix, true);
  assert.equal((await f.agent('/agent/replies', { ...route, stream: true })).status, 200);
  assert.deepEqual((await snapshot()).proposals, saved.proposals);
  assert.equal(saved.requests[request.id].status, 'completed');
});

test('failed snapshot publication remains recoverable without losing or duplicating proposals', async t => {
  const { f, route, markers, emit, snapshot } = await setup(t);
  await mkdir(join(f.directory, 'versions'), { recursive: true });
  await writeFile(join(f.directory, 'versions', route.documentId), 'blocks snapshot directory');
  const text = '[[sidecar-meta {"highlights":[{"exact":"Hello world.","proposal":{"before":"Hello **world**.","after":"Goodbye **world**."}}]}]]\nReview this.';
  await emit(0, markers.prefix + text + markers.suffix, true);
  assert.equal((await snapshot()).requests[route.requestId].status, 'claimed');
  assert.deepEqual((await snapshot()).proposals, {});
  assert.match((await snapshot()).stream.error, /save/);
  await rm(join(f.directory, 'versions', route.documentId));
  assert.equal((await f.agent('/agent/replies', { ...route, text })).status, 200);
  const saved = await snapshot(); assert.equal(Object.keys(saved.proposals).length, 1);
  assert.equal((await f.agent('/agent/replies', { ...route, text })).status, 200);
  assert.deepEqual((await snapshot()).proposals, saved.proposals);
});

test('Stop targets a live marked turn, preserves partial output, and rejects stale or late work', async t => {
  const { f, request, route, markers, emit, snapshot } = await setup(t);
  const control = (event: string, turnId = 'turn-a') => f.agent('/agent/control', { ownerKey: `claude-${f.owner.sessionId}`, event, turnId });
  const stop = (turnId = 'turn-a') => f.view(`/api/requests/${request.id}/stop`, { turnId });
  await control('poll');
  assert.equal((await stop()).status, 409, 'delivered is not evidence of this request running');
  await emit(0, 'Unrelated terminal answer.', true, 'unrelated');
  assert.equal((await snapshot()).stream.canStop, false);
  await emit(0, markers.progress.prefix + 'Checking.' + markers.progress.suffix, true, 'progress');
  assert.equal((await snapshot()).stream.canStop, false, 'display hook IDs cannot identify a native Claude turn');
  assert.equal((await f.agent('/agent/control', { ownerKey: `claude-${f.owner.sessionId}`, event: 'started', turnId: 'turn-a', marker: markers.prefix })).status, 200);
  assert.equal((await snapshot()).stream.canStop, true);
  assert.equal((await stop('another-turn')).status, 409);
  await emit(0, markers.prefix + 'Partial answer');
  assert.equal((await stop()).status, 202);
  assert.equal((await snapshot()).stream.stopping, true);
  assert.equal((await (await control('poll', 'other-turn')).json()).stop, undefined);
  assert.deepEqual((await (await control('poll')).json()).stop, { requestId: request.id, turnId: 'turn-a' });
  await control('interrupted');
  const saved = await snapshot();
  assert.equal(saved.stream, null);
  assert.equal(saved.requests[request.id].status, 'stopped');
  assert.deepEqual(saved.threads[request.threadId].messages.map((m: any) => m.text), ['Explain', 'Checking.', 'Partial answer']);
  await control('interrupted');
  await emit(1, ' late text' + markers.suffix, true);
  assert.equal((await stop()).status, 409);
  assert.equal((await f.agent('/agent/replies', { ...route, text: 'Late replacement' })).status, 409);
  await f.reopen();
  assert.deepEqual((await snapshot()).threads[request.threadId], saved.threads[request.threadId]);
});

test('a completed reply wins a Stop race; a failed interrupt leaves the request recoverable', async t => {
  const { f, request, markers, emit, snapshot } = await setup(t);
  const control = (event: string) => f.agent('/agent/control', { ownerKey: `claude-${f.owner.sessionId}`, event, turnId: 'turn-a' });
  await control('poll');
  await emit(0, markers.prefix + 'Answer');
  await f.agent('/agent/control', { ownerKey: `claude-${f.owner.sessionId}`, event: 'started', turnId: 'turn-a', marker: markers.prefix });
  await f.view(`/api/requests/${request.id}/stop`, { turnId: 'turn-a' });
  await control('stop-failed');
  assert.equal((await snapshot()).requests[request.id].status, 'claimed');
  assert.equal((await snapshot()).stream.stopping, false);
  assert.match((await snapshot()).stream.stopError, /not confirmed/);
  await f.view(`/api/requests/${request.id}/stop`, { turnId: 'turn-a' });
  await emit(1, markers.suffix, true);
  await control('interrupted');
  assert.equal((await snapshot()).requests[request.id].status, 'completed');
  assert.equal((await snapshot()).requests[request.id].answer.text, 'Answer');
});

test('Claude binds its native control turn by markers even when display hooks use a different turn ID', async t => {
  const { f, request, markers, emit, snapshot } = await setup(t);
  const control = (event: string, fields = {}) => f.agent('/agent/control', { ownerKey: `claude-${f.owner.sessionId}`, event, turnId: 'native-turn', ...fields });
  await control('poll');
  await emit(0, markers.prefix + 'Partial');
  assert.equal((await snapshot()).stream.canStop, false);
  await control('started', { marker: '[[sidecar:wrong]]\n' });
  assert.equal((await snapshot()).stream.canStop, false);
  assert.equal((await control('started', { marker: markers.prefix })).status, 200);
  assert.equal((await snapshot()).stream.turnId, 'native-turn');
  assert.equal((await snapshot()).stream.canStop, true);
  assert.equal((await f.view(`/api/requests/${request.id}/stop`, { turnId: 'turn-a' })).status, 409);
  assert.equal((await f.view(`/api/requests/${request.id}/stop`, { turnId: 'native-turn' })).status, 202);
  await control('interrupted', { answer: markers.prefix + 'Partial with the last native chunk' });
  assert.equal((await snapshot()).requests[request.id].answer.text, 'Partial with the last native chunk');
  assert.equal((await snapshot()).requests[request.id].status, 'stopped');
});

test('a complete native Claude answer wins Stop before its delayed display hook and saves metadata', async t => {
  const { f, request, markers, emit, snapshot } = await setup(t);
  const control = (event: string, fields = {}) => f.agent('/agent/control', { ownerKey: `claude-${f.owner.sessionId}`, event, turnId: 'native-turn', ...fields });
  await control('started', { marker: markers.prefix });
  await emit(0, markers.prefix + 'Partial');
  await f.view(`/api/requests/${request.id}/stop`, { turnId: 'native-turn' });
  const answer = markers.prefix + '[[sidecar-meta {"threadTitle":"Completed race","highlights":[{"exact":"First heading"}]}]]\nComplete answer' + markers.suffix;
  await control('interrupted', { answer });
  const saved = await snapshot();
  assert.equal(saved.requests[request.id].status, 'completed');
  assert.equal(saved.requests[request.id].answer.text, 'Complete answer');
  assert.equal(saved.threads[request.threadId].title, 'Completed race');
  assert.equal(saved.threads[request.threadId].messages.at(-1).selections[0].quote.exact, 'First heading');
  await emit(0, answer, true, 'late-display');
  assert.deepEqual((await snapshot()).threads[request.threadId].messages, saved.threads[request.threadId].messages);
});

test('reply metadata is hidden while streaming, then titles and multiple selections save with the answer', async t => {
  const { f, request, route, markers, emit, snapshot } = await setup(t);
  const metadata = JSON.stringify({ threadTitle: 'Find the greeting', highlights: [{ exact: 'First heading', label: 'Heading' }, { exact: 'Hello world.' }] });
  await emit(0, markers.prefix + '[[sidecar-me');
  assert.equal((await snapshot()).stream.text, '');
  await emit(1, 'ta ' + metadata + ']]\nSee [the heading](#selection-1) and [greeting](#selection-2).');
  assert.equal((await snapshot()).stream.text, 'See [the heading](#selection-1) and [greeting](#selection-2).');
  assert.equal((await snapshot()).threads[request.threadId].title, undefined);
  await emit(2, markers.suffix, true);
  const state = await snapshot(), thread = state.threads[request.threadId], answer = thread.messages.at(-1);
  assert.equal(thread.title, 'Find the greeting');
  assert.equal(answer.text.includes('sidecar-meta'), false);
  assert.deepEqual(answer.selections.map((s: any) => [s.slug, s.quote.exact, s.label, s.isVisible]), [['selection-1', 'First heading', 'Heading', true], ['selection-2', 'Hello world.', undefined, true]]);
  const saved = await (await f.view(`/api/documents/${route.documentId}/versions/${answer.selections[0].quote.version}`)).json();
  assert.equal(saved.markdown, '# First heading\n\nHello **world**.\n');
  assert.equal((await f.view(`/api/threads/${thread.id}/selections/${answer.selections[0].id}`, { isVisible: false })).status, 200);
  assert.equal((await snapshot()).threads[thread.id].messages.at(-1).selections[1].isVisible, true);
  await f.view(`/api/threads/${thread.id}/resolution`, { isResolved: true });
  await f.view(`/api/threads/${thread.id}/resolution`, { isResolved: false });
  assert.ok((await snapshot()).threads[thread.id].messages.at(-1).selections.every((s: any) => !s.isVisible));
  await f.view(`/api/threads/${thread.id}/selections`, { isVisible: true });
  await f.reopen();
  assert.ok((await snapshot()).threads[thread.id].messages.at(-1).selections.every((s: any) => s.isVisible));
  assert.equal((await snapshot()).threads[thread.id].messages.length, 2);
});

test('metadata respects assigned titles, reports failure without a reply command, and isolates interrupted retries', async t => {
  const { f, request, markers, emit, snapshot } = await setup(t);
  await f.view(`/api/threads/${request.threadId}/title`, { title: 'My title' }, 'PATCH');
  await emit(0, markers.prefix + '[[sidecar-meta {"threadTitle":"Wrong","highlights":[{"exact":"Hello"}]}]]\nInterrupted', true);
  await emit(0, markers.prefix + '[[sidecar-meta {"threadTitle":"Also wrong","isError":true}]]\nCould not finish.' + markers.suffix, true, 'retry');
  const state = await snapshot();
  assert.equal(state.threads[request.threadId].title, 'My title');
  assert.equal(state.requests[request.id].status, 'failed');
  assert.deepEqual(state.requests[request.id].answer, { text: 'Could not finish.', isError: true });
  assert.equal(state.threads[request.threadId].messages.at(-1).selections, undefined);
});

test('invalid metadata cannot strand the answer or change a thread, and reply fallback supports the same header', async t => {
  const { f, request, route, markers, emit, snapshot } = await setup(t);
  await emit(0, markers.prefix + '[[sidecar-meta {bad json}]]\nPlain answer.' + markers.suffix, true);
  assert.equal((await snapshot()).requests[request.id].answer.text, 'Plain answer.');
  const next = await (await f.view('/api/questions', { documentId: route.documentId, threadId: route.threadId, text: 'Where is it?', clientMessageId: 'fallback' })).json();
  await f.agent(`/agent/requests/${next.id}/claim`, {});
  await f.view(`/api/threads/${route.threadId}/resolution`, { isResolved: true });
  const body = { ...route, requestId: next.id, text: '[[sidecar-meta {"threadTitle":"Find greeting","highlights":[{"exact":"Hello"}]}]]\nHere.' };
  assert.equal((await f.agent('/agent/replies', body)).status, 200);
  const before = await snapshot();
  assert.equal(before.threads[route.threadId].messages.at(-1).selections[0].isVisible, false);
  await writeFile(before.documents[route.documentId].path, '# Changed\n');
  assert.equal((await f.agent('/agent/replies', body)).status, 200);
  assert.deepEqual((await snapshot()).threads[route.threadId], before.threads[route.threadId]);
});

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

test('a truncated native event can recover the existing markers without resetting progress', async t => {
  const { f, request, markers, emit, snapshot } = await setup(t);
  await emit(0, markers.progress.prefix + 'Checking the file.' + markers.progress.suffix, true, 'progress');
  const recovered = await (await f.agent(`/agent/requests/${request.id}/claim`, {})).json();
  assert.equal(recovered.claimStatus, 'already-claimed');
  assert.deepEqual(recovered.stream, markers);
  assert.equal((await snapshot()).threads[request.threadId].messages.at(-1).text, 'Checking the file.');
  await emit(0, recovered.stream.prefix + 'Done.' + recovered.stream.suffix, true, 'final');
  assert.equal((await snapshot()).requests[request.id].status, 'completed');
  const completed = await (await f.agent(`/agent/requests/${request.id}/claim`, {})).json();
  assert.equal(completed.stream, undefined, 'completed requests must not offer a new reply stream');
});

for (const finalized of [false, true]) test(`a complete retry replaces an interrupted ${finalized ? 'completed' : 'unfinished'} native message`, async t => {
  const { f, request, route, markers, emit, snapshot } = await setup(t);
  await emit(0, markers.progress.prefix + 'Checking.' + markers.progress.suffix, true, 'progress');
  await emit(0, markers.prefix + 'Interrupted', finalized);
  const next = await (await f.view('/api/questions', { documentId: route.documentId, text: 'Next', clientMessageId: 'next' })).json();
  assert.equal((await snapshot()).requests[next.id].status, 'queued');
  await emit(0, 'An unrelated reply.', true, 'unrelated');
  await emit(0, '[[sidecar:wrong]]\nWrong request\n[[/sidecar:wrong]]', true, 'wrong');
  assert.equal((await snapshot()).requests[request.id].status, 'claimed');
  await emit(2, ' retry.' + markers.suffix, true, 'retry');
  await emit(0, markers.prefix.slice(0, 8), false, 'retry');
  assert.equal((await snapshot()).requests[request.id].status, 'claimed');
  await emit(1, markers.prefix.slice(8) + 'Complete', false, 'retry');
  let state = await snapshot();
  assert.equal(state.requests[request.id].status, 'completed');
  assert.equal(state.requests[request.id].answer.text, 'Complete retry.');
  assert.deepEqual(state.threads[request.threadId].messages.map((m: any) => m.text), ['Explain', 'Checking.', 'Complete retry.']);
  await emit(1, ' late.' + markers.suffix, true);
  assert.equal((await snapshot()).threads[request.threadId].messages.length, 3);
  assert.equal((await (await f.agent(`/agent/requests/${next.id}/claim`, {})).json()).claimStatus, 'claimed');
  await f.reopen();
  state = await snapshot();
  assert.equal(state.requests[request.id].answer.text, 'Complete retry.');
});

test('stable thread tags route several receipt blocks in one native message without crossing replies', () => {
  const first = new ReplyStream({ requestId: '11111111-1111-4111-8111-111111111111', threadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', documentId: 'doc' }, true);
  const second = new ReplyStream({ requestId: '22222222-2222-4222-8222-222222222222', threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', documentId: 'doc' }, true);
  const router = new ThreadReplyRouter(), streams = new Map([[first.route.requestId, first], [second.route.requestId, second]]);
  assert.ok(first.prefix.startsWith(`[[sidecar:${first.route.threadId}]]\n`));
  assert.ok(first.prefix.includes(`[[sidecar-reply:${first.route.requestId}]]`));
  const raw = first.progress.prefix + 'Checking A' + first.progress.suffix + '\n\n' + second.prefix + 'Answer B' + second.suffix + '\n' + first.prefix + 'Answer A' + first.suffix;
  const updates: string[] = [];
  const feed = (event: StreamEvent) => {
    for (const part of router.accept(event, streams)) {
      const progress = part.stream.accept(part.event);
      if (progress) updates.push(progress.text);
    }
  };
  const base = { messageId: 'native-message', turnId: 'native-turn' };
  feed({ ...base, index: 1, delta: raw.slice(70), final: false });
  feed({ ...base, index: 0, delta: raw.slice(0, 70), final: false });
  assert.equal(first.done, false); assert.equal(second.done, false);
  feed({ ...base, index: 2, delta: '', final: true });
  assert.deepEqual(updates, ['Checking A']);
  assert.equal(first.text, 'Answer A'); assert.equal(second.text, 'Answer B');
  assert.equal(first.done, true); assert.equal(second.done, true);
  feed({ ...base, index: 2, delta: '', final: true });
  assert.deepEqual(updates, ['Checking A']);
});

test('native turn end retires unfinished display messages without discarding another live turn', () => {
  const router = new ThreadReplyRouter();
  const active = new ReplyStream({ requestId: '11111111-1111-4111-8111-111111111111', threadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', documentId: 'doc' }, true);
  const streams = new Map([[active.route.requestId, active]]);
  router.accept({ messageId: 'live', turnId: 'display-live', index: 0, delta: active.prefix, final: false }, streams, 'native-live');
  for (let i = 0; i < 70; i++) {
    router.accept({ messageId: 'partial', turnId: `display-${i}`, index: 0, delta: '[[sidecar:', final: false }, streams, `native-${i}`);
    router.endTurn(`native-${i}`);
    assert.deepEqual(router.accept({ messageId: 'partial', turnId: `display-${i}`, index: 1, delta: 'late', final: false }, streams), []);
  }
  const output = router.accept({ messageId: 'live', turnId: 'display-live', index: 1, delta: 'Saved' + active.suffix, final: true }, streams, 'native-live');
  assert.equal(output[0].event.delta, 'Saved' + active.suffix);
});
