import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './support.ts';
import { ownerKey } from '../src/store.ts';

// Real HTTP capture/control boundaries; no native model or user state involved.
test('multiple thread receipts stay live, combine only their own earlier inputs, and preserve streaming text', async t => {
  const f = await fixture(t), doc = await f.register(), key = ownerKey(f.owner);
  const ask = async (id: string, threadId?: string) => {
    const request = await (await f.view('/api/questions', { documentId: doc.id, threadId, text: id, clientMessageId: id })).json();
    const event = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
    assert.ok(event.stream, JSON.stringify(event));
    await f.agent(`/agent/requests/${request.id}/accepted`, {});
    return { request, event };
  };
  await f.agent('/agent/control', { ownerKey: key, event: 'poll', turnId: 'native-cli-turn', activity: 'busy' });
  const a = await ask('A');
  const send = (messageId: string, delta: string, final = true, index = 0) => f.agent('/agent/stream-events', { ownerKey: key, messageId, turnId: 'display-turn', delta, index, final });
  await send('old', a.event.stream.prefix + 'Old partial', false);
  const b = await ask('B', a.request.threadId), x = await ask('Other thread');
  assert.equal((await (await f.view('/api/state')).json()).stream.text, 'Old partial', 'preparation cannot erase a live older reply');
  assert.deepEqual(b.event.covers, [a.request.id]);
  await send('other-partial', x.event.stream.prefix + 'Other partial', false);
  assert.deepEqual((await (await f.view('/api/state')).json()).streams.map((s: any) => s.text), ['Old partial', 'Other partial']);
  await send('combined', b.event.stream.prefix + 'Combined A and B' + b.event.stream.suffix + '\n' + x.event.stream.prefix + 'Other answer' + x.event.stream.suffix);
  await send('old', a.event.stream.suffix, true, 1);
  const saved = await (await f.view('/api/state')).json();
  assert.equal(saved.requests[a.request.id].answeredBy, b.request.id);
  assert.equal(saved.requests[b.request.id].status, 'completed');
  assert.equal(saved.requests[x.request.id].status, 'completed');
  assert.deepEqual(saved.threads[a.request.threadId].messages.filter((m: any) => m.role === 'agent').map((m: any) => m.text), ['Combined A and B']);
  assert.equal(saved.threads[x.request.threadId].messages.at(-1).text, 'Other answer');
});

test('agent Stop is available without reply output, interrupts only the exact native turn and preserves unsent input', async t => {
  const f = await fixture(t), doc = await f.register(), key = ownerKey(f.owner);
  const control = (event: string, turnId: string, rest = {}) => f.agent('/agent/control', { ownerKey: key, event, turnId, ...rest });
  await control('poll', 'cli-work', { activity: 'busy' });
  let state = await (await f.view('/api/state')).json();
  assert.equal(state.agentControl.canStop, true);
  assert.equal(state.stream, null);
  assert.equal((await f.view('/api/agent/stop', { turnId: 'stale' })).status, 409);
  assert.equal((await f.view('/api/agent/stop', { turnId: 'cli-work' })).status, 202);
  assert.equal((await (await control('poll', 'cli-work', { activity: 'busy' })).json()).stop.turnId, 'cli-work');
  const queued = await (await f.view('/api/questions', { documentId: doc.id, text: 'Unsent', clientMessageId: 'unsent' })).json();
  await control('interrupted', 'old-work');
  state = await (await f.view('/api/state')).json();
  assert.equal(state.agentControl.stopping, true);
  await control('interrupted', 'cli-work');
  state = await (await f.view('/api/state')).json();
  assert.equal(state.agentControl.canStop, false); assert.equal(state.agentControl.stopping, false);
  assert.equal(state.requests[queued.id].status, 'queued');
  await control('poll', 'new-work', { activity: 'busy' });
  assert.equal((await f.view('/api/agent/stop', { turnId: 'cli-work' })).status, 409);
});

for (const origin of ['idle', 'busy', 'monitor'] as const) test(`Claude native ${origin} input binds its request before any assistant output`, async t => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'sc-input-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(t, 10000, root), doc = await f.register();
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Question', clientMessageId: 'question' })).json();
  const event = await (await f.agent(`/agent/requests/${request.id}/prepare`, {})).json();
  const handlers = new Map<string, any>(); const { register } = await import(new URL('../hooks/control.js', import.meta.url).href);
  register((name: string, handler: unknown) => handlers.set(name, handler));
  const api = {
    session: { id: async () => f.owner.sessionId }, env: { get: async () => root }, fs: { read: (path: string) => readFile(path, 'utf8') },
    http: { fetch: async (url: string, options: RequestInit) => { const response = await fetch(url, options); return { ok: response.ok, text: await response.text() }; } },
    clock: { every: () => ({ cancel() {} }) },
  };
  const text = 'Monitor output:\n' + JSON.stringify(event) + '\n';
  if (origin === 'idle') await handlers.get('turn.start')(api, { text, turnId: 'native-input' }, (e: unknown) => e);
  else if (origin === 'busy') await handlers.get('prompt.submit')(api, { text, turnId: 'native-input', wait: false }, (e: unknown) => e);
  else {
    await handlers.get('turn.start')(api, { text: 'Ordinary CLI work', turnId: 'native-input' }, (e: unknown) => e);
    const truncated = '<event>' + JSON.stringify(event).slice(0, 600) + '...(truncated)</event>';
    const hydrated = await handlers.get('prompt.attachment')(api, { type: 'queued_command', origin: { kind: 'engine' }, text: truncated }, (e: unknown) => e);
    assert.ok(hydrated.text.includes(JSON.stringify(event)), 'the model receives the original prepared question and markers without a fetch tool');
    assert.ok(hydrated.text.endsWith('</event>'));
    const other = await handlers.get('prompt.attachment')(api, { type: 'file', origin: { kind: 'engine' }, text: truncated }, (e: unknown) => e);
    assert.equal(other.text, truncated, 'document content must not become a delivered input');
  }
  let saved = await (await f.view('/api/state')).json();
  assert.equal(saved.requests[request.id].nativeTurnId, 'native-input');
  assert.equal(saved.stream.text, '');
  assert.equal(saved.agentControl.canStop, true);
  assert.equal((await f.view('/api/agent/stop', { turnId: 'native-input' })).status, 202);
  await handlers.get('turn.complete')(api, { turnId: 'native-input', isAborted: true, answer: '' }, (e: unknown) => e);
  saved = await (await f.view('/api/state')).json();
  assert.equal(saved.requests[request.id].status, 'stopped');
});
