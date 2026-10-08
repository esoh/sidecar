import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './support.ts';
import { setTimeout as delay } from 'node:timers/promises';

async function setup(t: Parameters<typeof fixture>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'sc-hook-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(t, 10000, root), doc = await f.register();
  const handlers = new Map<string, any>();
  const { register } = await import(new URL('../hooks/control.js', import.meta.url).href);
  register((name: string, handler: unknown) => handlers.set(name, handler));
  let tick = () => {}, submitted: string[] = [];
  const api = {
    session: { id: async () => f.owner.sessionId }, env: { get: async () => root }, fs: { read: (path: string) => readFile(path, 'utf8') },
    http: { fetch: async (url: string, options: RequestInit) => { const r = await fetch(url, options); return { ok: r.ok, text: await r.text() }; } },
    clock: { every: (_ms: number, callback: () => void) => { tick = callback; return { cancel() {} }; } },
    prompt: { submit: async ({ text }: { text: string }): Promise<{ text: string } | { drop: string }> => { submitted.push(text); await handlers.get('turn.start')(api, { text, turnId: 'idle-result' }, (e: unknown) => e); return { text }; } },
  };
  const state = () => f.view('/api/state').then(r => r.json());
  const until = async (predicate: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; tick(); await delay(10); } assert.fail('Native delivery did not settle'); };
  const ask = (id: string, text = id) => f.view('/api/questions', { documentId: doc.id, text, clientMessageId: id }).then(r => r.json());
  await handlers.get('turn.start')(api, { text: 'CLI work', turnId: 'tool-turn' }, (e: unknown) => e);
  await until(async () => (await state()).agentControl.canStop);
  return { f, api, handlers, ask, state, submitted, until };
}
test('Claude tool boundary carries the full input once and preserves the original tool result', async t => {
  const f = await setup(t), text = 'HEAD ' + 'context '.repeat(1300) + ' TAIL';
  const req = await f.ask('long', text), original = { ref: 7, result: { value: 'original' }, text: 'original', context: ['existing context'] };
  const hook = f.handlers.get('tool.call'); assert.ok(hook, 'native tool completion delivery is registered');
  const results = await Promise.all([1, 2].map(() => hook(f.api, { tool: 'Read' }, async () => original)));
  const attached = results.flatMap(r => (r.context ?? []).filter((x: string) => x !== 'existing context'));
  assert.equal(attached.length, 1); const event = JSON.parse(attached[0]);
  assert.equal(event.text, text); assert.equal(event.type, 'sc.request'); assert.equal(event.stream, undefined);
  assert.equal(results[0].ref, 7); assert.equal(results[0].result, original.result);
  assert.equal((await f.state()).requests[req.id].nativeTurnId, 'tool-turn');
  assert.equal(f.submitted.length, 0);
  const untouched = await hook(f.api, { tool: 'Read', agentId: 'worker' }, async () => original);
  assert.equal(untouched, original, 'subagent tools cannot consume main-session input');
});
test('Claude idle fallback submits once, without Monitor or a request-fetch command', async t => {
  const f = await setup(t);
  await f.handlers.get('turn.complete')(f.api, { turnId: 'tool-turn', answer: '', isAborted: false }, (e: unknown) => e);
  const req = await f.ask('idle');
  await f.until(async () => f.submitted.length === 1);
  await f.until(async () => (await f.state()).requests[req.id].nativeTurnId === 'idle-result');
  assert.equal(JSON.parse(f.submitted[0]).text, 'idle');
  const hook = f.handlers.get('tool.call');
  const result = await hook(f.api, { tool: 'Read' }, async () => ({ result: 'tool' }));
  assert.equal(result.context, undefined); assert.equal(f.submitted.length, 1);
});

test('failed idle submission is visible and never automatically repeated', async t => {
  const f = await setup(t); let attempts = 0;
  f.api.prompt.submit = async () => { attempts++; throw new Error('ambiguous native submit'); };
  await f.handlers.get('turn.complete')(f.api, { turnId: 'tool-turn', answer: '', isAborted: false }, (e: unknown) => e);
  const req = await f.ask('failed-submit');
  await f.until(async () => (await f.state()).requests[req.id].status === 'uncertain');
  assert.match((await f.state()).connectionError, /could not be confirmed/);
  for (let i = 0; i < 3; i++) {
    await f.handlers.get('tool.call')(f.api, { tool: 'Read' }, async () => ({ result: 'unchanged' }));
  }
  assert.equal(attempts, 1);
});

test('a native prompt refusal is visible instead of leaving the input silently claimed', async t => {
  const f = await setup(t); let attempts = 0;
  f.api.prompt.submit = async () => { attempts++; return { drop: 'A native prompt hook declined this input' }; };
  await f.handlers.get('turn.complete')(f.api, { turnId: 'tool-turn', answer: '', isAborted: false }, (e: unknown) => e);
  const req = await f.ask('refused-submit');
  await f.until(async () => (await f.state()).requests[req.id].status === 'uncertain');
  assert.match((await f.state()).connectionError, /could not be confirmed/);
  assert.equal(attempts, 1);
});

test('a turn ending after inbox reservation exposes the undelivered input instead of losing it', async t => {
  const f = await setup(t), req = await f.ask('late-boundary');
  const fetch = f.api.http.fetch; let release = () => {}, reserved = () => {};
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { reserved = resolve; });
  f.api.http.fetch = async (url, options) => { const result = await fetch(url, options); if (url.endsWith('/agent/inbox')) { reserved(); await held; } return result; };
  const original = { result: 'original' };
  const delivered = f.handlers.get('tool.call')(f.api, { tool: 'Read' }, async () => original);
  await ready;
  try { await f.handlers.get('turn.complete')(f.api, { turnId: 'tool-turn', answer: '', isAborted: false }, (e: unknown) => e); }
  finally { release(); }
  assert.equal(await delivered, original);
  const state = await f.state();
  assert.equal(state.requests[req.id].status, 'uncertain');
  assert.match(state.connectionError, /could not be confirmed/);
  assert.equal(f.submitted.length, 0);
});
test('a refused native recovery becomes retryable even though the original request was accepted', async t => {
  const f = await setup(t), req = await f.ask('recover'); let attempts = 0;
  const result = await f.handlers.get('tool.call')(f.api, { tool: 'Read' }, async () => ({ result: 'original' }));
  const event = JSON.parse(result.context[0]);
  await f.f.agent('/agent/stream-events', { ownerKey: `claude-${f.f.owner.sessionId}`, messageId: 'unfinished', turnId: 'tool-turn', index: 0, delta: `[[sc:${event.requestId}]]\nPartial answer`, final: true });
  f.api.prompt.submit = async () => { attempts++; throw new Error('Recovery could not enter the native session'); };
  await f.handlers.get('turn.complete')(f.api, { turnId: 'tool-turn', answer: `[[sc:${event.requestId}]]\nPartial answer`, isAborted: false }, (e: unknown) => e);
  await f.until(async () => (await f.state()).requests[req.id].replyRecovery?.status === 'failed');
  const state = await f.state();
  assert.equal(state.requests[req.id].status, 'claimed'); assert.ok(state.requests[req.id].acceptedAt);
  assert.equal(attempts, 1);
  assert.equal((await f.f.view(`/api/requests/${req.id}/retry-reply`, { recoveryId: state.requests[req.id].replyRecovery.id })).status, 202);
});
