import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { startServer } from '../src/server.ts';
import { forwardHook } from '../src/cli.ts';

// Native transports are disposable; the real observer, Claude hooks, watcher,
// stream parser and durable store remain in the path under test.
for (const agent of ['codex', 'claude'] as const) {
  for (const phase of ['between messages', 'during the second message', 'with a complete final snapshot'] as const) {
    test(`${agent}: terminal interruption ${phase} preserves output and releases queued work`, { timeout: 10000 }, async t => {
      const root = await mkdtemp(join(tmpdir(), 's'));
      const owner = { agent, sessionId: randomUUID() }, key = `${agent}-${owner.sessionId}`, directory = join(root, key);
      const previous = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, SIDECAR_STATE_DIR: process.env.SIDECAR_STATE_DIR };
      process.env.PATH = `${root}:${process.env.PATH}`; process.env.CODEX_HOME = root; process.env.SIDECAR_STATE_DIR = root;
      const deliveries = join(root, 'deliveries');
      await writeFile(deliveries, '');
      await writeFile(join(root, 'codex'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(deliveries)}, process.argv[6] + '\\n');\n`, { mode: 0o700 });
      await mkdir(join(root, 'app-server-control'));
      const native = createServer(), ws = new WebSocketServer({ server: native }), sockets = new Set<WebSocket>();
      await new Promise<void>(resolve => native.listen(join(root, 'app-server-control/app-server-control.sock'), resolve));
      ws.on('connection', socket => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket));
        socket.on('message', async raw => {
          const m = JSON.parse(String(raw));
          if (m.method === 'initialize') socket.send(JSON.stringify({ id: m.id, result: {} }));
          if (m.method === 'thread/read' || m.method === 'thread/resume') socket.send(JSON.stringify({ id: m.id, result: { thread: { id: owner.sessionId, status: { type: 'active' } } } }));
          if (m.method === 'thread/turns/list') socket.send(JSON.stringify({ id: m.id, result: { data: [{ id: 'first-turn', status: 'inProgress' }] } }));
          if (m.method === 'turn/steer') { await appendFile(deliveries, m.params.input[0].text + '\n'); socket.send(JSON.stringify({ id: m.id, result: { turnId: 'first-turn' } })); }
          if (m.method === 'thread/queue/list') socket.send(JSON.stringify({ id: m.id, result: { data: [], nextCursor: null } }));
        });
      });
      const server = await startServer({ owner, directory, pollMs: 20 });
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
      const waitFor = async (predicate: (s: any) => boolean) => {
        for (let i = 0; i < 200; i++) { const s = await state(); if (predicate(s)) return s; await delay(10); }
        assert.fail('Expected Sidecar state was not reached');
      };
      const eventCount = async (count: number) => {
        for (let i = 0; i < 200; i++) {
          const lines = (agent === 'codex' ? await readFile(deliveries, 'utf8') : watched).trim().split('\n').filter(Boolean);
          if (lines.length >= count) return JSON.parse(lines[count - 1]);
          await delay(10);
        }
        assert.fail('Queued work was not delivered');
      };
      const handlers = new Map<string, any>();
      const { register } = await import(new URL('../hooks/control.js', import.meta.url).href);
      register((name: string, handler: unknown) => handlers.set(name, handler));
      const api = {
        session: { id: async () => owner.sessionId },
        env: { get: async (name: string) => name === 'SIDECAR_STATE_DIR' ? root : undefined },
        fs: { read: (path: string) => readFile(path, 'utf8') },
        http: { fetch: async (url: string, options: RequestInit) => { const response = await fetch(url, options); return { ok: response.ok, text: await response.text() }; } },
      };
      async function emit(turnId: string, messageId: string, text: string, final = true) {
        if (agent === 'codex') for (const socket of sockets) {
          socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: owner.sessionId, turnId, itemId: messageId, delta: text } }));
          if (final) socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: owner.sessionId, turnId, item: { id: messageId, type: 'agentMessage', text } } }));
        } else {
          async function* chunks() { yield { kind: 'text', text }; }
          for await (const _ of handlers.get('turn.step')(api, { turnId }, chunks)) { /* forward the native marker */ }
          await forwardHook('claude', { session_id: owner.sessionId, hook_event_name: 'MessageDisplay', message_id: messageId, turn_id: `display-${turnId}`, index: 0, delta: text, final });
        }
      }
      async function interrupt(turnId: string, answer: string) {
        if (agent === 'codex') for (const socket of sockets) socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: owner.sessionId, turn: { id: turnId, status: 'interrupted', items: [{ id: 'last-message', type: 'agentMessage', text: answer }] } } }));
        else await handlers.get('turn.complete')(api, { turnId, answer, isAborted: true }, (e: unknown) => e);
      }
      const file = join(root, 'doc.md'); await writeFile(file, '# Scratch document\n');
      const doc = await (await post('/agent/documents', { path: file })).json();
      const request = await (await post('/api/questions', { documentId: doc.id, text: 'Explain', clientMessageId: 'first' })).json();
      const event = await eventCount(1);
      const metadata = '[[sidecar-meta {"highlights":[{"exact":"Scratch document","proposal":{"before":"# Scratch document","after":"# Revised document"}}]}]]\n';
      const first = event.stream.progress.prefix + metadata + 'Message one is complete.' + event.stream.progress.suffix;
      await emit('first-turn', 'progress', first);
      await waitFor(s => s.threads[request.threadId].messages.some((m: any) => m.text === 'Message one is complete.'));
      assert.deepEqual((await state()).proposals, {});

      // Idle/disconnected badges and another native turn are not cancellation evidence.
      for (const lifecycle of ['agent-idle', 'agent-disconnected']) await post('/agent/lifecycle', { ownerKey: key, event: lifecycle });
      await interrupt('unrelated-turn', first);
      assert.equal((await state()).requests[request.id].status, 'claimed');
      let answer = first;
      if (phase !== 'between messages') {
        answer = event.stream.prefix + metadata + 'Message two is partly written';
        await emit('first-turn', 'second-message', answer, false);
        await waitFor(s => s.stream?.text === 'Message two is partly written');
        assert.deepEqual((await state()).proposals, {});
        if (phase === 'with a complete final snapshot') answer = event.stream.prefix + metadata + 'Message two is complete.' + event.stream.suffix;
      }
      // Never call /api/requests/:id/stop: this interruption came from the terminal.
      await interrupt('first-turn', answer);
      const ended = await waitFor(s => s.requests[request.id].status !== 'claimed' || s.requests[request.id].replyRecovery?.status === 'failed');
      assert.equal(ended.requests[request.id].status, phase === 'with a complete final snapshot' ? 'completed' : 'stopped');
      assert.equal(ended.requests[request.id].replyRecovery, undefined);
      assert.equal(Object.keys(ended.proposals).length, phase === 'with a complete final snapshot' ? 1 : 0);
      assert.equal(await readFile(file, 'utf8'), '# Scratch document\n');
      const expected = ['Message one is complete.'];
      if (phase === 'during the second message') expected.push('Message two is partly written');
      if (phase === 'with a complete final snapshot') expected.push('Message two is complete.');
      assert.deepEqual(ended.threads[request.threadId].messages.filter((m: any) => m.role === 'agent').map((m: any) => m.text), expected);
      const saved = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
      assert.equal(saved.requests[request.id].status, ended.requests[request.id].status, 'termination is durable');
      const next = await (await post('/api/questions', { documentId: doc.id, threadId: request.threadId, text: 'Next request', clientMessageId: 'next' })).json();
      const nextEvent = await eventCount(2);
      assert.equal(nextEvent.type, 'sidecar.request', 'do not replay the interrupted task or recover its reply');
      assert.equal(nextEvent.requestId, next.id);
      const nextProgress = nextEvent.stream.progress.prefix + 'Next request is working.' + nextEvent.stream.progress.suffix;
      await emit('next-turn', 'next-progress', nextProgress);
      await waitFor(s => s.threads[request.threadId].messages.some((m: any) => m.text === 'Next request is working.'));
      await interrupt('first-turn', answer);
      assert.equal((await state()).requests[next.id].status, 'claimed', 'a stale duplicate must not stop the new turn');
      await emit('next-turn', 'next-final', nextEvent.stream.prefix + 'Next request completed.' + nextEvent.stream.suffix);
      await waitFor(s => s.requests[next.id].status === 'completed');
    });
  }
}
