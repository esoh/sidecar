import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAgentIds } from '../src/agent-ids.ts';
import { compactNotification, compactContext } from '../src/agent-protocol.ts';
const owner = { agent: 'claude' as const, sessionId: '11111111-1111-4111-8111-111111111111' };
test('compact event maps only identity fields and omits marker definitions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sc-protocol-')); t.after(() => rm(root, { recursive: true, force: true }));
  const ids = await openAgentIds(root);
  const event = await compactNotification(owner, { type: 'sidecar.request', ownerKey: `claude-${owner.sessionId}`, requestId: 'request', documentId: 'doc', thread: { id: 'thread', lastRequestId: 'previous' }, covers: ['previous'], text: owner.sessionId, quote: { exact: 'request', sentence: 'request here' }, messageQuote: { threadId: 'thread', messageId: 'message', exact: 'message' }, stream: { prefix: 'LONG', suffix: 'LONG' }, instruction: 'Follow the Sidecar skill.' }, ids);
  assert.equal(event.type, 'sc.request'); assert.equal(event.ownerKey, 'o1'); assert.equal(event.requestId, 'r1'); assert.equal(event.documentId, 'd1');
  assert.deepEqual(event.thread, { id: 't1', lastRequestId: 'r2' }); assert.deepEqual(event.covers, ['r2']);
  assert.equal(event.text, owner.sessionId); assert.deepEqual(event.quote, { exact: 'request', sentence: 'request here' });
  assert.deepEqual(event.messageQuote, { threadId: 't1', messageId: 'm1', exact: 'message' }); assert.equal(event.stream, undefined);
  const failure = await compactNotification(owner, { type: 'sidecar.recovery', requestId: 'request', recoveryId: 'attempt', stream: { error: 'Unavailable' } }, ids);
  assert.equal(failure.recoveryId, 'e1'); assert.equal(failure.streamError, 'Unavailable');
});
test('full context aliases nested records without rewriting prose, paths or source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sc-context-')); t.after(() => rm(root, { recursive: true, force: true }));
  const ids = await openAgentIds(root);
  const result: any = await compactContext(owner, {
    request: { id: 'req', documentId: 'doc', threadId: 'thread', batchId: 'req', nativeTurnId: 'private-turn', submission: 'private', clientMessageId: 'private', replyRecovery: { id: 'retry', turnId: 'private', status: 'pending' }, text: 'doc', answeredBy: 'later' },
    document: { id: 'doc', version: 'hash', path: '/doc', markdown: 'hash' },
    thread: { id: 'thread', documentId: 'doc', messages: [{ id: 'msg', requestId: 'req', text: 'msg', selections: [{ id: 'sel', slug: 'selection-1', quote: { exact: 'hash', version: 'hash' } }] }] },
    proposals: [{ id: 'prop', documentId: 'doc', threadId: 'thread', messageId: 'msg', selectionId: 'sel', baseVersion: 'hash', appliedVersion: 'hash2', before: 'hash', after: 'hash2' }],
  }, ids);
  assert.equal(result.request.nativeTurnId, undefined); assert.equal(result.request.submission, undefined); assert.equal(result.request.clientMessageId, undefined);
  assert.deepEqual(result.request.replyRecovery, { id: 'e1', status: 'pending' });
  assert.equal(result.document.version, 'v1'); assert.equal(result.document.markdown, 'hash'); assert.equal(result.document.path, '/doc');
  assert.equal(result.thread.messages[0].selections[0].quote.version, 'v1'); assert.equal(result.thread.messages[0].selections[0].slug, 'selection-1');
  assert.equal(result.proposals[0].selectionId, 's1'); assert.equal(result.proposals[0].appliedVersion, 'v2'); assert.equal(result.proposals[0].before, 'hash');
});

import { fixture } from './support.ts';
import { ownerKey } from '../src/store.ts';
test('negotiated delivery stays compact across hydration and restart, while old deliveries stay legacy', async t => {
  const f = await fixture(t), doc = await f.register(), key = ownerKey(f.owner);
  const post = async (path: string, body: unknown, compact = true) => {
    const response = await fetch(f.url + path, { method: 'POST', headers: { 'X-Sidecar-Token': f.token, 'Content-Type': 'application/json', ...(compact ? { 'X-Sidecar-Protocol': 'sc1' } : {}) }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const ask = (id: string) => f.view('/api/questions', { documentId: doc.id, text: id, clientMessageId: id }).then(r => r.json());
  const old = await ask('legacy');
  const legacy = await post(`/agent/requests/${old.id}/prepare`, {});
  assert.equal(legacy.type, 'sidecar.request', 'watcher capability alone is insufficient');
  await post('/agent/control', { ownerKey: key, event: 'poll', turnId: 'idle', activity: 'idle', protocol: 'sc1' });
  const current = await ask('compact');
  const event = await post(`/agent/requests/${current.id}/prepare`, {});
  assert.equal(event.type, 'sc.request'); assert.match(event.requestId, /^r[1-9A-Z][0-9A-Z]*$/); assert.equal(event.stream, undefined);
  const context = await post(`/agent/requests/${event.requestId}/claim`, {});
  assert.equal(context.request.id, event.requestId); assert.equal(context.document.id, event.documentId);
  await f.reopen();
  await post(`/agent/requests/${event.requestId}/claim`, { resume: true });
  await post(`/agent/requests/${old.id}/claim`, { resume: true });
  const markers = await post('/agent/streams', { requestId: event.requestId, documentId: event.documentId, threadId: event.thread.id });
  assert.equal(markers.prefix, `[[sc:${event.requestId}]]\n`);
  const oldMarkers = await post('/agent/streams', { requestId: old.id, documentId: doc.id, threadId: old.threadId });
  assert.equal(oldMarkers.prefix, legacy.stream.prefix);
  await post('/agent/replies', { requestId: event.requestId, documentId: event.documentId, threadId: event.thread.id, text: 'Saved via aliases.' });
  const state = await (await f.view('/api/state')).json();
  assert.equal(state.requests[current.id].answer.text, 'Saved via aliases.'); assert.equal(state.documents[doc.id].id, doc.id);
});
test('native inbox reserves once at a tool boundary and binds receipt before output', async t => {
  const f = await fixture(t), doc = await f.register(), key = ownerKey(f.owner);
  const post = async (path: string, body: unknown) => {
    const response = await fetch(f.url + path, { method: 'POST', headers: { 'X-Sidecar-Token': f.token, 'Content-Type': 'application/json', 'X-Sidecar-Protocol': 'sc1' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  await post('/agent/control', { ownerKey: key, event: 'poll', turnId: 'tool-turn', activity: 'busy', protocol: 'sc1', delivery: 'tool-context-v1' });
  const text = 'Head ' + 'payload '.repeat(1400) + ' tail';
  const req = await (await f.view('/api/questions', { documentId: doc.id, text, clientMessageId: 'long' })).json();
  const responses = await Promise.all([1, 2].map(() => post('/agent/inbox', { ownerKey: key, turnId: 'tool-turn' })));
  const events = responses.flatMap(r => r.notification ? [r.notification] : []);
  assert.equal(events.length, 1); assert.equal(events[0].text, text); assert.equal(events[0].type, 'sc.request');
  await post('/agent/control', { ownerKey: key, event: 'received', turnId: 'tool-turn', requestIds: [events[0].requestId], protocol: 'sc1' });
  const state = await (await f.view('/api/state')).json();
  assert.equal(state.requests[req.id].nativeTurnId, 'tool-turn'); assert.equal(state.agentControl.canStop, true);
  await f.view('/api/agent/stop', { turnId: 'tool-turn' });
  assert.equal((await post('/agent/inbox', { ownerKey: key, turnId: 'tool-turn' })).notification, undefined);
});

test('module-only and expired Claude capabilities keep new deliveries legacy', async t => {
  const f = await fixture(t), doc = await f.register(), key = ownerKey(f.owner);
  const control = () => f.agent('/agent/control', { ownerKey: key, event: 'poll', turnId: 'idle', activity: 'idle', protocol: 'sc1' });
  const ask = (text: string) => f.view('/api/questions', { documentId: doc.id, text, clientMessageId: text }).then(r => r.json());
  await control(); const first = await ask('module-only');
  assert.equal((await (await f.agent(`/agent/requests/${first.id}/prepare`, {})).json()).type, 'sidecar.request');
  await new Promise(resolve => setTimeout(resolve, 2600));
  const second = await ask('expired');
  const response = await fetch(`${f.url}/agent/requests/${second.id}/prepare`, { method: 'POST', headers: { 'X-Sidecar-Token': f.token, 'Content-Type': 'application/json', 'X-Sidecar-Protocol': 'sc1' }, body: '{}' });
  assert.equal(response.status, 200); assert.equal((await response.json()).type, 'sidecar.request');
});
test('failed registry preparation retains the question and exposes a native delivery error', async t => {
  const f = await fixture(t), doc = await f.register(), key = ownerKey(f.owner);
  await f.agent('/agent/control', { ownerKey: key, event: 'poll', turnId: 'native-turn', activity: 'busy', protocol: 'sc1', delivery: 'tool-context-v1' });
  const req = await (await f.view('/api/questions', { documentId: doc.id, text: 'Retain this', clientMessageId: 'failure' })).json();
  await rm(join(f.directory, 'agent-ids/registry.json'));
  const response = await fetch(`${f.url}/agent/inbox`, { method: 'POST', headers: { 'X-Sidecar-Token': f.token, 'Content-Type': 'application/json', 'X-Sidecar-Protocol': 'sc1' }, body: JSON.stringify({ ownerKey: key, turnId: 'native-turn' }) });
  assert.equal(response.status, 503); assert.equal((await response.json()).notification, undefined);
  const state = await (await f.view('/api/state')).json();
  assert.equal(state.requests[req.id].status, 'queued'); assert.equal(state.requests[req.id].acceptedAt, undefined);
  assert.match(state.connectionError, /could not be prepared/);
});

for (const event of ['completed', 'interrupted']) test(`native ${event} snapshot preserves an unfinished second-thread reply before display arrives`, async t => {
  const f = await fixture(t), doc = await f.register(), key = ownerKey(f.owner), turnId = 'multi-reply';
  await f.agent('/agent/control', { ownerKey: key, event: 'poll', turnId, activity: 'busy', protocol: 'sc1' });
  const prepare = async (text: string) => {
    const req = await (await f.view('/api/questions', { documentId: doc.id, text, clientMessageId: text })).json();
    const response = await fetch(`${f.url}/agent/requests/${req.id}/prepare`, { method: 'POST', headers: { 'X-Sidecar-Token': f.token, 'Content-Type': 'application/json', 'X-Sidecar-Protocol': 'sc1' }, body: '{}' });
    const prepared = await response.json(); assert.equal(prepared.type, 'sc.request');
    return { req, prepared };
  };
  const a = await prepare('First thread'), b = await prepare('Second thread');
  await f.agent('/agent/control', { ownerKey: key, event: 'received', turnId, requestIds: [a.prepared.requestId, b.prepared.requestId] });
  const answer = `[[sc:${a.prepared.requestId}]]\nComplete first.\n[[/sc:${a.prepared.requestId}]]\n\n[[sc:${b.prepared.requestId}]]\n[[sc-meta {"threadTitle":"Must stay unapplied"}]]\nKnown second partial`;
  await f.agent('/agent/control', { ownerKey: key, event, turnId, answer });
  const state = await (await f.view('/api/state')).json();
  assert.equal(state.requests[a.req.id].status, 'completed');
  assert.equal(state.requests[b.req.id].status, event === 'completed' ? 'claimed' : 'stopped');
  if (event === 'completed') {
    assert.equal(state.requests[b.req.id].replyRecovery?.status, 'pending');
    assert.equal(state.stream.text, 'Known second partial');
  } else assert.equal(state.requests[b.req.id].answer.text, 'Known second partial');
  assert.notEqual(state.threads[b.req.threadId].title, 'Must stay unapplied');
  await f.agent('/agent/stream-events', { ownerKey: key, messageId: 'late-display', turnId, index: 0, delta: answer, final: true });
  const late = await (await f.view('/api/state')).json();
  assert.deepEqual(late.requests[b.req.id], state.requests[b.req.id]);
});
