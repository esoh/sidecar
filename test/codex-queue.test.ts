import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { reconcileCodexQueue } from '../src/codex-queue.ts';
import { startServer } from '../src/server.ts';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const entry = (id: string, requestId: string, ownerKey = 'codex-original') => ({ id, clientUserMessageId: id, input: [{ type: 'text', text: JSON.stringify({ type: 'sidecar.request', ownerKey, requestId }) }] });
async function native(t: { after: (fn: () => Promise<void>) => void }, threadId = 'original') {
  const root = await mkdtemp(join(tmpdir(), 's'));
  await mkdir(join(root, 'app-server-control'));
  const path = join(root, 'app-server-control/app-server-control.sock');
  const http = createServer(), ws = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(path, resolve));
  t.after(async () => { for (const client of ws.clients) client.terminate(); ws.close(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const state = { queue: [entry('native-first', 'first'), entry('native-next', 'next')], status: 'idle', threadId, starts: [] as string[], deletes: [] as string[], methods: [] as string[], steerable: false, steered: [] as Record<string, unknown>[], failDelete: false, raceStart: false, loadQueue: async () => {} };
  ws.on('connection', socket => { let client = ''; socket.on('message', async bytes => {
    const m = JSON.parse(String(bytes)); state.methods.push(m.method);
    const result = (result: unknown) => socket.send(JSON.stringify({ id: m.id, result }));
    const error = () => socket.send(JSON.stringify({ id: m.id, error: { code: -32000, message: 'Native request refused' } }));
    if (m.method === 'initialize') { client = m.params.clientInfo.name; if (client === 'sidecar-queue') assert.equal(m.params.capabilities.experimentalApi, true); result({}); }
    if (m.method === 'thread/read' || m.method === 'thread/resume') result({ thread: { id: state.threadId, status: { type: state.status } } });
    // This fixture exercises queue fallback when the activity sampler cannot
    // identify a steerable turn. The explicit Reset subsequently verifies it.
    if (m.method === 'thread/turns/list') result({ data: client === 'sidecar-status' && !state.steerable ? [] : [{ id: 'terminal-work', status: state.status === 'active' ? 'inProgress' : 'completed', items: [] }] });
    if (m.method === 'turn/steer') { state.steered.push(JSON.parse(m.params.input[0].text)); result({ turnId: 'terminal-work' }); }
    if (m.method === 'turn/interrupt') {
      state.status = 'idle'; result({});
      socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: 'terminal-work', status: 'interrupted', items: [] } } }));
    }
    if (m.method === 'thread/queue/list') {
      await state.loadQueue();
      // Two pages exercise matching beyond the first page.
      result({ data: m.params.cursor ? state.queue.slice(1) : state.queue.slice(0, 1), nextCursor: !m.params.cursor && state.queue.length > 1 ? 'next-page' : null });
    }
    if (m.method === 'thread/queue/delete') {
      if (state.failDelete) { error(); return; }
      state.deletes.push(m.params.queuedSubmissionId);
      state.queue = state.queue.filter(item => item.id !== m.params.queuedSubmissionId); result({});
    }
    if (m.method === 'thread/queue/start') {
      if (state.raceStart) { state.status = 'active'; error(); return; }
      assert.equal(state.status, 'idle');
      assert.equal(m.params.threadId, threadId);
      const index = state.queue.findIndex(item => item.id === m.params.queuedSubmissionId);
      assert.ok(index >= 0); state.queue.splice(index, 1);
      state.starts.push(m.params.queuedSubmissionId); state.status = 'active';
      result({ turn: { id: 'started-turn', status: 'inProgress' } });
    }
  }); });
  return { root, state, emit: (event: unknown) => { for (const socket of ws.clients) socket.send(JSON.stringify(event)); }, run: (options: { cancelRequestIds?: string[]; startRequestId?: string; canStart?: () => boolean }) => reconcileCodexQueue(threadId, options, AbortSignal.timeout(1000), path) };
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(10); }
  assert.fail(message);
}

async function delivery(t: { after: (fn: () => Promise<void>) => void }, holdRecovery = false) {
  const owner = { agent: 'codex' as const, sessionId: randomUUID() }, n = await native(t, owner.sessionId);
  n.state.queue = []; n.state.status = 'active';
  const log = join(n.root, 'deliveries.jsonl'), waiting = join(n.root, 'recovery-waiting'), release = join(n.root, 'recovery-release');
  await writeFile(log, '');
  await writeFile(join(n.root, 'codex'), `#!${process.execPath}
const fs = require('node:fs'), message = process.argv[6];
const deliver = () => fs.appendFileSync(${JSON.stringify(log)}, message + '\\n');
if (${holdRecovery} && JSON.parse(message).type === 'sidecar.recovery') {
  fs.writeFileSync(${JSON.stringify(waiting)}, message);
  const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); deliver(); } }, 10);
} else deliver();
`, { mode: 0o700 });
  const previousHome = process.env.CODEX_HOME, previousPath = process.env.PATH;
  process.env.CODEX_HOME = n.root; process.env.PATH = `${n.root}:${previousPath}`;
  t.after(async () => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; process.env.PATH = previousPath; });
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const seen = new Set<string>();
  n.state.loadQueue = async () => {
    for (const event of await events()) {
      const id = event.recoveryId ?? event.requestId;
      if (seen.has(id)) continue; seen.add(id);
      n.state.queue.push({ id: `native-${id}`, clientUserMessageId: id, input: [{ type: 'text', text: JSON.stringify(event) }] });
    }
  };
  const directory = join(n.root, 'viewer'), server = await startServer({ owner, directory, pollMs: 20 });
  t.after(() => server.close());
  const token = await readFile(join(directory, 'agent-token'), 'utf8'), cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0];
  const post = async (path: string, body: unknown) => fetch(server.url + path, { method: 'POST', headers: { Cookie: cookie, Origin: server.url, 'X-Sidecar-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const closeDoc = (id: string) => fetch(server.url + `/api/documents/${id}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: server.url } });
  const read = async () => (await fetch(server.url + '/api/state', { headers: { Cookie: cookie } })).json();
  const file = join(n.root, 'review.md'); await writeFile(file, '# Review');
  const doc = await (await post('/agent/documents', { path: file })).json();
  return { owner, n, post, read, doc, events, waiting, release, closeDoc };
}

test('an idle Codex starts the exact existing delivery once without re-enqueueing it', async t => {
  const { state, run } = await native(t);
  await run({ startRequestId: 'first' });
  await run({ startRequestId: 'first' });
  assert.deepEqual(state.starts, ['native-first']);
  assert.deepEqual(state.queue.map(item => item.id), ['native-next']);
  assert.ok(state.methods.every(method => ['initialize', 'initialized', 'thread/read', 'thread/queue/list', 'thread/queue/start'].includes(method)));
});

test('Reset withdraws only its exact cancelled deliveries across native queue pages', async t => {
  const { state, run } = await native(t);
  state.queue.push(entry('foreign', 'first', 'codex-other'), { id: 'terminal', clientUserMessageId: 'terminal', input: [{ type: 'text', text: 'My terminal work' }] });
  await run({ cancelRequestIds: ['first', 'next'] });
  assert.deepEqual(state.deletes, ['native-first', 'native-next']);
  assert.deepEqual(state.queue.map(item => item.id), ['foreign', 'terminal']);
  assert.deepEqual(state.starts, []);
});

test('busy, unloaded or mismatched agents are never started and terminal messages are not bypassed', async t => {
  const { state, run } = await native(t);
  state.status = 'active'; await run({ startRequestId: 'first' });
  state.status = 'idle'; await run({ startRequestId: 'first', canStart: () => false });
  state.status = 'idle'; await run({ startRequestId: 'next' });
  state.status = 'notLoaded'; await assert.rejects(run({ cancelRequestIds: ['first'] }));
  state.status = 'idle'; state.threadId = 'other'; await assert.rejects(run({ cancelRequestIds: ['first'], startRequestId: 'next' }));
  assert.deepEqual(state.deletes, []); assert.deepEqual(state.starts, []);
});

test('failed withdrawal and a racing native turn fail closed without duplicate sends', async t => {
  const { state, run } = await native(t);
  state.failDelete = true;
  await assert.rejects(run({ cancelRequestIds: ['first'], startRequestId: 'next' }));
  assert.deepEqual(state.queue.map(item => item.id), ['native-first', 'native-next']);
  state.failDelete = false; state.raceStart = true;
  await assert.rejects(run({ startRequestId: 'first' }));
  assert.deepEqual(state.starts, []); assert.deepEqual(state.deletes, []);
});

for (const mode of ['reset', 'failed-withdrawal', 'idle-after-busy'] as const) test(`Codex delivery and Reset: ${mode}`, async t => {
  const fails = mode === 'failed-withdrawal';
  const { n, post, read, doc, events } = await delivery(t);
  const first = await (await post('/api/questions', { documentId: doc.id, text: 'First', clientMessageId: 'first' })).json();
  const second = await (await post('/api/questions', { documentId: doc.id, text: 'Next', clientMessageId: 'next' })).json();
  for (let i = 0; i < 100 && !(await read()).requests[first.id].acceptedAt; i++) await delay(10);
  assert.ok((await read()).requests[first.id].acceptedAt);
  if (mode === 'idle-after-busy') {
    // Delivery while terminal work is active must start when it becomes idle,
    // even when no browser has an SSE connection.
    assert.deepEqual(n.state.starts, []);
    n.state.status = 'idle';
    for (let i = 0; i < 200 && !n.state.starts.length; i++) await delay(10);
    assert.deepEqual(n.state.starts, [`native-${first.id}`]);
    assert.equal((await read()).requests[second.id].status, 'claimed');
    assert.equal((await events()).length, 2);
    return;
  }
  n.state.failDelete = fails;
  assert.equal((await post('/api/agent/reset', {})).status, 202);
  let saved;
  for (let i = 0; i < 200; i++) { saved = await read(); if (['done', 'failed'].includes(saved.reset?.status)) break; await delay(10); }
  assert.equal(saved.reset.status, fails ? 'failed' : 'done');
  if (fails) {
    assert.equal(saved.requests[first.id].status, 'claimed'); assert.equal(saved.requests[second.id].status, 'claimed');
    assert.deepEqual(n.state.starts, []);
  } else {
    assert.deepEqual(n.state.deletes, [`native-${first.id}`, `native-${second.id}`]);
    assert.deepEqual(n.state.starts, []);
    assert.equal((await read()).requests[first.id].status, 'stopped');
    assert.equal((await read()).requests[second.id].status, 'stopped');
    assert.equal((await events()).length, 2, 'no message is submitted twice');
  }
});

for (const phase of ['queued', 'in-flight'] as const) test(`a complete reply withdraws its ${phase} native recovery before later work`, async t => {
  const { owner, n, post, read, doc, events, waiting, release } = await delivery(t, phase === 'in-flight');
  n.state.status = 'idle';
  const first = await (await post('/api/questions', { documentId: doc.id, text: 'First', clientMessageId: 'first' })).json();
  await waitFor(() => n.state.starts.length === 1, 'the original request did not start');
  const original = (await events())[0];
  n.emit({ method: 'item/agentMessage/delta', params: { threadId: owner.sessionId, turnId: 'started-turn', itemId: 'partial', delta: original.stream.prefix + 'Partial' } });
  await waitFor(async () => (await read()).stream?.text === 'Partial', 'partial answer was not captured');
  // The original turn ended without final boundaries. Other native work keeps
  // the resulting recovery queued while the original complete reply arrives.
  n.emit({ method: 'turn/completed', params: { threadId: owner.sessionId, turn: { id: 'started-turn', status: 'completed', items: [] } } });
  let recovery;
  if (phase === 'in-flight') {
    await waitFor(() => readFile(waiting, 'utf8').then(() => true, () => false), 'the recovery CLI was not held before enqueue');
    recovery = JSON.parse(await readFile(waiting, 'utf8'));
    assert.equal((await events()).length, 1, 'the recovery must still be in flight');
  } else {
    await waitFor(async () => (await events()).length === 2, 'the recovery was not delivered');
    await n.state.loadQueue();
    recovery = (await events())[1];
    assert.deepEqual(n.state.queue.map(item => item.id), [`native-${recovery.recoveryId}`]);
  }
  assert.equal(recovery.type, 'sidecar.recovery');
  assert.equal(recovery.requestId, first.id);
  assert.equal((await post('/agent/replies', { requestId: first.id, documentId: doc.id, threadId: first.threadId, text: 'The original complete answer' })).status, 200);
  assert.equal((await read()).requests[first.id].status, 'completed');
  if (phase === 'in-flight') {
    await writeFile(release, 'go');
    await waitFor(async () => (await events()).length === 2, 'the recovery CLI did not finish');
    await n.state.loadQueue();
  }
  // Cleanup must happen without another question, a Reset, or a viewer SSE connection.
  await waitFor(() => n.state.deletes.includes(`native-${recovery.recoveryId}`), 'the completed request left its obsolete recovery queued');
  assert.deepEqual(n.state.queue, []);
  assert.deepEqual(n.state.starts, [`native-${first.id}`], 'the obsolete recovery must never run');
  const second = await (await post('/api/questions', { documentId: doc.id, text: 'Next', clientMessageId: 'next' })).json();
  await waitFor(async () => (await events()).length === 3, 'the next request was not delivered');
  n.state.status = 'idle';
  await waitFor(() => n.state.starts.length === 2, 'the next request remained blocked');
  assert.deepEqual(n.state.starts, [`native-${first.id}`, `native-${second.id}`]);
  assert.equal((await read()).requests[first.id].answer.text, 'The original complete answer');
  assert.equal((await events()).length, 3, 'native start and cleanup must not re-enqueue work');
});

test('closing a completed document retains cleanup of its in-flight recovery', async t => {
  const { owner, n, post, read, doc, events, waiting, release, closeDoc } = await delivery(t, true);
  n.state.status = 'idle';
  const first = await (await post('/api/questions', { documentId: doc.id, text: 'First', clientMessageId: 'first' })).json();
  await waitFor(() => n.state.starts.length === 1, 'the original request did not start');
  const original = (await events())[0];
  n.emit({ method: 'item/agentMessage/delta', params: { threadId: owner.sessionId, turnId: 'started-turn', itemId: 'partial', delta: original.stream.prefix + 'Partial' } });
  await waitFor(async () => (await read()).stream?.text === 'Partial', 'partial answer was not captured');
  n.emit({ method: 'turn/completed', params: { threadId: owner.sessionId, turn: { id: 'started-turn', status: 'completed', items: [] } } });
  await waitFor(() => readFile(waiting, 'utf8').then(() => true, () => false), 'the recovery CLI was not held before enqueue');
  const recovery = JSON.parse(await readFile(waiting, 'utf8'));
  assert.equal((await post('/agent/replies', { requestId: first.id, documentId: doc.id, threadId: first.threadId, text: 'The original complete answer' })).status, 200);
  assert.equal((await closeDoc(doc.id)).status, 200);
  assert.equal((await read()).requests[first.id], undefined, 'closing deletes the completed request record');
  await writeFile(release, 'go');
  await waitFor(async () => (await events()).length === 2, 'the recovery CLI did not finish');
  await n.state.loadQueue();
  await waitFor(() => n.state.deletes.includes(`native-${recovery.recoveryId}`), 'closing the document lost the pending recovery cleanup');
  assert.deepEqual(n.state.queue, []);
  assert.deepEqual(n.state.starts, [`native-${first.id}`], 'the deleted document’s recovery must never run');
  const reopened = await (await post('/agent/documents', { path: join(n.root, 'review.md') })).json();
  const next = await (await post('/api/questions', { documentId: reopened.id, text: 'Next', clientMessageId: 'next' })).json();
  await waitFor(async () => (await events()).length === 3, 'the next request was not delivered');
  n.state.status = 'idle';
  await waitFor(() => n.state.starts.length === 2, 'the deleted document’s recovery blocked new work');
  assert.deepEqual(n.state.starts, [`native-${first.id}`, `native-${next.id}`]);
  assert.equal((await events()).length, 3);
});

test('the first oversized input steers its ID-only notification into busy CLI work without an earlier reply stream', async t => {
  const { n, post, read, doc, events } = await delivery(t);
  n.state.steerable = true;
  const request = await (await post('/api/questions', { documentId: doc.id, text: 'large '.repeat(9000), clientMessageId: 'large' })).json();
  await waitFor(async () => !!(await read()).requests[request.id].acceptedAt, 'large request handoff');
  assert.equal(n.state.steered.length, 1);
  assert.equal(n.state.steered[0].requestId, request.id);
  assert.equal(n.state.steered[0].stream, undefined);
  assert.equal((await read()).requests[request.id].nativeTurnId, 'terminal-work');
  assert.deepEqual(await events(), [], 'native queue must not replace steering');
  n.emit({ method: 'turn/completed', params: { threadId: n.state.threadId, turn: { id: 'terminal-work', status: 'interrupted', items: [] } } });
  await waitFor(async () => (await read()).requests[request.id].status === 'stopped', 'unfetched large input must stop with its native turn');
});
