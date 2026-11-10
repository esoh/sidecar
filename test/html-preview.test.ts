import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './support.ts';
import { htmlBridge } from '../src/html-bridge.ts';
import { withBridge } from '../src/server.ts';

test('HTML frame endpoint requires viewer auth and an authorized HTML file', async t => {
  const f = await fixture(t);
  const doc = await f.register();
  await f.agent('/agent/documents', { path: doc.path, workspace: f.directory });
  await writeFile(join(f.directory, 'diagram.html'), '<p>Diagram</p><script>document.body.dataset.ran="yes"</script>');
  const route = `/api/files/html?document=${doc.id}&path=diagram.html`;
  assert.equal((await fetch(f.url + route)).status, 403);
  assert.equal((await fetch(f.url + route, { method: 'HEAD' })).status, 403);
  const checked = await f.view(route, undefined, 'HEAD');
  assert.equal(checked.status, 200);
  assert.match(checked.headers.get('content-type')!, /text\/html/);
  assert.equal(await checked.text(), '');
  const staticFrame = await f.view(route);
  assert.equal(staticFrame.status, 200);
  assert.match(staticFrame.headers.get('content-security-policy')!, /script-src 'none'/);
  const scripted = await f.view(route + '&scripts=1');
  assert.equal(scripted.status, 200);
  assert.match(scripted.headers.get('content-type')!, /text\/html/);
  assert.match(scripted.headers.get('content-security-policy')!, /sandbox allow-scripts;/);
  assert.doesNotMatch(scripted.headers.get('content-security-policy')!, /allow-same-origin/);
  assert.match(await scripted.text(), /<script>/);
  assert.equal((await f.view(`/api/files/html?document=${doc.id}&path=a.md&scripts=1`)).status, 415);
  assert.equal((await f.view(`/api/files/html?document=${doc.id}&path=a.md`, undefined, 'HEAD')).status, 415);
  assert.equal((await f.view(`/api/files/html?document=${doc.id}&path=../outside.html`, undefined, 'HEAD')).status, 403);
  assert.equal((await f.view('/api/files/html?document=missing&path=diagram.html', undefined, 'HEAD')).status, 404);
  assert.equal((await f.view(`/api/files/html?document=${doc.id}&path=../outside.html&scripts=1`)).status, 403);
  assert.equal((await f.view('/api/files/html?document=missing&path=diagram.html&scripts=1')).status, 404);
});

test('the HTML bridge is injected only into scripted bridge requests, before page scripts, with the same CSP', async t => {
  assert.doesNotMatch(htmlBridge, /<\/script/i);
  assert.doesNotThrow(() => new Function(htmlBridge));
  const f = await fixture(t), doc = await f.register();
  await f.agent('/agent/documents', { path: doc.path, workspace: f.directory });
  await writeFile(join(f.directory, 'diagram.html'), '<p>Diagram</p>');
  const route = `/api/files/html?document=${doc.id}&path=diagram.html`;
  const policies = new Set<string>();
  for (const [query, bridged] of [['', false], ['&bridge=1', false], ['&scripts=1', false], ['&scripts=1&bridge=1', true]] as const) {
    const response = await f.view(route + query), body = await response.text();
    assert.equal(body.includes(htmlBridge), bridged, query);
    if (!bridged) assert.equal(body, '<p>Diagram</p>');
    policies.add(response.headers.get('content-security-policy')!.replace(/script-src [^;]+;/, '').replace(' allow-scripts', ''));
  }
  assert.equal(policies.size, 1);
  assert.doesNotMatch((await f.view(route + '&scripts=1&bridge=1')).headers.get('content-security-policy')!, /allow-same-origin/);
  // After the doctype (standards mode kept) and before any page script.
  await writeFile(join(f.directory, 'diagram.html'), '<!DOCTYPE html><html><head><script>1</script></head></html>');
  assert.equal(await (await f.view(route + '&scripts=1&bridge=1')).text(), `<!DOCTYPE html><script data-sidecar-bridge>${htmlBridge}</script><html><head><script>1</script></head></html>`);
  // A doctype-less file with many comments must not stall the owner server.
  const comments = '<!-- note -->\n'.repeat(50_000) + '<html><body>diagram</body></html>', started = performance.now();
  assert.equal(withBridge(comments), `<script data-sidecar-bridge>${htmlBridge}</script>${comments}`);
  assert.equal(withBridge(comments.replace('<html>', '<!doctype html><html>')).indexOf('<script data-sidecar-bridge>'), comments.indexOf('<html>') + '<!doctype html>'.length);
  assert.ok(performance.now() - started < 1000, 'prolog scan must stay linear');
  // Comments may precede the doctype; injecting before them would force quirks mode.
  await writeFile(join(f.directory, 'diagram.html'), '<!-- Generated -->\n<!doctype html><p>x</p>');
  assert.equal(await (await f.view(route + '&scripts=1&bridge=1')).text(), `<!-- Generated -->\n<!doctype html><script data-sidecar-bridge>${htmlBridge}</script><p>x</p>`);
});

test('file-bound threads validate their file and deliver it with html file quotes', async t => {
  const f = await fixture(t), doc = await f.register(), file = join(f.directory, 'diagram.html');
  await f.agent('/agent/documents', { path: doc.path, workspace: f.directory });
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  for (const bad of ['relative.html', '/a\nb.html', 7]) assert.equal((await f.view('/api/threads', { id: id(1), documentId: doc.id, file: bad })).status, 400);
  const thread = await (await f.view('/api/threads', { id: id(1), documentId: doc.id, file })).json();
  assert.equal(thread.file, file);
  assert.equal((await f.view('/api/threads', { id: id(1), documentId: doc.id })).status, 409);
  const fileQuote = { path: file, kind: 'html', exact: '<button>Go</button>', selector: 'body > button', isElement: true, fingerprint: '19:0123abcd' };
  const sent = await (await f.view('/api/questions', { documentId: doc.id, threadId: id(1), text: 'What is this?', fileQuote, clientMessageId: 'q' })).json();
  const prepared = await (await f.agent(`/agent/requests/${sent.id}/prepare`, {})).json();
  assert.equal(prepared.thread.file, file);
  assert.deepEqual(prepared.fileQuote, fileQuote);
  assert.equal((await f.view('/api/questions', { documentId: doc.id, text: 'Bad', fileQuote: { ...fileQuote, selector: undefined }, clientMessageId: 'b' })).status, 400);
});
