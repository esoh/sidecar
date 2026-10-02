import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { observeCodex } from '../src/codex-stream.ts';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/server.ts';
import type { ReplyRoute, StreamEvent } from '../src/stream.ts';

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

test('a superseded observer startup cannot orphan the next stream socket', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's'));
  await mkdir(join(root, 'app-server-control'));
  await writeFile(join(root, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const previousHome = process.env.CODEX_HOME, previousPath = process.env.PATH;
  process.env.CODEX_HOME = root;
  process.env.PATH = root + ':' + process.env.PATH;
  const native = createServer(), ws = new WebSocketServer({ server: native });
  await new Promise<void>(resolve => native.listen(join(root, 'app-server-control/app-server-control.sock'), resolve));
  const owner = { agent: 'codex' as const, sessionId: randomUUID() };
  let ordinal = 0;
  const resumes: (() => void)[] = [];
  ws.on('connection', socket => {
    const id = ordinal++;
    socket.on('message', data => {
      const m = JSON.parse(data.toString());
      if (m.method === 'initialize') socket.send(JSON.stringify({ id: m.id, result: {} }));
      if (m.method === 'thread/read') socket.send(JSON.stringify({ id: m.id, result: { thread: { id: owner.sessionId, status: { type: 'active' } } } }));
      if (m.method === 'thread/resume') resumes[id] = () => socket.send(JSON.stringify({ id: m.id, result: { thread: { id: owner.sessionId } } }));
    });
  });
  const directory = join(root, 'state');
  const sidecar = await startServer({ owner, directory });
  const token = await readFile(join(directory, 'agent-token'), 'utf8');
  const cookie = (await fetch(sidecar.url)).headers.get('set-cookie')!.split(';')[0];
  const post = async (path: string, body: unknown) => fetch(sidecar.url + path, { method: 'POST', headers: { 'X-Sidecar-Token': token, Cookie: cookie, Origin: sidecar.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const file = join(root, 'a.md'); await writeFile(file, '# Test\n' + 'x'.repeat(60000));
    const doc = await (await post('/agent/documents', { path: file })).json();
    const routes: ReplyRoute[] = [];
    for (let i = 0; i < 2; i++) {
      const req = await (await post('/api/questions', { documentId: doc.id, text: 'Hello', clientMessageId: 'q' + i })).json();
      routes.push({ requestId: req.id, documentId: doc.id, threadId: req.threadId });
    }
    await post(`/agent/requests/${routes[0].requestId}/claim`, {});
    const first = post('/agent/streams', routes[0]);
    while (!resumes[0]) await delay(5);
    await post('/agent/replies', { ...routes[0], text: 'Fallback' });
    await post(`/agent/requests/${routes[1].requestId}/claim`, {});
    const second = post('/agent/streams', routes[1]);
    while (!resumes[1]) await delay(5);
    resumes[1](); assert.equal((await second).status, 200);
    resumes[0](); assert.equal((await first).status, 500);
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
