import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { observeCodex, readCodexControl, resetCodexSession } from '../src/codex-stream.ts';

const answer = 'The saved final answer.';
const largeItems = [
  { id: 'tool', type: 'commandExecution', aggregatedOutput: 'x'.repeat(3 * 1024 * 1024) },
  { id: 'final', type: 'agentMessage', text: answer },
];
const metadata = (status: string) => ({ id: 'long-turn', status, itemsView: 'notLoaded', items: [] });

async function native(t: TestContext, mode: 'active' | 'idle' = 'active') {
  const directory = await mkdtemp(join(tmpdir(), 'sc-long-'));
  const path = join(directory, 'native.sock'), http = createServer(), ws = new WebSocketServer({ server: http });
  const calls: { method: string; params: any }[] = [];
  let current = mode;
  let startsDuringRecovery = false;
  let lastSocket: WebSocket | undefined;
  let completion: Record<string, unknown> = { ...metadata('interrupted'), itemsView: 'full', items: largeItems };
  let invalidPage: 'other-turn' | 'repeated-cursor' | 'too-large' | undefined;
  await new Promise<void>(resolve => http.listen(path, resolve));
  t.after(async () => {
    for (const socket of ws.clients) socket.terminate();
    ws.close(); await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  ws.on('connection', socket => {
    lastSocket = socket;
    socket.on('message', bytes => {
      const m = JSON.parse(String(bytes)); calls.push(m);
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: m.id, result }));
      if (m.method === 'initialize') reply({});
      if (m.method === 'thread/read' || m.method === 'thread/resume') reply({ thread: { id: 'original', status: { type: current } } });
      if (m.method === 'thread/turns/list') reply({ data: [{
        ...metadata(current === 'active' ? 'inProgress' : 'completed'),
        ...(m.params.itemsView === 'notLoaded' ? {} : { itemsView: 'full', items: largeItems }),
      }], nextCursor: null });
      if (m.method === 'turn/steer') reply({ turnId: 'long-turn' });
      if (m.method === 'thread/items/list') {
        if (invalidPage === 'too-large') { socket.close(1009); return; }
        if (!m.params.cursor || invalidPage === 'repeated-cursor') {
          reply({ data: [{ turnId: 'long-turn', item: { id: 'last-tool', type: 'commandExecution', aggregatedOutput: 'done' }, startedAtMs: null, completedAtMs: null }], nextCursor: 'older', backwardsCursor: null });
        } else {
          if (startsDuringRecovery) current = 'active';
          reply({ data: [{ turnId: invalidPage === 'other-turn' ? 'different-turn' : 'long-turn', item: largeItems[1], startedAtMs: null, completedAtMs: null }], nextCursor: null, backwardsCursor: null });
        }
      }
      if (m.method === 'turn/interrupt') {
        current = 'idle';
        // The end can arrive before the interrupt RPC reply; an older turn must not satisfy it.
        socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'original', turn: { id: 'old-turn', status: 'interrupted', items: [{ type: 'agentMessage', text: 'Wrong answer' }] } } }));
        socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'original', turn: completion } }));
        reply({});
      }
    });
  });
  return {
    path, calls,
    complete(turn: Record<string, unknown>) { lastSocket!.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'original', turn } })); },
    setCompletion(turn: Record<string, unknown>) { completion = turn; },
    setInvalidPage(value: typeof invalidPage) { invalidPage = value; },
    startDuringRecovery() { startsDuringRecovery = true; },
    closeOversized() { lastSocket!.close(1009); },
  };
}

test('long active turns remain identifiable without loading their items', async t => {
  const n = await native(t);
  assert.deepEqual(await readCodexControl('original', AbortSignal.timeout(2000), n.path), { activity: 'busy', turnId: 'long-turn' });
  assert.equal(n.calls.find(c => c.method === 'thread/turns/list')?.params.itemsView, 'notLoaded');
  assert.ok(n.calls.every(c => ['initialize', 'initialized', 'thread/read', 'thread/turns/list'].includes(c.method)));
});

test('steering a long turn verifies metadata before sending once', async t => {
  const n = await native(t);
  const observer = await observeCodex('original', () => {}, () => {}, n.path);
  t.after(() => observer());
  assert.equal(await observer.steer('long-turn', { type: 'sidecar.request' }, 'request'), 'accepted');
  assert.equal(n.calls.find(c => c.method === 'thread/turns/list')?.params.itemsView, 'notLoaded');
  assert.deepEqual(n.calls.filter(c => c.method === 'turn/steer').map(c => c.params.expectedTurnId), ['long-turn']);
});

test('idle Reset recovers the latest answer through turn-scoped item pages', async t => {
  const n = await native(t, 'idle');
  assert.deepEqual(await resetCodexSession('original', AbortSignal.timeout(2000), n.path), { turnId: 'long-turn', answer });
  const pages = n.calls.filter(c => c.method === 'thread/items/list');
  assert.equal(pages.length, 2);
  assert.ok(pages.every(c => c.params.turnId === 'long-turn' && c.params.sortDirection === 'desc' && c.params.limit <= 25));
  assert.equal(pages[1]?.params.cursor, 'older');
  assert.ok(!n.calls.some(c => ['thread/resume', 'turn/interrupt'].includes(c.method)));
});

for (const view of ['full', 'notLoaded', 'summary'] as const) test(`Reset preserves the answer from a ${view} completion of a long turn`, async t => {
  const n = await native(t);
  if (view !== 'full') n.setCompletion({ ...metadata('interrupted'), itemsView: view });
  assert.deepEqual(await resetCodexSession('original', AbortSignal.timeout(2000), n.path, 'long-turn'), { turnId: 'long-turn', answer });
  assert.deepEqual(n.calls.filter(c => c.method === 'turn/interrupt').map(c => c.params), [{ threadId: 'original', turnId: 'long-turn' }]);
  assert.ok(n.calls.filter(c => c.method === 'thread/items/list').every(c => c.params.turnId === 'long-turn'));
});

for (const view of ['full', 'notLoaded', 'summary'] as const) test(`observer recovers the final answer from a ${view} completion`, { timeout: 3000 }, async t => {
  const n = await native(t);
  let finish!: (value: unknown) => void, fail!: (error: Error) => void;
  const ended = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const observer = await observeCodex('original', () => {}, message => fail(new Error(message)), n.path, undefined,
    (turnId, status, text) => finish({ turnId, status, text }));
  t.after(() => observer());
  n.complete({ ...metadata('completed'), itemsView: view, items: view === 'full' ? largeItems : [] });
  assert.deepEqual(await ended, { turnId: 'long-turn', status: 'completed', text: answer });
});

for (const invalid of ['other-turn', 'repeated-cursor'] as const) test(`Reset rejects ${invalid} answer recovery without interrupting another turn`, async t => {
  const n = await native(t, 'idle'); n.setInvalidPage(invalid);
  await assert.rejects(resetCodexSession('original', AbortSignal.timeout(2000), n.path), /answer|cursor|turn/i);
  assert.ok(!n.calls.some(c => c.method === 'turn/interrupt'));
});

test('an oversized observer message reports a size limit instead of suggesting reconnect', { timeout: 3000 }, async t => {
  const n = await native(t);
  let report!: (message: string) => void;
  const failure = new Promise<string>(resolve => { report = resolve; });
  const observer = await observeCodex('original', () => {}, report, n.path);
  t.after(() => observer());
  n.closeOversized();
  assert.match(await failure, /message.*size limit/i);
});

test('an oversized Reset answer reports a size limit without interrupting', async t => {
  const n = await native(t, 'idle'); n.setInvalidPage('too-large');
  await assert.rejects(resetCodexSession('original', AbortSignal.timeout(2000), n.path), /message.*size limit/i);
  assert.ok(!n.calls.some(c => c.method === 'turn/interrupt'));
});

test('idle Reset refuses if work starts while the previous answer is being recovered', async t => {
  const n = await native(t, 'idle'); n.startDuringRecovery();
  await assert.rejects(resetCodexSession('original', AbortSignal.timeout(2000), n.path), /started another turn/i);
  assert.ok(!n.calls.some(c => c.method === 'turn/interrupt'));
});
