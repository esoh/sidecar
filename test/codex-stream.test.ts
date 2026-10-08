import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { observeCodex, resetCodexSession, readCodexControl } from '../src/codex-stream.ts';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/server.ts';
import { ReplyStream, type ReplyRoute, type StreamEvent } from '../src/stream.ts';

test('Codex interrupts only the turn bound to matching output and observes native confirmation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-stop-rpc-'));
  const path = join(root, 'native.sock'), http = createServer(), ws = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(path, resolve));
  t.after(async () => { for (const client of ws.clients) client.terminate(); ws.close(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  let send: (value: unknown) => void = () => { throw new Error('Not connected'); };
  const interrupts: unknown[] = [], ended: unknown[] = [];
  ws.on('connection', socket => {
    send = value => socket.send(JSON.stringify(value));
    socket.on('message', data => {
      const m = JSON.parse(data.toString());
      if (m.method === 'initialize') send({ id: m.id, result: {} });
      if (m.method === 'thread/read' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'original', status: { type: 'active' } } } });
      if (m.method === 'turn/interrupt') { interrupts.push(m.params); send({ id: m.id, result: {} }); }
    });
  });
  const prefix = '[[sidecar:probe]]\n';
  const observer = await observeCodex('original', () => {}, () => {}, path, [prefix], (id, status) => ended.push({ id, status }));
  t.after(() => observer());
  await assert.rejects(observer.interrupt('ordinary'), /no longer active/);
  const delta = (turnId: string, text: string) => send({ method: 'item/agentMessage/delta', params: { threadId: 'original', turnId, itemId: turnId, delta: text } });
  delta('ordinary', 'Unrelated work.'); delta('reply', prefix + 'Partial');
  for (let i = 0; i < 100 && !observer.canInterrupt('reply'); i++) await delay(5);
  await assert.rejects(observer.interrupt('ordinary'), /no longer active/);
  await observer.interrupt('reply');
  assert.deepEqual(interrupts, [{ threadId: 'original', turnId: 'reply' }]);
  assert.deepEqual(ended, [], 'RPC acknowledgment is not interruption confirmation');
  send({ method: 'turn/completed', params: { threadId: 'original', turn: { id: 'reply', status: 'interrupted' } } });
  for (let i = 0; i < 100 && !ended.length; i++) await delay(5);
  assert.deepEqual(ended, [{ id: 'reply', status: 'interrupted' }]);
  await assert.rejects(observer.interrupt('reply'), /no longer active/);
});

for (const mode of ['idle', 'busy', 'wrong-session', 'disconnected', 'unconfirmed'] as const) test(`Codex Reset verifies native ${mode} state and never substitutes another session`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sc-reset-'));
  const path = join(root, 'native.sock'), http = createServer(), ws = new WebSocketServer({ server: http });
  const interrupts: unknown[] = [], methods: string[] = [];
  await new Promise<void>(resolve => http.listen(path, resolve));
  t.after(async () => { for (const client of ws.clients) client.terminate(); ws.close(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  let isInterrupted = false;
  ws.on('connection', socket => socket.on('message', data => {
    const m = JSON.parse(String(data)); methods.push(m.method);
    const reply = (result: unknown) => socket.send(JSON.stringify({ id: m.id, result }));
    if (m.method === 'initialize') reply({});
    if (m.method === 'thread/read' || m.method === 'thread/resume') reply({ thread: { id: mode === 'wrong-session' ? 'other' : 'original', status: { type: mode === 'disconnected' ? 'notLoaded' : mode === 'idle' || isInterrupted ? 'idle' : 'active' } } });
    if (m.method === 'thread/turns/list') reply({ data: [{ id: 'terminal-work', status: mode === 'idle' ? 'completed' : 'inProgress', items: [{ type: 'agentMessage', id: 'message', text: 'Captured native answer.' }] }], nextCursor: null });
    if (m.method === 'turn/interrupt') {
      interrupts.push(m.params); reply({});
      if (mode !== 'unconfirmed') {
        isInterrupted = true;
        // A stale end first must not satisfy Reset's wait.
        socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'original', turn: { id: 'old-turn', status: 'interrupted', items: [] } } }));
        socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'original', turn: { id: 'terminal-work', status: 'interrupted', items: [{ type: 'agentMessage', id: 'message', text: 'Captured native answer.' }] } } }));
      }
    }
  }));
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  if (mode === 'unconfirmed') timer = setTimeout(() => abort.abort(), 250);
  try {
    const result = resetCodexSession('original', abort.signal, path);
    if (mode === 'idle' || mode === 'busy') {
      assert.deepEqual(await result, { turnId: 'terminal-work', answer: 'Captured native answer.' });
      assert.deepEqual(interrupts, mode === 'busy' ? [{ threadId: 'original', turnId: 'terminal-work' }] : []);
    } else await assert.rejects(result, /session|verify/);
    if (mode === 'wrong-session' || mode === 'disconnected') {
      assert.equal(methods.includes('thread/resume'), false);
      assert.deepEqual(interrupts, []);
    }
  } finally { clearTimeout(timer); }
});

for (const loaded of [true, false]) test(`Codex observer ${loaded ? 'streams only its original loaded thread' : 'refuses to load a replacement session'}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-ws-'));
  const path = join(root, 'native.sock'), http = createServer();
  const ws = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(path, resolve));
  t.after(async () => { for (const client of ws.clients) client.terminate(); ws.close(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const methods: string[] = [], events: StreamEvent[] = [], failures: string[] = [];
  let send: (value: unknown) => void = () => { throw new Error('Not connected'); };
  ws.on('connection', socket => {
    send = value => socket.send(JSON.stringify(value));
    socket.on('message', data => {
      const message = JSON.parse(data.toString()); methods.push(message.method);
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'thread/read') {
        assert.deepEqual(message.params, { threadId: 'original', includeTurns: false });
        send({ id: message.id, result: { thread: { id: 'original', status: { type: loaded ? 'active' : 'notLoaded' } } } });
      }
      if (message.method === 'thread/resume') {
        assert.deepEqual(message.params, { threadId: 'original', excludeTurns: true });
        send({ id: message.id, result: { thread: { id: 'original' } } });
      }
    });
  });
  if (!loaded) {
    await assert.rejects(observeCodex('original', e => events.push(e), e => failures.push(e), path), /not loaded/);
    assert.deepEqual(methods, ['initialize', 'initialized', 'thread/read']);
    return;
  }
  const stop = await observeCodex('original', e => events.push(e), e => failures.push(e), path);
  t.after(async () => stop());
  const delta = (threadId: string, delta: string) => send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn', itemId: 'message', delta } });
  delta('other', 'Do not forward'); delta('original', 'Hello'); delta('original', ' world');
  send({ method: 'item/completed', params: { threadId: 'original', turnId: 'turn', item: { id: 'message', type: 'agentMessage', text: 'Hello world' } } });
  for (let i = 0; i < 100 && events.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events.map(e => [e.index, e.delta, e.final]), [[0, 'Hello', false], [1, ' world', false], [2, '', true]]);
  assert.deepEqual(failures, []);
  assert.deepEqual(methods, ['initialize', 'initialized', 'thread/read', 'thread/resume']);
  stop();
});

test('simultaneous stream startup shares one observer and closes it with the app', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's'));
  await mkdir(join(root, 'app-server-control'));
  await writeFile(join(root, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const previousHome = process.env.CODEX_HOME, previousPath = process.env.PATH;
  process.env.CODEX_HOME = root;
  process.env.PATH = root + ':' + process.env.PATH;
  const native = createServer(), ws = new WebSocketServer({ server: native });
  await new Promise<void>(resolve => native.listen(join(root, 'app-server-control/app-server-control.sock'), resolve));
  const owner = { agent: 'codex' as const, sessionId: randomUUID() };
  const resumes: (() => void)[] = [];
  ws.on('connection', socket => {
    socket.on('message', data => {
      const m = JSON.parse(data.toString());
      if (m.method === 'initialize') socket.send(JSON.stringify({ id: m.id, result: {} }));
      if (m.method === 'thread/read') socket.send(JSON.stringify({ id: m.id, result: { thread: { id: owner.sessionId, status: { type: 'active' } } } }));
      if (m.method === 'thread/resume') resumes.push(() => socket.send(JSON.stringify({ id: m.id, result: { thread: { id: owner.sessionId } } })));
      if (m.method === 'thread/turns/list') socket.send(JSON.stringify({ id: m.id, result: { data: [] } }));
      if (m.method === 'thread/queue/list') socket.send(JSON.stringify({ id: m.id, result: { data: [], nextCursor: null } }));
    });
  });
  const directory = join(root, 'state');
  const sidecar = await startServer({ owner, directory, stateRoot: directory });
  const token = await readFile(join(directory, 'agent-token'), 'utf8');
  const cookie = (await fetch(sidecar.url)).headers.get('set-cookie')!.split(';')[0];
  const post = async (path: string, body: unknown) => fetch(sidecar.url + path, { method: 'POST', headers: { 'X-Sidecar-Token': token, Cookie: cookie, Origin: sidecar.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const file = join(root, 'a.md'); await writeFile(file, '# Test\n' + 'x'.repeat(60000));
    const doc = await (await post('/agent/documents', { path: file })).json();
    const routes: ReplyRoute[] = [];
    // Force ID-only delivery so this test, not automatic preparation, controls observer startup.
    for (let i = 0; i < 2; i++) {
      const req = await (await post('/api/questions', { documentId: doc.id, text: 'Hello '.repeat(10000), clientMessageId: 'q' + i })).json();
      routes.push({ requestId: req.id, documentId: doc.id, threadId: req.threadId });
    }
    await post(`/agent/requests/${routes[0].requestId}/claim`, {});
    const first = post('/agent/streams', routes[0]);
    while (!resumes[0]) await delay(5);
    await post('/agent/replies', { ...routes[0], text: 'Fallback' });
    await post(`/agent/requests/${routes[1].requestId}/claim`, {});
    const second = post('/agent/streams', routes[1]);
    resumes[0](); assert.equal((await second).status, 200);
    assert.equal((await first).status, 200);
    await delay(20);
    assert.equal(ws.clients.size, 1);
    await sidecar.close();
    await delay(30);
    assert.equal(ws.clients.size, 0, 'Sidecar stop must close the active native observer');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    process.env.PATH = previousPath;
    await sidecar.close();
    for (const client of ws.clients) client.terminate();
    ws.close(); await new Promise<void>(resolve => native.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex activity reads native runtime state without loading, resuming, or sending a turn', async t => {
  const { readCodexActivity } = await import('../src/codex-stream.ts');
  const root = await mkdtemp(join(tmpdir(), 'sidecar-status-'));
  const path = join(root, 'native.sock'), http = createServer(), ws = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(path, resolve));
  t.after(async () => { for (const client of ws.clients) client.terminate(); ws.close(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  let status: unknown = { type: 'idle' }, id = 'original';
  const methods: string[] = [];
  ws.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data.toString()); methods.push(message.method);
    if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === 'thread/read') {
      assert.deepEqual(message.params, { threadId: 'original', includeTurns: false });
      socket.send(JSON.stringify({ id: message.id, result: { thread: { id, status } } }));
    }
  }));
  const abort = new AbortController();
  for (const [native, expected] of [
    [{ type: 'idle' }, 'idle'], [{ type: 'active', activeFlags: [] }, 'busy'],
    [{ type: 'active', activeFlags: ['waitingOnApproval'] }, 'waiting'],
    [{ type: 'notLoaded' }, 'disconnected'], [{ type: 'systemError' }, 'unknown'],
  ]) {
    status = native;
    assert.equal(await readCodexActivity('original', abort.signal, path), expected);
  }
  id = 'other'; assert.equal(await readCodexActivity('original', abort.signal, path), 'unknown');
  abort.abort(); assert.equal(await readCodexActivity('original', abort.signal, path), 'unknown');
  assert.ok(methods.every(method => ['initialize', 'initialized', 'thread/read'].includes(method)));
});


test('Codex captures a complete retry after the interrupted turn ends', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-retry-'));
  const path = join(root, 'native.sock'), http = createServer(), ws = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(path, resolve));
  t.after(async () => { for (const client of ws.clients) client.terminate(); ws.close(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  let send: (value: unknown) => void = () => { throw new Error('Not connected'); };
  ws.on('connection', socket => {
    send = value => socket.send(JSON.stringify(value));
    socket.on('message', data => {
      const m = JSON.parse(data.toString());
      if (m.method === 'initialize') send({ id: m.id, result: {} });
      if (m.method === 'thread/read' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: 'original', status: { type: 'idle' } } } });
    });
  });
  const reply = new ReplyStream({ requestId: 'request', documentId: 'document', threadId: 'thread' });
  const stop = await observeCodex('original', event => { reply.accept(event); }, error => reply.fail(error), path, [reply.prefix, reply.progress.prefix]);
  t.after(() => stop());
  const delta = (turnId: string, itemId: string, text: string) => send({ method: 'item/agentMessage/delta', params: { threadId: 'original', turnId, itemId, delta: text } });
  delta('interrupted', 'old-message', reply.prefix + 'Partial');
  send({ method: 'turn/completed', params: { threadId: 'original', turn: { id: 'interrupted', status: 'interrupted', items: [] } } });
  for (let i = 0; i < 100 && !reply.error; i++) await delay(5);
  assert.match(reply.error ?? '', /turn ended/);
  delta('retry', 'unrelated', 'Ordinary terminal text.');
  const text = reply.prefix + 'Saved retry.' + reply.suffix;
  delta('retry', 'new-message', text.slice(0, 8));
  delta('retry', 'new-message', text.slice(8));
  send({ method: 'item/completed', params: { threadId: 'original', turnId: 'retry', item: { id: 'new-message', type: 'agentMessage', text } } });
  for (let i = 0; i < 100 && !reply.done; i++) await delay(5);
  assert.equal(reply.finish(reply.route), 'Saved retry.');
  assert.equal(reply.error, null);
});

for (const mode of ['accepted', 'ended', 'changed', 'lost-ack', 'stale-stop'] as const) test(`native pre-output control: ${mode}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sc-control-')), path = join(root, 'native.sock');
  const http = createServer(), ws = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(path, resolve));
  t.after(async () => { for (const socket of ws.clients) socket.terminate(); ws.close(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const steers: unknown[] = [], interrupts: unknown[] = [];
  ws.on('connection', socket => socket.on('message', bytes => {
    const m = JSON.parse(String(bytes)), reply = (result: unknown) => socket.send(JSON.stringify({ id: m.id, result }));
    if (m.method === 'initialize') reply({});
    if (m.method === 'thread/read' || m.method === 'thread/resume') reply({ thread: { id: 'original', status: { type: mode === 'ended' ? 'idle' : 'active' } } });
    if (m.method === 'thread/turns/list') reply({ data: [{ id: mode === 'changed' || mode === 'stale-stop' ? 'new-turn' : 'cli-turn', status: 'inProgress' }] });
    if (m.method === 'turn/steer') { steers.push(m.params); if (mode === 'lost-ack') socket.terminate(); else reply({ turnId: 'cli-turn' }); }
    if (m.method === 'turn/interrupt') { interrupts.push(m.params); reply({}); }
  }));
  assert.deepEqual(await readCodexControl('original', AbortSignal.timeout(2000), path), mode === 'ended' ? { activity: 'idle' } : { activity: 'busy', turnId: mode === 'changed' || mode === 'stale-stop' ? 'new-turn' : 'cli-turn' });
  if (mode === 'stale-stop') {
    await assert.rejects(resetCodexSession('original', AbortSignal.timeout(2000), path, 'cli-turn'), /changed/);
    assert.deepEqual(interrupts, []); return;
  }
  const observer = await observeCodex('original', () => {}, () => {}, path);
  t.after(() => observer());
  const notification = { type: 'sidecar.request', requestId: 'receipt' };
  const result = observer.steer('cli-turn', notification, 'stable-input-id');
  if (mode === 'lost-ack') await assert.rejects(result);
  else assert.equal(await result, mode === 'accepted' ? 'accepted' : 'not-active');
  assert.deepEqual(steers, ['accepted', 'lost-ack'].includes(mode) ? [{ threadId: 'original', expectedTurnId: 'cli-turn', clientUserMessageId: 'stable-input-id', input: [{ type: 'text', text: JSON.stringify(notification) }] }] : []);
  assert.deepEqual(interrupts, []);
});
