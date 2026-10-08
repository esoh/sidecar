import { setupGateway } from './gateway-support.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { startServer } from '../src/server.ts';
import { startGateway } from '../src/gateway.ts';
import { ownerKey, type Owner } from '../src/store.ts';

test('one origin routes Codex and Claude independently, with no native API access', async t => {
  const f = await setupGateway(t), [a, b] = f.owners;
  const library = await (await f.view('/api/library')).json();
  assert.equal(library.sessions.length, 2);
  assert.ok(library.sessions.every((s: any) => s.url.startsWith('/a/') && !s.url.includes('127.0.0.1')));
  for (const owner of f.owners) {
    const base = `/a/${owner.alias}`;
    const state = await (await f.view(base + '/api/state')).json(); assert.equal(state.owner.sessionId, owner.owner.sessionId);
    // Claude queues naturally without its native module; Codex routing reads are tested without calling the real CLI.
    if (owner.owner.agent === 'claude') {
      const response = await f.view(base + '/api/questions', { documentId: owner.doc.id, text: 'Only Claude', clientMessageId: 'one' });
      assert.equal(response.status, 200);
      const req = await response.json();
      await owner.agentCall(`/agent/requests/${req.id}/claim`, {});
      await owner.agentCall('/agent/replies', { requestId: req.id, documentId: owner.doc.id, threadId: req.threadId, text: 'Own reply' });
      const after = await (await f.view(base + '/api/state')).json(); assert.equal(after.threads[req.threadId].messages.at(-1).text, 'Own reply');
      assert.equal((await (await f.view(`/a/${a.alias}/api/state`)).json()).requests[req.id], undefined);
    }
    assert.equal((await f.view(base + '/agent/status')).status, 403);
    assert.equal((await f.view(base + '/api/documents/' + (owner === a ? b.doc.id : a.doc.id))).status, 404);
  }
  assert.equal((await f.view('/agent/status')).status, 403);
  assert.equal((await f.view('/a/oZZZZ/api/state')).status, 404);
  assert.equal((await f.view('/api/state?upstream=' + encodeURIComponent('http://127.0.0.1:1'))).status, 404);
  assert.equal((await fetch(f.gateway.url + `/a/${a.alias}/api/state`)).status, 403);
});

test('gateway rejects encoded traversal before forwarding and reconnects to the same restarted owner', async t => {
  const f = await setupGateway(t), [a, b] = f.owners;
  for (const path of [`/a/${a.alias}/%2e%2e/%2e%2e/agent/status`, `/a/${a.alias}/%61gent/status`, `/a/${a.alias}/api%2f..%2fagent/status`, `/a/${a.alias}/%252e%252e/agent/status`]) {
    const status = await new Promise(resolve => {
      const req = httpRequest(f.gateway.url, { path, headers: { Cookie: f.cookie } }, res => { res.resume(); resolve(res.statusCode); }); req.end();
    }); assert.ok([400, 403].includes(Number(status)), path);
  }
  const before = await (await f.view(`/a/${a.alias}/api/state`)).json();
  await a.restart();
  assert.deepEqual((await (await f.view(`/a/${a.alias}/api/state`)).json()).documents, before.documents);
  await a.stop();
  assert.equal((await f.view(`/a/${a.alias}/api/state`)).status, 503);
  assert.equal((await f.view(`/a/${b.alias}/api/state`)).status, 200);
  assert.equal((await f.view(`/api/library/${a.key}/documents/${a.doc.id}`)).status, 200);
  assert.equal((await f.view(`/api/library/${a.key}/documents/${a.doc.id}`, undefined, 'DELETE')).status, 200);
});

test('gateway forwards incremental SSE without buffering and hides backend cookies', async t => {
  const f = await setupGateway(t), b = f.owners[1], base = `/a/${b.alias}`;
  const abort = new AbortController(); t.after(() => abort.abort());
  const stream = await fetch(f.gateway.url + base + '/api/events?updates=1', { headers: { Cookie: f.cookie }, signal: abort.signal });
  assert.equal(stream.status, 200); assert.equal(stream.headers.get('set-cookie'), null);
  const reader = stream.body!.getReader();
  const pending = reader.read();
  const result = await f.view(base + '/api/questions', { documentId: b.doc.id, text: 'Streaming', clientMessageId: 'stream' });
  assert.equal(result.status, 200);
  const chunk = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE buffered')), 1500).unref())]);
  assert.match(new TextDecoder().decode(chunk.value), /event: (change|runtime)/);
  abort.abort();
});
