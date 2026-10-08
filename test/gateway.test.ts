import { setupGateway } from './gateway-support.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

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
  const request = await result.json();
  const event = await (await b.agentCall(`/agent/requests/${request.id}/prepare`, {})).json();
  let received = '';
  const reading = (async () => { try { while (true) { const part = await reader.read(); if (part.done) break; received += new TextDecoder().decode(part.value); } } catch { /* Abort after checking delivery. */ } })();
  const emit = (messageId: string, delta: string, final = true) => b.agentCall('/agent/stream-events', { ownerKey: b.key, turnId: 'gateway-stream', messageId, index: 0, delta, final });
  await emit('progress', event.stream.progress.prefix + 'Gateway progress' + event.stream.progress.suffix);
  await emit('reply', event.stream.prefix + 'Gateway final' + event.stream.suffix);
  const saved = await (await f.view(base + '/api/state')).json();
  assert.equal(saved.requests[request.id].status, 'completed');
  assert.deepEqual(saved.threads[request.threadId].messages.filter((m: any) => m.role === 'agent').map((m: any) => m.text), ['Gateway progress', 'Gateway final']);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(received, /event: (change|runtime)/);
  assert.doesNotMatch(received, /Own document/);
  assert.ok(Buffer.byteLength(received) < 16000);
  const idle = received; await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(received, idle);
  abort.abort(); await reading;
});

test('protected gateway authenticates once, confines native APIs, and revokes a live stream on rotation', async t => {
  const f = await setupGateway(t), owner = f.owners[1], base = `/a/${owner.alias}`;
  await f.gateway.setNetworkAccess(true, 'gateway test passphrase', 'https://sidecar.example');
  const network = f.gateway.networkStatus(true), target = network.tunnelTarget!;
  const call = (path: string, body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = httpRequest(target + path, { method: body === undefined ? 'GET' : 'POST', headers: { Host: 'sidecar.example', 'X-Forwarded-Proto': 'https', Origin: 'https://sidecar.example', ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    }); req.on('error', reject); req.end(body);
  });
  assert.equal((await call(base + '/api/state')).status, 401);
  assert.match((await call(base + '/')).text, /Passphrase/);
  const login = await call(base + '/?document=' + owner.doc.id, 'passphrase=gateway+test+passphrase', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(login.status, 303); assert.equal(login.headers.location, base + '/?document=' + owner.doc.id);
  const cookie = login.headers['set-cookie']![0].split(';')[0], headers = { Cookie: cookie, 'X-Sidecar-Token': await readFile(join(f.root, 'gateway/agent-token'), 'utf8') };
  assert.equal(JSON.parse((await call(base + '/api/state', undefined, headers)).text).owner.sessionId, owner.owner.sessionId);
  assert.equal(JSON.parse((await call('/api/library', undefined, headers)).text).sessions.length, 2);
  for (const prefix of ['', base]) {
    for (const path of ['/agent/status', '/gateway/status', '/gateway/network', '/api/tunnel-config']) assert.equal((await call(prefix + path, undefined, headers)).status, 403, prefix + path);
    const status = JSON.parse((await call(prefix + '/api/network', undefined, headers)).text);
    assert.equal(status.passphrase, undefined); assert.equal(status.tunnelTarget, undefined);
    assert.equal((await call(prefix + '/api/network', '{"enabled":false}', { ...headers, 'Content-Type': 'application/json', 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Host': new URL(f.gateway.url).host })).status, 403);
  }
  assert.equal((await call(base + '/api/questions', '{}', { ...headers, Origin: f.gateway.url })).status, 403);
  let closed!: () => void;
  const streamClosed = new Promise<void>(resolve => { closed = resolve; });
  const req = httpRequest(target + base + '/api/events?updates=1', { headers: { Host: 'sidecar.example', 'X-Forwarded-Proto': 'https', Cookie: cookie } });
  req.on('error', closed); t.after(() => req.destroy());
  await new Promise<void>((resolve, reject) => {
    req.once('response', res => { assert.equal(res.statusCode, 200); res.resume(); res.once('close', closed); resolve(); });
    req.once('error', reject); req.end();
  });
  await f.gateway.setNetworkAccess(true, 'rotated gateway passphrase');
  await Promise.race([streamClosed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Revoked stream stayed open')), 1000).unref())]);
  assert.equal((await call(base + '/api/state', undefined, headers)).status, 401);
  assert.equal((await f.view(base + '/api/state')).status, 200);
});

test('old backend identity is checked before proxying and requires an explicit upgrade', async t => {
  const f = await setupGateway(t), owner = f.owners[1];
  const runtimePath = join(owner.directory, 'runtime.json'), saved = await readFile(runtimePath, 'utf8'), runtime = JSON.parse(saved);
  const { createServer } = await import('node:http'); let unexpected = 0, wrongOwner = false;
  const old = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/agent/status') res.end(JSON.stringify({ ownerKey: wrongOwner ? f.owners[0].key : owner.key, instanceId: runtime.instanceId }));
    else { unexpected++; res.end('{}'); }
  });
  await new Promise<void>(resolve => old.listen(0, '127.0.0.1', resolve));
  const address = old.address(); assert.ok(address && typeof address !== 'string');
  t.after(() => new Promise<void>(resolve => { old.closeAllConnections(); old.close(() => resolve()); }));
  await writeFile(runtimePath, JSON.stringify({ ...runtime, url: `http://127.0.0.1:${address.port}` }));
  const response = await f.view(`/a/${owner.alias}/api/state`);
  assert.equal(response.status, 409); assert.match((await response.json()).error, /Update.*viewer/);
  wrongOwner = true; assert.equal((await f.view(`/a/${owner.alias}/api/state`)).status, 503);
  assert.equal(unexpected, 0); await writeFile(runtimePath, saved);
});

test('Stop and Reset reach only the selected owner; sibling restart leaves its stream connected', async t => {
  const f = await setupGateway(t), [sibling, owner] = f.owners, base = `/a/${owner.alias}`;
  const control = (event: string, fields = {}) => owner.agentCall('/agent/control', { ownerKey: owner.key, turnId: 'native-gateway-turn', event, ...fields });
  const abort = new AbortController(); t.after(() => abort.abort());
  const stream = await fetch(f.gateway.url + base + '/api/events?updates=1', { headers: { Cookie: f.cookie }, signal: abort.signal });
  const reader = stream.body!.getReader(); await reader.read();
  await sibling.restart();
  assert.equal((await control('poll', { activity: 'busy' })).status, 200);
  assert.equal((await f.view(base + '/api/agent/stop', { turnId: 'native-gateway-turn' })).status, 202);
  assert.equal((await (await control('poll')).json()).stop.turnId, 'native-gateway-turn');
  await control('interrupted');
  assert.equal((await f.view(base + '/api/agent/reset', {})).status, 202);
  const { reset } = await (await control('poll')).json(); assert.ok(reset.id);
  await control('reset-idle', { resetId: reset.id });
  assert.equal((await (await f.view(`/a/${sibling.alias}/api/state`)).json()).reset, null);
  const update = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Sibling interrupted SSE')), 1000).unref())]);
  assert.equal(update.done, false); abort.abort();
});
