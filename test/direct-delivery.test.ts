import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { startServer } from '../src/server.ts';
import { forwardHook } from '../src/cli.ts';
import { ownerKey } from '../src/store.ts';

for (const agent of ['codex', 'claude'] as const) test(`${agent} delivers answer-ready context and captures a reply without agent setup commands`, { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 's'));
  const owner = { agent, sessionId: randomUUID() }, key = ownerKey(owner), directory = join(root, key);
  const previous = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, SIDECAR_STATE_DIR: process.env.SIDECAR_STATE_DIR };
  process.env.PATH = `${root}:${process.env.PATH}`; process.env.CODEX_HOME = root; process.env.SIDECAR_STATE_DIR = root;
  const deliveries = join(root, 'deliveries');
  await writeFile(deliveries, '');
  await writeFile(join(root, 'codex'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(deliveries)}, process.argv[6] + '\\n');\n`, { mode: 0o700 });
  await mkdir(join(root, 'app-server-control'));
  const native = createServer(), ws = new WebSocketServer({ server: native });
  const sockets = new Set<WebSocket>();
  await new Promise<void>(resolve => native.listen(join(root, 'app-server-control/app-server-control.sock'), resolve));
  ws.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.method === 'initialize') socket.send(JSON.stringify({ id: m.id, result: {} }));
      if (m.method === 'thread/read' || m.method === 'thread/resume') socket.send(JSON.stringify({ id: m.id, result: { thread: { id: owner.sessionId, status: { type: 'active' } } } }));
    });
  });
  const server = await startServer({ owner, directory });
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ url: server.url, instanceId: server.instanceId, ownerKey: key }));
  const token = (await readFile(join(directory, 'agent-token'), 'utf8')).trim();
  const cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0]!;
  const post = (path: string, body: unknown) => fetch(server.url + path, { method: 'POST', headers: { Cookie: cookie, Origin: server.url, 'X-Sidecar-Token': token }, body: JSON.stringify(body) });
  const state = async () => (await fetch(server.url + '/api/state', { headers: { Cookie: cookie } })).json();
  const watcher = agent === 'claude' ? spawn(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname, 'watch', '--owner', key], { env: process.env }) : undefined;
  let watched = '';
  watcher?.stdout.on('data', chunk => { watched += chunk; });
  t.after(async () => {
    watcher?.kill(); await server.close();
    for (const socket of sockets) socket.terminate();
    ws.close(); await new Promise<void>(resolve => native.close(() => resolve()));
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
  });
  const file = join(root, 'doc.md'); await writeFile(file, '# Context\nThe widget retries three times.\n');
  const doc = await (await post('/agent/documents', { path: file })).json();
  const req = await (await post('/api/questions', { documentId: doc.id, text: 'How many retries?', clientMessageId: 'first' })).json();
  async function eventCount(count: number) {
    for (let i = 0; i < 200; i++) {
      const lines = (agent === 'codex' ? await readFile(deliveries, 'utf8') : watched).trim().split('\n').filter(Boolean);
      if (lines.length >= count) return JSON.parse(lines[count - 1]);
      await delay(10);
    }
    assert.fail('No delivery');
  }
  const event = await eventCount(1);
  assert.equal(event.requestId, req.id);
  assert.equal(event.claimStatus, 'claimed', 'the transport prepares the request, not the model');
  assert.equal(event.request.text, 'How many retries?');
  assert.equal(event.document.markdown, '# Context\nThe widget retries three times.\n');
  assert.equal(event.document.html, undefined, 'rendered HTML is unnecessary prompt overhead');
  assert.equal(event.thread.id, req.threadId);
  assert.ok(event.stream.prefix && event.stream.suffix);
  assert.equal((await state()).requests[req.id].status, 'queued', 'delivery is not evidence the agent has started');
  const next = await (await post('/api/questions', { documentId: doc.id, threadId: req.threadId, text: 'Why?', clientMessageId: 'second' })).json();
  if (agent === 'codex') {
    for (const socket of sockets) {
      socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: owner.sessionId, turnId: 'unrelated', itemId: 'ordinary', delta: 'Unrelated terminal answer.' } }));
      socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: owner.sessionId, turnId: 'unrelated' } }));
    }
  } else {
    for (let i = 0; i < 70; i++) await forwardHook('claude', { session_id: owner.sessionId, hook_event_name: 'MessageDisplay', message_id: `unrelated-${i}`, turn_id: 'ordinary', index: 0, delta: 'Unrelated terminal answer.', final: true });
  }
  const answer = event.stream.prefix + 'Three retries.' + event.stream.suffix;
  if (agent === 'codex') {
    for (const socket of sockets) {
      socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: owner.sessionId, turnId: 'reply', itemId: 'answer', delta: answer } }));
      socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: owner.sessionId, turnId: 'reply', item: { id: 'answer', type: 'agentMessage', text: answer } } }));
    }
  } else await forwardHook('claude', { session_id: owner.sessionId, hook_event_name: 'MessageDisplay', message_id: 'answer', turn_id: 'reply', index: 0, delta: answer, final: true });
  const second = await eventCount(2);
  assert.equal(second.requestId, next.id);
  assert.equal(second.thread.messages.find((m: any) => m.role === 'agent').text, 'Three retries.');
  const saved = await state();
  assert.equal(saved.requests[req.id].status, 'completed');
  assert.equal(saved.threads[req.threadId].messages.filter((m: any) => m.role === 'agent').length, 1);
  assert.notEqual(event.stream.prefix, second.stream.prefix);
});
