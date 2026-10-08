import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './support.ts';
import { ownerKey } from '../src/store.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { watchClaude } from '../src/agent.ts';

async function setup(t: Parameters<typeof fixture>[0], isBatch = false, progressOnly = false) {
  const f = await fixture(t), doc = await f.register();
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Change it', clientMessageId: 'first' })).json();
  const member = isBatch ? await (await f.view('/api/questions', { documentId: doc.id, threadId: request.threadId, text: 'Make it cobalt', clientMessageId: 'second' })).json() : undefined;
  const prepared = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
  const key = ownerKey(f.owner);
  const state = async () => (await f.view('/api/state')).json();
  const emit = (text: string, turnId = 'display-1') => f.agent('/agent/stream-events', { ownerKey: key, turnId, messageId: text, index: 0, delta: text, final: true });
  const control = (event: string, turnId = 'native-1', fields = {}) => f.agent('/agent/control', { ownerKey: key, event, turnId, ...fields });
  await control('started', 'native-1', { marker: prepared.stream.progress.prefix });
  await emit(prepared.stream.progress.prefix + 'I will change it.' + prepared.stream.progress.suffix);
  if (!progressOnly) await emit(prepared.stream.prefix + 'An unfinished final answer', 'partial-final');
  const recovery = async () => (await state()).requests[request.id].replyRecovery;
  const prepare = (id: string) => f.agent(`/agent/requests/${request.id}/recover`, { recoveryId: id });
  return { f, request, member, prepared, state, control, emit, recovery, prepare };
}

test('ended marked turns get one reply-only recovery; duplicates and stale retries do not redeliver', async t => {
  const { f, request, control, recovery, prepare, prepared, state } = await setup(t);
  await control('completed');
  const attempt = await recovery();
  assert.equal(attempt?.status, 'pending');
  await control('completed');
  assert.deepEqual(await recovery(), attempt);
  const deliveries = await Promise.all([prepare(attempt.id), prepare(attempt.id)]);
  const bodies = await Promise.all(deliveries.map(r => r.json()));
  assert.equal(bodies.filter(b => b.type === 'sidecar.recovery').length, 1);
  const event = bodies.find(b => b.type === 'sidecar.recovery');
  assert.equal(event.requestId, request.id);
  assert.equal(event.recoveryId, attempt.id);
  assert.deepEqual(event.stream, prepared.stream);
  assert.equal(event.text, undefined, 'do not resend the task to execute again');
  assert.match(event.instruction, /Do not repeat.*edits/);
  await control('started', 'native-2', { marker: prepared.stream.prefix });
  await control('completed', 'native-2');
  assert.equal((await recovery()).status, 'failed', 'one automatic attempt, not an infinite loop');
  assert.equal((await state()).requests[request.id].status, 'claimed');
  const path = `/api/requests/${request.id}/retry-reply`;
  const retry = await Promise.all([f.view(path, { recoveryId: attempt.id }), f.view(path, { recoveryId: attempt.id })]);
  assert.deepEqual(retry.map(r => r.status).sort(), [202, 409]);
  assert.notEqual((await recovery()).id, attempt.id);
  assert.equal((await prepare(attempt.id)).status, 409);
});

test('late valid replies cancel pending recovery and duplicate replies save once', async t => {
  const { request, control, recovery, prepare, prepared, state, emit } = await setup(t);
  await control('completed');
  const attempt = await recovery();
  assert.ok(attempt);
  const answer = prepared.stream.prefix + 'Already changed.' + prepared.stream.suffix;
  await emit(answer);
  await emit(answer, 'duplicate');
  const event = await (await prepare(attempt.id)).json();
  assert.equal(event.type, undefined);
  const saved = await state();
  assert.equal(saved.requests[request.id].status, 'completed');
  assert.equal(saved.threads[request.threadId].messages.filter((m: any) => m.text === 'Already changed.').length, 1);
});

test('failed recovery delivery becomes retryable without affecting completed or newer attempts', async t => {
  const { f, request, control, recovery, prepare, prepared, emit, state } = await setup(t);
  await control('completed');
  const attempt = await recovery();
  await prepare(attempt.id);
  const path = `/agent/requests/${request.id}/recovery-failed`;
  assert.equal((await f.agent(path, { recoveryId: attempt.id })).status, 200);
  assert.equal((await recovery()).status, 'failed');
  await f.view(`/api/requests/${request.id}/retry-reply`, { recoveryId: attempt.id });
  const next = await recovery();
  await f.agent(path, { recoveryId: attempt.id });
  assert.deepEqual(await recovery(), next, 'a stale delivery failure cannot fail a newer attempt');
  await emit(prepared.stream.prefix + 'Late but complete.' + prepared.stream.suffix);
  await f.agent(path, { recoveryId: next.id });
  assert.equal((await state()).requests[request.id].status, 'completed');
});

test('native final output beats delayed display hooks, including metadata persistence', async t => {
  const { request, control, prepared, state, emit } = await setup(t);
  const answer = prepared.stream.prefix + '[[sidecar-meta {"highlights":[{"exact":"First heading"}]}]]\nSaved.' + prepared.stream.suffix;
  await control('completed', 'native-1', { answer });
  const saved = await state();
  assert.equal(saved.requests[request.id].status, 'completed');
  assert.equal(saved.requests[request.id].replyRecovery, undefined);
  assert.equal(saved.threads[request.threadId].messages.at(-1).selections.length, 1);
  await emit(answer);
  assert.deepEqual((await state()).threads, saved.threads);
});

test('idle, unrelated turn ends, and user interruptions never trigger automatic recovery', async t => {
  const { f, request, control, recovery, state } = await setup(t);
  await f.agent('/agent/lifecycle', { ownerKey: ownerKey(f.owner), event: 'agent-idle' });
  await control('completed', 'unrelated');
  assert.equal(await recovery(), undefined);
  await f.view(`/api/requests/${request.id}/stop`, { turnId: 'native-1' });
  await control('interrupted');
  await control('completed');
  assert.equal(await recovery(), undefined);
  assert.equal((await state()).requests[request.id].status, 'stopped');
});

test('restart retains failed recovery and frozen batch; manual retry cannot replay the original task', async t => {
  const { f, request, member, control, recovery, prepare, prepared, state, emit } = await setup(t, true);
  const later = await (await f.view('/api/questions', { documentId: request.documentId, threadId: request.threadId, text: 'New task', clientMessageId: 'later' })).json();
  await control('completed');
  const attempt = await recovery();
  assert.ok(attempt);
  await prepare(attempt.id);
  await f.reopen();
  assert.equal((await recovery()).id, attempt.id);
  assert.equal((await recovery()).status, 'failed');
  const ordinary = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
  assert.equal(ordinary.claimStatus, 'reply-recovery');
  assert.equal((await f.view(`/api/requests/${request.id}/retry-reply`, { recoveryId: attempt.id })).status, 202);
  const next = await recovery();
  const event = await (await prepare(next.id)).json();
  assert.equal(event.type, 'sidecar.recovery');
  assert.equal(event.stream.prefix, prepared.stream.prefix, 'thread tag and request receipt survive restart');
  await emit(prepared.stream.prefix + 'Original answer arrived late.' + prepared.stream.suffix);
  assert.equal((await state()).requests[request.id].answer.text, 'Original answer arrived late.');
  await emit(event.stream.prefix + 'Recovered without editing again.' + event.stream.suffix);
  assert.equal((await state()).requests[request.id].answer.text, 'Original answer arrived late.', 'the first complete answer wins');
  assert.equal((await state()).requests[request.id].status, 'completed');
  assert.equal((await state()).requests[member.id].status, 'completed');
  assert.equal((await state()).requests[later.id].status, 'queued');
});

test('Claude native module forwards completed final output before display hooks arrive', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-native-complete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(t, 20, root), doc = await f.register();
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Explain', clientMessageId: 'native' })).json();
  const prepared = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
  const handlers = new Map<string, any>();
  const { register } = await import(new URL('../hooks/control.js', import.meta.url).href);
  register((name: string, handler: unknown) => handlers.set(name, handler));
  const api = {
    session: { id: async () => f.owner.sessionId },
    env: { get: async (name: string) => name === 'SIDECAR_STATE_DIR' ? root : undefined },
    fs: { read: (path: string) => readFile(path, 'utf8') },
    http: { fetch: async (url: string, options: RequestInit) => { const response = await fetch(url, options); return { ok: response.ok, text: await response.text() }; } },
  };
  async function* output() { yield { kind: 'text', text: prepared.stream.prefix }; }
  for await (const _ of handlers.get('turn.step')(api, { turnId: 'native' }, output)) { /* consume the native output */ }
  const answer = prepared.stream.prefix + 'Native final snapshot.' + prepared.stream.suffix;
  await handlers.get('turn.complete')(api, { turnId: 'native', answer, isAborted: false }, (event: unknown) => event);
  const saved = await (await f.view('/api/state')).json();
  assert.equal(saved.requests[request.id].answer?.text, 'Native final snapshot.');
  assert.equal(saved.requests[request.id].replyRecovery, undefined);
});

test('concurrent finalization, native completion and duplicates persist one answer and no recovery', async t => {
  const { f, request, control, prepared, state, emit } = await setup(t);
  const answer = prepared.stream.prefix + '[[sidecar-meta {"highlights":[{"exact":"First heading"}]}]]\nOne answer.' + prepared.stream.suffix;
  await Promise.all([
    emit(answer),
    control('completed', 'native-1', { answer }),
    control('completed', 'native-1', { answer }),
    f.agent('/agent/replies', { requestId: request.id, documentId: request.documentId, threadId: request.threadId, text: 'One answer.' }),
  ]);
  const saved = await state();
  assert.equal(saved.requests[request.id].status, 'completed');
  assert.equal(saved.requests[request.id].replyRecovery, undefined);
  assert.equal(saved.threads[request.threadId].messages.filter((m: any) => m.text === 'One answer.').length, 1);
});

test('recovery preparation waits for an in-flight snapshot and reply save', async t => {
  const { request, control, recovery, prepare, prepared, emit, state } = await setup(t);
  await control('completed');
  const attempt = await recovery();
  let reached = () => {}, release = () => {};
  const saving = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = fs.writeFile;
  fs.writeFile = async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).includes(`/versions/${request.documentId}/`)) { reached(); await gate; }
    return original(...args);
  };
  syncBuiltinESMExports();
  let finalResponse: Promise<Response> | undefined, recoveryResponse: Promise<Response> | undefined;
  try {
    finalResponse = emit(prepared.stream.prefix + '[[sidecar-meta {"highlights":[{"exact":"First heading"}]}]]\nSaved before recovery.' + prepared.stream.suffix);
    await saving;
    recoveryResponse = prepare(attempt.id);
    assert.equal(await Promise.race([recoveryResponse.then(() => 'overtook-save'), delay(100, 'waiting')]), 'waiting');
    release();
    await finalResponse;
    assert.equal((await (await recoveryResponse).json()).type, undefined);
    assert.equal((await state()).requests[request.id].answer.text, 'Saved before recovery.');
  } finally {
    release(); fs.writeFile = original; syncBuiltinESMExports();
    await Promise.allSettled([finalResponse, recoveryResponse]);
  }
});

test('Claude watcher reports an ambiguous failed stdout handoff without retransmitting it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-watcher-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(t, 20, root), doc = await f.register(), key = ownerKey(f.owner);
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Explain', clientMessageId: 'handoff' })).json();
  const prepared = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
  await f.agent('/agent/control', { ownerKey: key, event: 'started', turnId: 'first', marker: prepared.stream.prefix });
  await f.agent('/agent/control', { ownerKey: key, event: 'completed', turnId: 'first' });
  const previous = process.env.SIDECAR_STATE_DIR, write = process.stdout.write;
  let writes = 0;
  const output = t.mock.method(process.stdout, 'write', (chunk: unknown, ...args: unknown[]) => {
    if (typeof chunk === 'string' && chunk.includes('"type":"sidecar.recovery"')) {
      writes++;
      const callback = args.at(-1);
      if (typeof callback === 'function') callback(new Error('forced failed handoff'));
      return false;
    }
    return Reflect.apply(write, process.stdout, [chunk, ...args]);
  });
  process.env.SIDECAR_STATE_DIR = root;
  const abort = new AbortController(), watcher = watchClaude(key, abort.signal);
  try {
    let recovery;
    for (let i = 0; i < 100; i++) {
      recovery = (await (await f.view('/api/state')).json()).requests[request.id].replyRecovery;
      if (recovery.status === 'failed') break;
      await delay(10);
    }
    assert.equal(recovery.status, 'failed');
    assert.equal(writes, 1);
    abort.abort(); await watcher;
    assert.equal((await f.view(`/api/requests/${request.id}/retry-reply`, { recoveryId: recovery.id })).status, 202);
  } finally {
    abort.abort(); await watcher; output.mock.restore();
    if (previous === undefined) delete process.env.SIDECAR_STATE_DIR; else process.env.SIDECAR_STATE_DIR = previous;
  }
});


test('progress-only turns stay pending across repeated completion and a later delegated result', async t => {
  const { request, prepared, control, emit, state, recovery } = await setup(t, false, true);
  for (const turnId of ['native-1', 'native-2', 'native-3']) {
    await control('started', turnId, { marker: prepared.stream.progress.prefix });
    await emit(prepared.stream.progress.prefix + `Still waiting in ${turnId}.` + prepared.stream.progress.suffix, turnId);
    await control('completed', turnId);
    await control('completed', turnId);
    const saved = await state();
    assert.equal(saved.requests[request.id].status, 'claimed');
    assert.equal(await recovery(), undefined);
    assert.equal(saved.stream.error, null);
  }
  await control('started', 'result-turn', { marker: prepared.stream.prefix });
  const answer = prepared.stream.prefix + 'The delegated result.' + prepared.stream.suffix;
  await control('completed', 'result-turn', { answer });
  const saved = await state();
  assert.equal(saved.requests[request.id].answer.text, 'The delegated result.');
  assert.equal(saved.requests[request.id].status, 'completed');
  assert.equal(saved.threads[request.threadId].messages.filter((m: any) => m.role === 'agent').length, 5);
});
