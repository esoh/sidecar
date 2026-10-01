import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, rename, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './support.ts';

test('HTTP questions and replies retain routing, resolution, and history', async t => {
  const f = await fixture(t);
  const doc = await f.register();
  const other = await f.register('b.md', '# Second\n');
  const q = { documentId: doc.id, text: 'Explain', clientMessageId: 'q1' };
  const request = await (await f.view('/api/questions', q)).json();
  const claim = await (await f.agent(`/agent/requests/${request.id}/claim`, {})).json();
  assert.equal(claim.claimStatus, 'claimed');
  assert.equal(claim.document.markdown, '# First heading\n\nHello **world**.\n');
  const answer = { requestId: request.id, documentId: doc.id, threadId: request.threadId, text: 'The answer' };
  assert.equal((await f.agent('/agent/replies', { ...answer, documentId: other.id })).status, 409);
  await f.view(`/api/threads/${request.threadId}/resolution`, { isResolved: true });
  assert.equal((await f.agent('/agent/replies', answer)).status, 200);
  assert.equal((await f.agent('/agent/replies', answer)).status, 200);
  const state = await (await f.view('/api/state')).json();
  assert.equal(state.threads[request.threadId].isResolved, true);
  assert.equal(state.threads[request.threadId].messages.length, 2);
});

test('agent credentials, browser origin, and registered-path boundaries are enforced', async t => {
  const f = await fixture(t);
  const otherOwner = await fixture(t);
  const doc = await f.register();
  assert.equal((await fetch(f.url + '/agent/status', { headers: { 'X-Sidecar-Token': 'wrong' } })).status, 403);
  assert.equal((await fetch(f.url + '/agent/status', { headers: { 'X-Sidecar-Token': otherOwner.token } })).status, 403);
  assert.equal((await fetch(f.url + '/agent/status', { headers: { 'X-Sidecar-Token': 'é'.repeat(64) } })).status, 403);
  assert.equal((await f.view('/agent/documents', { path: '/etc/passwd' })).status, 403);
  assert.equal((await fetch(f.url + '/api/questions', { method: 'POST', headers: { Cookie: f.cookie, Origin: 'https://elsewhere.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: doc.id, text: 'Injected', clientMessageId: 'attack' }) })).status, 403);
  const crossSite = await fetch(f.url, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.headers.get('set-cookie'), null);
  assert.equal((await f.view('/api/documents/%2Fetc%2Fpasswd')).status, 404);
  assert.equal((await f.view('/api/documents/__proto__')).status, 404);
  assert.equal(Object.keys((await (await f.view('/api/state')).json()).requests).length, 0);
});

test('Markdown HTML and unsafe URL schemes never become executable markup', async t => {
  const f = await fixture(t);
  const doc = await f.register('unsafe.md', '# Safe **title**\n<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n[bad](javascript:alert(3)) [data](data:text/html,test) [good](https://example.com)');
  const content = await (await f.view(`/api/documents/${doc.id}`)).json();
  assert.equal(content.title, 'Safe title');
  assert.doesNotMatch(content.html, /<script|<img src=x|href="(?:javascript|data):/i);
  assert.match(content.html, /href="https:\/\/example.com"/);
});

test('file replacement, independent title overrides, and queued questions survive restart', async t => {
  const f = await fixture(t);
  const doc = await f.register();
  const other = await f.register('b.md', '# Other\n');
  const before = await (await f.view(`/api/documents/${doc.id}`)).json();
  await f.view(`/api/documents/${doc.id}/title`, { title: 'My review title' }, 'PATCH');
  await f.view(`/api/documents/${other.id}/title`, { title: 'Another title' }, 'PATCH');
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Pending', clientMessageId: 'pending' })).json();
  const replacement = join(f.directory, 'replacement.md');
  await writeFile(replacement, '# Changed heading\n\nNew body.\n');
  await rename(replacement, join(f.directory, 'a.md'));
  const after = await (await f.view(`/api/documents/${doc.id}`)).json();
  assert.notEqual(after.version, before.version);
  assert.equal(after.title, 'My review title');
  await f.reopen();
  const state = await (await f.view('/api/state')).json();
  assert.equal(state.requests[request.id].status, 'queued');
  assert.equal(state.documents[doc.id].title, 'My review title');
  assert.equal(state.documents[other.id].title, 'Another title');
});

test('a missing or redirected file retains its threads and can receive an explanatory failure', async t => {
  const f = await fixture(t);
  const doc = await f.register();
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Explain', clientMessageId: 'missing' })).json();
  await unlink(join(f.directory, 'a.md'));
  assert.equal((await f.view(`/api/documents/${doc.id}`)).status, 404);
  const claim = await (await f.agent(`/agent/requests/${request.id}/claim`, {})).json();
  assert.equal(claim.claimStatus, 'claimed');
  assert.ok(claim.document.error);
  await f.agent('/agent/replies', { requestId: request.id, documentId: doc.id, threadId: request.threadId, text: 'The file is unavailable.', isError: true });
  const state = await (await f.view('/api/state')).json();
  assert.equal(state.requests[request.id].status, 'failed');
  assert.equal(state.threads[request.threadId].messages.length, 2);
  await symlink(join(f.directory, 'agent-token'), join(f.directory, 'a.md'));
  assert.equal((await f.view(`/api/documents/${doc.id}`)).status, 409);
});

test('invalid and oversized JSON bodies fail without creating requests', async t => {
  const f = await fixture(t);
  const doc = await f.register();
  assert.equal((await f.view('/api/questions', { documentId: doc.id, text: {}, clientMessageId: 'invalid' })).status, 400);
  assert.equal((await f.view('/api/questions', { documentId: doc.id, text: 'x'.repeat(270000), clientMessageId: 'large' })).status, 413);
});


test('a document read announces changed source to existing viewers before the next poll', async t => {
  const f = await fixture(t, 60_000);
  const doc = await f.register('a.md', '# Before\n');
  const controller = new AbortController();
  try {
    const events = await fetch(f.url + '/api/events', { headers: { Cookie: f.cookie }, signal: controller.signal });
    const reader = events.body!.getReader();
    await reader.read(); // Consume the initial snapshot notification.
    const notification = reader.read().then(chunk => new TextDecoder().decode(chunk.value).includes('event: change'));
    await writeFile(join(f.directory, 'a.md'), '# After\n');
    const fresh = await (await f.view(`/api/documents/${doc.id}`)).json();
    assert.equal(fresh.heading, 'After');
    assert.equal(await Promise.race([notification, delay(500, false)]), true, 'Existing viewers must be notified when another reader refreshes the cache');
  } finally { controller.abort(); }
});


test('documents start with an empty general thread and thread creation retries do not duplicate or cross documents', async t => {
  const f = await fixture(t);
  const doc = await f.register(), other = await f.register('other.md');
  const snapshot = await (await f.view('/api/state')).json();
  const initial = Object.values<any>(snapshot.threads).filter(thread => thread.documentId === doc.id);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].scope, 'document');
  assert.equal(initial[0].title, undefined);
  assert.deepEqual(initial[0].messages, []);
  assert.equal(Object.keys(snapshot.requests).length, 0);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const create = () => f.view('/api/threads', { id, documentId: doc.id });
  assert.equal((await create()).status, 200);
  assert.equal((await create()).status, 200);
  assert.equal((await f.view('/api/threads', { id, documentId: other.id })).status, 409);
  assert.equal((await f.view('/api/threads', { id: '__proto__', documentId: doc.id })).status, 400);
  const request = await (await f.view('/api/questions', { documentId: doc.id, threadId: id, text: 'Explain', clientMessageId: 'empty-thread' })).json();
  assert.equal(request.threadId, id);
  await f.reopen();
  const restored = await (await f.view('/api/state')).json();
  assert.equal(Object.values<any>(restored.threads).filter(thread => thread.documentId === doc.id).length, 2);
  assert.equal(restored.threads[id].messages[0].text, 'Explain');
});

test('agent thread naming stays unset until supplied, persists, and cannot overwrite an assigned name', async t => {
  const f = await fixture(t), doc = await f.register();
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Quick question', clientMessageId: 'name' })).json();
  const path = `/agent/threads/${request.threadId}/title`;
  assert.equal((await f.view(path, { title: 'Unauthorized' })).status, 403);
  for (const title of ['', '  ', 'x'.repeat(81), 'Line one\nLine two', 42]) {
    assert.equal((await f.agent(path, { title })).status, 400);
  }
  await f.agent(`/agent/requests/${request.id}/claim`, {});
  await f.agent('/agent/replies', { requestId: request.id, documentId: doc.id, threadId: request.threadId, text: 'What is your question?' });
  assert.equal((await (await f.view('/api/state')).json()).threads[request.threadId].title, undefined);
  await f.view('/api/questions', { documentId: doc.id, threadId: request.threadId, text: 'Explain how drafts survive switching', clientMessageId: 'context' });
  assert.equal((await f.agent(path, { title: '  Preserving drafts  ' })).status, 200);
  assert.equal((await f.agent(path, { title: 'Preserving drafts' })).status, 200);
  assert.equal((await f.agent(path, { title: 'A different name' })).status, 409);
  await f.reopen();
  const thread = (await (await f.view('/api/state')).json()).threads[request.threadId];
  assert.equal(thread.title, 'Preserving drafts');
  assert.equal(thread.messages.length, 3);
});
