import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './support.ts';
import { ownerKey } from '../src/store.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function setup(t: Parameters<typeof fixture>[0], root?: string) {
  const f = await fixture(t, 20, root), doc = await f.register(), key = ownerKey(f.owner);
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'First', clientMessageId: 'first' })).json();
  const member = await (await f.view('/api/questions', { documentId: doc.id, threadId: request.threadId, text: 'Same batch', clientMessageId: 'member' })).json();
  const prepared = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
  const emit = (text: string, final = false, messageId = 'partial') => f.agent('/agent/stream-events', { ownerKey: key, turnId: 'display', messageId, index: 0, delta: text, final });
  await emit(prepared.stream.progress.prefix + 'Saved progress.' + prepared.stream.progress.suffix, true, 'progress');
  await emit(prepared.stream.prefix + 'Captured partial');
  const later = await (await f.view('/api/questions', { documentId: doc.id, threadId: request.threadId, text: 'Later task', clientMessageId: 'later' })).json();
  const state = async () => (await f.view('/api/state')).json();
  const control = (event: string, fields = {}) => f.agent('/agent/control', { ownerKey: key, event, turnId: 'native', ...fields });
  const reset = async () => {
    assert.equal((await f.view('/api/agent/reset', {})).status, 202);
    const poll = await (await control('poll')).json();
    assert.ok(poll.reset?.id);
    return poll.reset.id;
  };
  const finished = async () => {
    for (let i = 0; i < 100; i++) { const s = await state(); if (s.reset?.status === 'done' || s.reset?.status === 'failed') return s; await delay(10); }
    assert.fail('Reset did not finish');
  };
  return { f, key, request, member, later, prepared, emit, state, control, reset, finished };
}

test('Reset needs a fresh native check, retains output and releases only the active batch', async t => {
  const { f, key, request, member, later, state, control, reset, finished } = await setup(t);
  await f.agent('/agent/lifecycle', { ownerKey: key, event: 'agent-idle' });
  const id = await reset();
  assert.equal((await state()).requests[request.id].status, 'claimed', 'the idle badge is not confirmation');
  assert.equal((await f.view('/api/agent/reset', {})).status, 409, 'duplicate clicks cannot overlap resets');
  assert.equal((await f.agent(`/agent/requests/${later.id}/prepare`, {})).status, 409, 'a watcher must reconnect instead of losing an already announced queued request');
  assert.equal((await control('reset-idle', { resetId: 'stale' })).status, 409);
  assert.equal((await control('reset-idle', { resetId: id })).status, 200);
  const saved = await finished();
  assert.equal(saved.reset.status, 'done');
  assert.equal(saved.requests[request.id].status, 'stopped');
  assert.equal(saved.requests[member.id].status, 'stopped');
  assert.equal(saved.requests[later.id].status, 'queued');
  assert.equal(saved.stream, null);
  assert.deepEqual(saved.threads[request.threadId].messages.filter((m: any) => m.role === 'agent').map((m: any) => m.text), ['Saved progress.', 'Captured partial']);
  assert.equal((await f.agent(`/agent/requests/${later.id}/claim`, {})).status, 200);
});

test('Reset waits for any attached native turn to finish, including unrelated terminal work', async t => {
  const { request, state, control, reset, finished } = await setup(t);
  const id = await reset();
  await control('reset-started', { resetId: id, turnId: 'terminal-work' });
  await control('interrupted', { turnId: 'another-turn' });
  assert.equal((await state()).requests[request.id].status, 'claimed');
  assert.equal((await state()).reset.status, 'interrupting');
  await control('interrupted', { turnId: 'terminal-work', answer: 'Unrelated terminal answer' });
  const saved = await finished();
  assert.equal(saved.requests[request.id].status, 'stopped');
  assert.equal(saved.requests[request.id].answer.text, 'Captured partial');
});

test('a complete reply wins Reset even when the native completion snapshot arrives first', async t => {
  const { request, prepared, control, reset, finished } = await setup(t);
  const id = await reset();
  await control('reset-started', { resetId: id });
  await control('interrupted', { answer: prepared.stream.prefix + 'Finished answer.' + prepared.stream.suffix });
  const saved = await finished();
  assert.equal(saved.requests[request.id].status, 'completed');
  assert.equal(saved.requests[request.id].answer.text, 'Finished answer.');
  assert.equal(saved.threads[request.threadId].messages.filter((m: any) => m.text === 'Finished answer.').length, 1);
});

test('failed native verification leaves captured output and claimed work recoverable', async t => {
  const { request, later, control, reset, finished } = await setup(t);
  const id = await reset();
  await control('reset-failed', { resetId: id });
  const saved = await finished();
  assert.equal(saved.reset.status, 'failed');
  assert.equal(saved.requests[request.id].status, 'claimed');
  assert.equal(saved.requests[later.id].status, 'queued');
  assert.equal(saved.stream.text, 'Captured partial');
});

test('Reset reconciles an uncertain batch after reconnect without replaying the task', async t => {
  const { f, request, member, later, control, reset, finished } = await setup(t);
  await f.reopen();
  const id = await reset();
  await control('reset-idle', { resetId: id });
  const saved = await finished();
  assert.equal(saved.requests[request.id].status, 'stopped');
  assert.equal(saved.requests[member.id].status, 'stopped');
  assert.equal(saved.requests[later.id].status, 'queued');
  assert.deepEqual(saved.threads[request.threadId].messages.filter((m: any) => m.role === 'agent').map((m: any) => m.text), ['Saved progress.']);
});

test('an idle heartbeat cannot erase the native binding before an interruption hook arrives', async t => {
  const { request, prepared, control, state } = await setup(t);
  await control('started', { marker: prepared.stream.prefix });
  await control('poll', { turnId: 'idle', activity: 'idle' });
  assert.equal((await state()).stream.canStop, false);
  await control('interrupted', { answer: prepared.stream.prefix + 'Native partial' });
  const saved = await state();
  assert.equal(saved.requests[request.id].status, 'stopped');
  assert.equal(saved.requests[request.id].answer.text, 'Native partial');
});

for (const mode of ['idle', 'busy', 'unknown', 'idle-final'] as const) test(`Claude's native module answers Reset from ${mode} state`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-reset-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release = () => {};
  const completedGate = new Promise<void>(resolve => { release = resolve; });
  let ended: Promise<unknown> | undefined;
  const { f, request, prepared, state, finished } = await setup(t, root);
  const handlers = new Map<string, any>(), aborted: string[] = [];
  let tick = () => {};
  const { register } = await import(new URL('../hooks/control.js', import.meta.url).href);
  register((name: string, handler: unknown) => handlers.set(name, handler));
  const api = {
    session: { id: async () => f.owner.sessionId },
    env: { get: async (name: string) => name === 'SIDECAR_STATE_DIR' ? root : undefined },
    fs: { read: (path: string) => readFile(path, 'utf8') },
    http: { fetch: async (url: string, options: RequestInit) => {
      if (mode === 'idle-final' && JSON.parse(String(options.body)).event === 'completed') await completedGate;
      const response = await fetch(url, options); return { ok: response.ok, text: await response.text() };
    } },
    clock: { every: (_ms: number, callback: () => void) => { tick = callback; return { cancel: () => {} }; } },
    turn: { abort: async ({ turnId }: { turnId: string }) => {
      aborted.push(turnId);
      await handlers.get('turn.complete')(api, { turnId, isAborted: true, answer: 'Unrelated terminal output.' }, (e: unknown) => e);
    } },
  };
  try {
    await handlers.get('session.start')(api, {}, (e: unknown) => e);
    if (mode !== 'unknown') await handlers.get('turn.start')(api, { turnId: 'unrelated-terminal-turn' }, (e: unknown) => e);
    if (mode === 'idle') await handlers.get('turn.complete')(api, { turnId: 'unrelated-terminal-turn', isAborted: false, answer: '' }, (e: unknown) => e);
    if (mode === 'idle-final') ended = handlers.get('turn.complete')(api, { turnId: 'unrelated-terminal-turn', isAborted: false, answer: prepared.stream.prefix + 'Complete native answer.' + prepared.stream.suffix }, (e: unknown) => e);
    assert.equal((await f.view('/api/agent/reset', {})).status, 202);
    for (let i = 0; i < 100; i++) {
      tick(); await delay(10);
      if (['done', 'failed'].includes((await state()).reset.status)) break;
    }
    const saved = await finished();
    assert.equal(saved.reset.status, mode === 'unknown' ? 'failed' : 'done');
    assert.equal(saved.requests[request.id].status, mode === 'unknown' ? 'claimed' : mode === 'idle-final' ? 'completed' : 'stopped');
    assert.deepEqual(aborted, mode === 'busy' ? ['unrelated-terminal-turn'] : []);
  } finally { release(); await ended; }
});
