import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { startServer } from '../src/server.ts';
import { forwardHook } from '../src/cli.ts';
import { ownerKey } from '../src/store.ts';

for (const agent of ['codex', 'claude'] as const) test(`${agent} delivers compact context and captures a reply without agent setup commands`, { timeout: 10000 }, async t => {
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
    socket.on('message', async raw => {
      const m = JSON.parse(String(raw));
      if (m.method === 'initialize') socket.send(JSON.stringify({ id: m.id, result: {} }));
      if (m.method === 'thread/read' || m.method === 'thread/resume') socket.send(JSON.stringify({ id: m.id, result: { thread: { id: owner.sessionId, status: { type: 'active' } } } }));
      if (m.method === 'thread/queue/list') socket.send(JSON.stringify({ id: m.id, result: { data: [], nextCursor: null } }));
      if (m.method === 'thread/turns/list') socket.send(JSON.stringify({ id: m.id, result: { data: [{ id: 'reply', status: 'inProgress' }] } }));
      if (m.method === 'turn/steer') { await appendFile(deliveries, m.params.input[0].text + '\n'); socket.send(JSON.stringify({ id: m.id, result: { turnId: 'reply' } })); }
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
  const markdown = '# Context\nThe widget retries three times.\n' + 'Unrelated document text.\n'.repeat(3000);
  const version = createHash('sha256').update(markdown).digest('hex');
  const file = join(root, 'doc.md'); await writeFile(file, markdown);
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
  assert.deepEqual(event, {
    type: 'sidecar.request', ownerKey: key, requestId: req.id, documentId: doc.id, thread: { id: req.threadId, lastRequestId: null }, text: 'How many retries?',
    stream: event.stream, instruction: 'Follow the Sidecar skill.',
  });
  assert.ok(event.stream.prefix && event.stream.suffix);
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < 1000, 'large documents must not enlarge the event or force a fetch');
  assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).requests[req.id].status, 'claimed', 'the app still claims the request');
  for (let i = 0; i < 100 && !(await state()).requests[req.id].acceptedAt; i++) await delay(10);
  assert.ok((await state()).requests[req.id].acceptedAt, 'record the successful native handoff');
  assert.equal((await state()).requests[req.id].status, 'claimed', 'successful handoff is shown as Working');
  if (agent === 'codex') {
    for (const socket of sockets) {
      socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: owner.sessionId, turnId: 'unrelated', itemId: 'ordinary', delta: 'Unrelated terminal answer.' } }));
      socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: owner.sessionId, turnId: 'unrelated' } }));
    }
  } else {
    for (let i = 0; i < 70; i++) await forwardHook('claude', { session_id: owner.sessionId, hook_event_name: 'MessageDisplay', message_id: `unrelated-${i}`, turn_id: 'ordinary', index: 0, delta: 'Unrelated terminal answer.', final: true });
  }
  assert.ok(event.stream.progress?.prefix && event.stream.progress?.suffix);
  const proposalHeader = '[[sidecar-meta {"threadTitle":"Widget retry behavior","highlights":[{"exact":"The widget retries three times.","label":"Retry limit","proposal":{"before":"The widget retries three times.","after":"The widget retries four times."}}]}]]\n';
  const update = event.stream.progress.prefix + proposalHeader + 'I’ll check the retry setting.' + event.stream.progress.suffix;
  if (agent === 'codex') {
    for (const socket of sockets) {
      socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: owner.sessionId, turnId: 'reply', itemId: 'progress', delta: update } }));
      socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: owner.sessionId, turnId: 'reply', item: { id: 'progress', type: 'agentMessage', text: update } } }));
    }
  } else await forwardHook('claude', { session_id: owner.sessionId, hook_event_name: 'MessageDisplay', message_id: 'progress', turn_id: 'reply', index: 0, delta: update, final: true });
  for (let i = 0; i < 100 && !(await state()).threads[req.threadId].messages.some((m: any) => m.role === 'agent'); i++) await delay(10);
  const working = await state();
  assert.equal(working.requests[req.id].status, 'claimed');
  assert.equal(working.requests[req.id].answer, undefined, 'progress must not complete the request');
  assert.equal(working.threads[req.threadId].messages.at(-1).text, 'I’ll check the retry setting.');
  assert.deepEqual(working.proposals, {}, 'even complete progress metadata cannot create a proposal');
  const answer = event.stream.prefix + proposalHeader + 'Three retries.' + event.stream.suffix;
  if (agent === 'codex') {
    for (const socket of sockets) {
      socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: owner.sessionId, turnId: 'reply', itemId: 'answer', delta: answer } }));
      socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: owner.sessionId, turnId: 'reply', item: { id: 'answer', type: 'agentMessage', text: answer } } }));
    }
  } else await forwardHook('claude', { session_id: owner.sessionId, hook_event_name: 'MessageDisplay', message_id: 'answer', turn_id: 'reply', index: 0, delta: answer, final: true });
  for (let i = 0; i < 100 && (await state()).requests[req.id].status !== 'completed'; i++) await delay(10);
  const next = await (await post('/api/questions', { documentId: doc.id, threadId: req.threadId, text: 'Why?', clientMessageId: 'second' })).json();
  const second = await eventCount(2);
  assert.equal(second.requestId, next.id);
  assert.equal(second.documentId, doc.id);
  assert.deepEqual(second.thread, { id: req.threadId, lastRequestId: req.id, title: 'Widget retry behavior' });
  assert.equal(second.text, 'Why?');
  assert.equal(second.history, undefined, 'history is available on demand, not repeated in every event');
  const saved = await state();
  assert.equal(saved.requests[req.id].status, 'completed');
  assert.equal(saved.threads[req.threadId].messages.filter((m: any) => m.role === 'agent').length, 2);
  const savedAnswer = saved.threads[req.threadId].messages.filter((m: any) => m.role === 'agent').at(-1);
  assert.equal(savedAnswer.text, 'Three retries.');
  assert.equal(savedAnswer.selections[0].label, 'Retry limit');
  assert.equal(savedAnswer.selections[0].quote.version, version);
  const proposed = Object.values<any>(saved.proposals);
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].status, 'pending');
  assert.equal(proposed[0].before, 'The widget retries three times.');
  assert.equal(proposed[0].baseVersion, version);
  assert.equal(await readFile(file, 'utf8'), markdown, 'capturing a proposal must not edit the file');
  assert.equal((await post('/agent/replies', { requestId: req.id, documentId: doc.id, threadId: req.threadId, text: proposalHeader + 'Three retries.' })).status, 200);
  assert.deepEqual((await state()).proposals, saved.proposals, 'complete-reply replay must keep proposal identities');
  assert.notEqual(event.stream.prefix, second.stream.prefix);

  const partialAnswer = second.stream.prefix + 'Because the retry limit is three';
  if (agent === 'codex') for (const socket of sockets) socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: owner.sessionId, turnId: 'batch-reply', itemId: 'combined', delta: partialAnswer } }));
  else await forwardHook('claude', { session_id: owner.sessionId, hook_event_name: 'MessageDisplay', message_id: 'combined', turn_id: 'batch-reply', index: 0, delta: partialAnswer, final: false });
  for (let i = 0; i < 100 && (await state()).stream?.text !== 'Because the retry limit is three'; i++) await delay(10);
  assert.equal((await state()).stream.text, 'Because the retry limit is three');
  const decision = await post(`/api/proposals/${proposed[0].id}/decision`, { decision: 'accept' });
  assert.equal(decision.status, 200);
  const accepted = await state(), acceptedProposals = Object.values<any>(accepted.proposals);
  assert.equal(acceptedProposals[0].status, 'accepted');
  assert.equal(accepted.requests[next.id].status, 'claimed');
  assert.equal(accepted.stream.text, 'Because the retry limit is three', 'acceptance preserves a separate native reply in progress');
  assert.equal(await readFile(file, 'utf8'), markdown.replace('three times', 'four times'));
  await post(`/api/proposals/${proposed[0].id}/decision`, { decision: 'accept' });
  assert.deepEqual((await state()).proposals, accepted.proposals, 'duplicate acceptance preserves its first decision');
  assert.equal((agent === 'codex' ? await readFile(deliveries, 'utf8') : watched).trim().split('\n').filter(Boolean).length, 2, 'acceptance must not deliver another native request');

  const afterDelivery = await (await post('/api/questions', { documentId: doc.id, threadId: req.threadId, text: 'Arrived after delivery', clientMessageId: 'after-delivery' })).json();
  const combined = second.stream.prefix + 'Because the retry limit is three, then it stops.' + second.stream.suffix;
  if (agent === 'codex') {
    for (const socket of sockets) {
      socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: owner.sessionId, turnId: 'batch-reply', itemId: 'combined', delta: combined.slice(partialAnswer.length) } }));
      socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: owner.sessionId, turnId: 'batch-reply', item: { id: 'combined', type: 'agentMessage', text: combined } } }));
    }
  } else await forwardHook('claude', { session_id: owner.sessionId, hook_event_name: 'MessageDisplay', message_id: 'combined', turn_id: 'batch-reply', index: 1, delta: combined.slice(partialAnswer.length), final: true });
  const third = await eventCount(3);
  assert.equal(third.requestId, afterDelivery.id);
  assert.equal(third.thread.lastRequestId, next.id, 'use the previous input');
  const history = await (await post(`/agent/requests/${afterDelivery.id}/claim`, {})).json();
  assert.equal(history.claimStatus, 'already-claimed');
  assert.deepEqual(history.stream, third.stream, 'context recovery retains the same progress and final markers');
  assert.equal(history.thread.messages.filter((m: any) => m.role === 'agent').length, 3);
  assert.deepEqual(history.proposals, acceptedProposals, 'full context includes proposal decisions without enlarging native events');
  const afterBatch = await state();
  assert.equal(afterBatch.requests[next.id].status, 'completed');
  assert.equal(afterBatch.threads[req.threadId].messages.at(-1).text, 'Because the retry limit is three, then it stops.');
  await post('/agent/replies', { requestId: afterDelivery.id, documentId: doc.id, threadId: req.threadId, text: 'Then it stops retrying.' });
  const exact = 'The widget retries three times.';
  const quote = { exact, prefix: 'Context\n', suffix: '\n', start: 8, end: 8 + exact.length, version };
  const revised = markdown.replace('three times', 'four times');
  await writeFile(file, revised);
  const passage = await (await post('/api/questions', { documentId: doc.id, text: 'Clarify this?', quote, clientMessageId: 'passage' })).json();
  const selected = await eventCount(4);
  assert.deepEqual(selected, {
    type: 'sidecar.request', ownerKey: key, requestId: passage.id, documentId: doc.id, thread: { id: passage.threadId, lastRequestId: null }, text: 'Clarify this?',
    quote: { exact }, stream: selected.stream, instruction: 'Follow the Sidecar skill.',
  });
  assert.ok(selected.stream.prefix && selected.stream.suffix);
  assert.equal(JSON.stringify(selected).split(exact).length - 1, 1, 'include a complete selected sentence only once');
  await post('/agent/replies', { requestId: passage.id, documentId: doc.id, threadId: passage.threadId, text: 'That was the previous retry limit.' });
  const partialQuote = { ...quote, exact: 'three', start: 27, end: 32, sentence: exact };
  const partial = await (await post('/api/questions', { documentId: doc.id, threadId: passage.threadId, text: 'What does this mean?', quote: partialQuote, clientMessageId: 'partial' })).json();
  const excerpt = await eventCount(5);
  assert.equal(excerpt.requestId, partial.id);
  assert.deepEqual(excerpt.quote, { exact: 'three', sentence: exact });
  const full = await (await post(`/agent/requests/${partial.id}/claim`, {})).json();
  assert.equal(full.claimStatus, 'already-claimed', 'optional context retrieval must not take a second claim');
  assert.equal(full.document.path, doc.path);
  assert.equal(full.document.markdown, revised);
  assert.equal(full.document.version, createHash('sha256').update(revised).digest('hex'));
  assert.deepEqual(full.request.quote, partialQuote, 'full original anchors remain available for disambiguation');
  assert.equal(full.thread.id, passage.threadId);
  assert.deepEqual(full.thread.messages.filter((m: any) => m.role === 'user').map((m: any) => m.selections?.[0].quote.exact), [exact, 'three']);
  await post('/agent/replies', { requestId: partial.id, documentId: doc.id, threadId: partial.threadId, text: 'It means the old limit.' });
  const general = await (await post('/api/questions', { documentId: doc.id, threadId: passage.threadId, text: 'What else?', clientMessageId: 'general-followup' })).json();
  const unselected = await eventCount(6);
  assert.equal(unselected.requestId, general.id);
  assert.equal(unselected.quote, undefined, 'an unselected follow-up must not inherit a previous message selection');
  const latest = await state();
  assert.deepEqual(latest.threads[passage.threadId].messages.filter((m: any) => m.role === 'user').map((m: any) => m.selections?.[0].quote.exact), [exact, 'three', undefined]);
  await post('/agent/replies', { requestId: general.id, documentId: doc.id, threadId: general.threadId, text: 'Nothing else.' });
  const source = latest.threads[req.threadId].messages.find((m: any) => m.role === 'agent');
  const messageQuote = { threadId: req.threadId, messageId: source.id, exact: 'check the retry setting' };
  const quoted = await (await post('/api/questions', { documentId: doc.id, threadId: passage.threadId, text: 'Clarify that reply?', messageQuote, clientMessageId: 'message-quote' })).json();
  const quotedEvent = await eventCount(7);
  assert.equal(quotedEvent.requestId, quoted.id);
  assert.deepEqual(quotedEvent.messageQuote, messageQuote);
  assert.equal(quotedEvent.quote, undefined);
  const savedQuote = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.deepEqual(savedQuote.requests[quoted.id].messageQuote, messageQuote);
  assert.deepEqual(savedQuote.threads[quoted.threadId].messages.at(-1).messageQuote, messageQuote);

  // Reproduce the live failure: correct progress, stale final markers, then idle.
  const progress = quotedEvent.stream.progress.prefix + 'Looking at it.' + quotedEvent.stream.progress.suffix;
  const stale = event.stream.prefix + 'Wrong markers.' + event.stream.suffix;
  const nativeMessage = async (turnId: string, messageId: string, text: string) => {
    if (agent === 'codex') for (const socket of sockets) {
      socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: owner.sessionId, turnId, itemId: messageId, delta: text } }));
      socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: owner.sessionId, turnId, item: { id: messageId, type: 'agentMessage', text } } }));
    }
    else await forwardHook('claude', { session_id: owner.sessionId, hook_event_name: 'MessageDisplay', turn_id: turnId, message_id: messageId, index: 0, delta: text, final: true });
  };
  await nativeMessage('broken', 'good-progress', progress);
  await nativeMessage('broken', 'bad-final', stale);
  if (agent === 'codex') for (const socket of sockets) {
    const end = { method: 'turn/completed', params: { threadId: owner.sessionId, turn: { id: 'broken', status: 'completed', items: [{ type: 'agentMessage', id: 'bad-final', text: stale }] } } };
    socket.send(JSON.stringify(end)); socket.send(JSON.stringify(end));
  }
  else {
    await post('/agent/control', { ownerKey: key, event: 'started', turnId: 'broken', marker: quotedEvent.stream.progress.prefix });
    await post('/agent/control', { ownerKey: key, event: 'completed', turnId: 'broken', answer: stale });
    await post('/agent/control', { ownerKey: key, event: 'completed', turnId: 'broken', answer: stale });
  }
  const recovery = await eventCount(8);
  assert.equal(recovery.type, 'sidecar.recovery');
  assert.equal(recovery.requestId, quoted.id);
  assert.equal(recovery.text, undefined);
  assert.equal(recovery.stream.prefix, quotedEvent.stream.prefix);
  assert.equal((await state()).requests[quoted.id].replyRecovery.status, 'sent');
  await nativeMessage('recovery', 'fixed-final', recovery.stream.prefix + 'Recovered answer.' + recovery.stream.suffix);
  for (let i = 0; i < 100 && (await state()).requests[quoted.id].status !== 'completed'; i++) await delay(10);
  assert.equal((await state()).requests[quoted.id].answer.text, 'Recovered answer.');
  assert.equal((agent === 'codex' ? await readFile(deliveries, 'utf8') : watched).trim().split('\n').length, 8);
  const workspaceDocument = await (await post('/agent/documents', { path: file, workspace: root })).json();
  await writeFile(join(root, 'app.ts'), 'export function check() {\n  return true;\n}\n');
  const fileQuote = { path: join(workspaceDocument.workspace, 'app.ts'), kind: 'code', exact: '  return true;', startLine: 2, endLine: 2 };
  const fileResponse = await post('/api/questions', { documentId: doc.id, threadId: passage.threadId, text: 'Explain this line', fileQuote, clientMessageId: 'file-quote' });
  assert.equal(fileResponse.status, 200);
  const fileRequest = await fileResponse.json();
  const fileEvent = await eventCount(9);
  assert.equal(fileEvent.requestId, fileRequest.id);
  assert.deepEqual(fileEvent.fileQuote, fileQuote);
  assert.equal(fileEvent.quote, undefined);
  assert.equal(fileEvent.messageQuote, undefined);
  const savedFileQuote = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.deepEqual(savedFileQuote.requests[fileRequest.id].fileQuote, fileQuote);
  assert.deepEqual(savedFileQuote.threads[fileRequest.threadId].messages.at(-1).fileQuote, fileQuote);
});
