import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, readFile, rename, unlink, symlink } from 'node:fs/promises';
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
  const editPath = `/api/threads/${request.threadId}/title`;
  assert.equal((await f.view(editPath, { title: 'User title' }, 'PATCH')).status, 200);
  assert.equal((await f.view(editPath, { title: 'Updated user title' }, 'PATCH')).status, 200);
  assert.equal((await f.agent(path, { title: 'Agent overwrite' })).status, 409);
  assert.equal((await f.view(editPath, { title: ' ' }, 'PATCH')).status, 400);
  await f.reopen();
  const thread = (await (await f.view('/api/state')).json()).threads[request.threadId];
  assert.equal(thread.title, 'Updated user title');
  assert.equal(thread.messages.length, 3);
});

test('renderer fonts and images require viewer access and stay within the document directory', async t => {
  const f = await fixture(t), outside = await fixture(t);
  const doc = await f.register();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>';
  await writeFile(join(f.directory, 'local.svg'), svg);
  await writeFile(join(f.directory, 'with space.svg'), svg);
  await writeFile(join(outside.directory, 'outside.svg'), svg);
  await symlink(join(outside.directory, 'outside.svg'), join(f.directory, 'escape.svg'));
  const image = (path: string) => `/api/image?document=${doc.id}&path=${encodeURIComponent(path)}`;
  assert.equal((await fetch(f.url + image('local.svg'))).status, 403);
  const local = await f.view(image('local.svg'));
  assert.equal(local.status, 200);
  assert.equal((await f.view(image('with%20space.svg'))).status, 200);
  assert.equal((await f.view(image('local.svg?revision=2#view'))).status, 200);
  assert.equal((await f.view(image('https://example.com/image.png'))).status, 400);
  assert.equal((await f.view(image('../' + outside.directory.split('/').at(-1) + '/outside.svg'))).status, 403);
  assert.equal(await local.text(), svg);
  assert.equal(local.headers.get('content-type'), 'image/svg+xml');
  assert.match(local.headers.get('content-security-policy') ?? '', /sandbox; default-src 'none'/);
  assert.equal((await f.view(image('escape.svg'))).status, 403);
  assert.equal((await f.view(image(join(outside.directory, 'outside.svg')))).status, 403);
  assert.equal((await f.view(image('agent-token'))).status, 415);
  assert.equal((await f.view('/api/image?document=missing&path=local.svg')).status, 404);
  assert.equal((await fetch(f.url + '/renderer.css')).status, 403);
  const css = await (await f.view('/renderer.css')).text();
  assert.match(css, /Inter Variable/); assert.match(css, /Geist Mono Variable/);
  for (const path of ['/renderer-fonts/inter/inter-latin-wght-normal.woff2', '/renderer-fonts/geist/geist-mono-latin-wght-normal.woff2', '/renderer-fonts/katex/KaTeX_Main-Regular.woff2']) {
    assert.ok(css.includes(path));
    assert.equal((await fetch(f.url + path)).status, 403);
    const font = await f.view(path);
    assert.equal(font.status, 200); assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.ok((await font.arrayBuffer()).byteLength > 100);
  }
  assert.equal((await f.view('/renderer-fonts/inter/%2e%2e%2fagent-token')).status, 404);
  const csp = (await f.view('/api/state')).headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
});

test('discarding an empty thread is idempotent and cannot remove a submitted message', async t => {
  const f = await fixture(t);
  const doc = await f.register();
  const initial = await (await f.view('/api/state')).json();
  const id = Object.keys(initial.threads)[0];
  const discard = () => f.view(`/api/threads/${id}`, undefined, 'DELETE');
  assert.deepEqual(await (await discard()).json(), { isDeleted: true });
  assert.deepEqual(await (await discard()).json(), { isDeleted: false });
  await f.reopen();
  assert.equal((await (await f.view('/api/state')).json()).threads[id], undefined);
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Keep this question', clientMessageId: 'keep' })).json();
  assert.deepEqual(await (await f.view(`/api/threads/${request.threadId}`, undefined, 'DELETE')).json(), { isDeleted: false });
  const saved = await (await f.view('/api/state')).json();
  assert.equal(saved.threads[request.threadId].messages[0].text, 'Keep this question');
  assert.equal(saved.requests[request.id].status, 'queued');
});

test('viewed document versions survive replacement and restart without exposing other paths', async t => {
  const f = await fixture(t);
  const doc = await f.register('history.md', '# Original\n\nOriginal passage.');
  const before = await (await f.view(`/api/documents/${doc.id}`)).json();
  const originalPath = `/api/documents/${doc.id}/versions/${before.version}`;
  await writeFile(join(f.directory, 'history.md'), '# Revised\n\nReplacement passage.');
  const current = await (await f.view(`/api/documents/${doc.id}`)).json();
  assert.notEqual(current.version, before.version);
  assert.equal((await (await f.view(originalPath)).json()).markdown, before.markdown);
  assert.equal((await f.view(originalPath, undefined, 'HEAD')).status, 200);
  assert.equal((await fetch(f.url + originalPath, { method: 'HEAD' })).status, 403);
  await f.reopen();
  assert.equal((await (await f.view(originalPath)).json()).markdown, before.markdown);
  await unlink(join(f.directory, 'history.md'));
  assert.equal((await (await f.view(originalPath)).json()).markdown, before.markdown);
  assert.equal((await fetch(f.url + originalPath)).status, 403);
  assert.equal((await f.view(`/api/documents/${doc.id}/versions/${'0'.repeat(64)}`, undefined, 'HEAD')).status, 404);
  assert.match((await (await f.view(`/api/documents/${doc.id}/versions/${'0'.repeat(64)}`)).json()).error, /not saved/);
  assert.equal((await f.view(`/api/documents/${doc.id}/versions/agent-token`)).status, 404);
  const other = await f.register('other.md', before.markdown);
  assert.equal((await f.view(`/api/documents/${other.id}/versions/${before.version}`)).status, 404);
});


test('closing a document deletes its conversations and snapshots while keeping files and other documents', async t => {
  const f = await fixture(t), doc = await f.register(), other = await f.register('other.md');
  const before = await (await f.view(`/api/documents/${doc.id}`)).json();
  const otherVersion = await (await f.view(`/api/documents/${other.id}`)).json();
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Explain', clientMessageId: 'close' })).json();
  const queued = await (await f.view('/api/questions', { documentId: other.id, text: 'Keep working', clientMessageId: 'keep' })).json();
  const close = () => f.view(`/api/documents/${doc.id}`, undefined, 'DELETE');
  assert.equal((await close()).status, 409);
  await f.agent(`/agent/requests/${request.id}/claim`, {});
  assert.equal((await close()).status, 409);
  await f.reopen();
  assert.equal((await close()).status, 409);
  await f.agent(`/agent/requests/${request.id}/claim`, { resume: true });
  const reply = { requestId: request.id, documentId: doc.id, threadId: request.threadId, text: 'Done' };
  await f.agent('/agent/replies', reply);
  const reads = Array.from({ length: 8 }, () => f.view(`/api/documents/${doc.id}`));
  const response = await close();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.documentId, doc.id);
  assert.ok(result.threadIds.includes(request.threadId));
  assert.equal(result.nextDocumentId, other.id);
  assert.equal(result.cleanupError, undefined);
  await Promise.all(reads);
  await assert.rejects(readFile(join(f.directory, 'versions', doc.id, `${before.version}.md`)), { code: 'ENOENT' });
  assert.equal(await readFile(doc.path, 'utf8'), before.markdown);
  assert.equal((await f.agent('/agent/replies', reply)).status, 404);
  assert.equal((await f.view(`/api/documents/${other.id}/versions/${otherVersion.version}`)).status, 200);
  await f.reopen();
  const state = await (await f.view('/api/state')).json();
  assert.equal(state.documents[doc.id], undefined);
  assert.ok(state.documents[other.id]);
  assert.equal(state.requests[request.id], undefined);
  assert.equal(state.requests[queued.id].status, 'queued');
  assert.ok(Object.values<any>(state.threads).every(thread => thread.documentId === other.id));
  assert.equal((await f.view('/api/documents/__proto__', undefined, 'DELETE')).status, 404);
  assert.equal((await fetch(`${f.url}/api/documents/${other.id}`, { method: 'DELETE', headers: { Cookie: f.cookie, Origin: 'https://elsewhere.example' } })).status, 403);
});

test('closing the last document leaves its server available for browsing with no saved conversations', async t => {
  const f = await fixture(t), doc = await f.register();
  const response = await f.view(`/api/documents/${doc.id}`, undefined, 'DELETE');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).nextDocumentId, null);
  assert.equal((await f.view('/api/state')).status, 200);
  await f.reopen();
  const state = await (await f.view('/api/state')).json();
  assert.deepEqual(state.documents, {});
  assert.deepEqual(state.threads, {});
  assert.deepEqual(state.requests, {});
  assert.match(await readFile(doc.path, 'utf8'), /Hello/);
});
