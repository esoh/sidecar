import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './support.ts';
import { htmlBridge, shortcutHelper } from '../src/html-bridge.ts';
import { withBridge } from '../src/server.ts';

// The injected tag carries the response's CSP nonce; it always holds the shortcut helper.
const nonceOf = (response: Response) => /script-src 'nonce-([^']+)'/.exec(response.headers.get('content-security-policy')!)?.[1];
const helpers = (nonce: string, isBridge: boolean) => `<script nonce="${nonce}" data-sidecar-bridge>${shortcutHelper}${isBridge ? htmlBridge : ''}</script>`;
// Run scripts: the viewer mints a one-use ticket, then the frame's GET spends it.
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function scripted(f: Fixture, route: string, extra = '') {
  const { ticket } = await (await f.view(route, {})).json();
  return f.view(`${route}&scripts=1&ticket=${ticket}${extra}`);
}
const injectedNonce = (body: string) => /^(?:[\s\S]*?)<script nonce="([^"]+)" data-sidecar-bridge>/.exec(body)![1];

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
  // Run scripts off: only the nonced shortcut helper may run; the author's script is served but blocked.
  const nonce = nonceOf(staticFrame)!;
  assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/);
  assert.doesNotMatch(staticFrame.headers.get('content-security-policy')!, /script-src[^;]*unsafe|allow-same-origin/);
  assert.equal(await staticFrame.text(), `${helpers(nonce, false)}<p>Diagram</p><script>document.body.dataset.ran="yes"</script>`);
  assert.notEqual(nonceOf(await f.view(route)), nonce);
  const scriptedFrame = await scripted(f, route);
  assert.equal(scriptedFrame.status, 200);
  assert.match(scriptedFrame.headers.get('content-type')!, /text\/html/);
  assert.match(scriptedFrame.headers.get('content-security-policy')!, /sandbox allow-scripts;/);
  assert.doesNotMatch(scriptedFrame.headers.get('content-security-policy')!, /allow-same-origin/);
  assert.equal(nonceOf(scriptedFrame), undefined);
  assert.match(await scriptedFrame.text(), /<script>/);
  assert.equal((await f.view(`/api/files/html?document=${doc.id}&path=a.md&scripts=1`)).status, 415);
  assert.equal((await f.view(`/api/files/html?document=${doc.id}&path=a.md`, undefined, 'HEAD')).status, 415);
  assert.equal((await f.view(`/api/files/html?document=${doc.id}&path=../outside.html`, undefined, 'HEAD')).status, 403);
  assert.equal((await f.view('/api/files/html?document=missing&path=diagram.html', undefined, 'HEAD')).status, 404);
  assert.equal((await f.view(`/api/files/html?document=${doc.id}&path=../outside.html&scripts=1`)).status, 403);
  assert.equal((await f.view('/api/files/html?document=missing&path=diagram.html&scripts=1')).status, 404);
});

test('Run scripts tickets are minted only by the viewer POST, spent once, and bound to their document and file', async t => {
  const f = await fixture(t), doc = await f.register();
  await f.agent('/agent/documents', { path: doc.path, workspace: f.directory });
  await writeFile(join(f.directory, 'diagram.html'), '<p>Diagram</p>');
  await writeFile(join(f.directory, 'destination.html'), '<p>Destination</p>');
  const route = (file: string) => `/api/files/html?document=${doc.id}&path=${file}`;
  const isScripted = (response: Response) => /script-src 'unsafe-inline'/.test(response.headers.get('content-security-policy') ?? '');
  // No ticket, a GET or HEAD (what a frame navigation can make), or a POST without the viewer's Origin: never scripts.
  assert.equal((await f.view(route('diagram.html') + '&scripts=1')).status, 403);
  assert.equal(isScripted(await f.view(route('diagram.html') + '&scripts=1', undefined, 'HEAD')), false);
  assert.equal((await (await f.view(route('diagram.html'))).text()).includes('ticket'), false);
  const foreign = await fetch(f.url + route('diagram.html'), { method: 'POST', headers: { Cookie: f.cookie, Origin: 'null', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(foreign.status, 403);
  assert.match((await foreign.json()).error, /origin/i);
  // A ticket works once, for its own file only.
  const { ticket } = await (await f.view(route('diagram.html'), {})).json();
  assert.match(ticket, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await f.view(`${route('destination.html')}&scripts=1&ticket=${ticket}`)).status, 403);
  assert.equal((await f.view(`${route('diagram.html')}&scripts=1&ticket=${ticket}`)).status, 403, 'a ticket tried on another file is spent');
  const fresh = (await (await f.view(route('diagram.html'), {})).json()).ticket;
  const first = await f.view(`${route('diagram.html')}&scripts=1&ticket=${fresh}`);
  assert.equal(first.status, 200);
  assert.equal(isScripted(first), true);
  assert.equal((await f.view(`${route('diagram.html')}&scripts=1&ticket=${fresh}`)).status, 403, 'replay');
  // An unspent ticket expires after a minute.
  const late = (await (await f.view(route('diagram.html'), {})).json()).ticket;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_001 });
  try { assert.equal((await f.view(`${route('diagram.html')}&scripts=1&ticket=${late}`)).status, 403, 'expired'); }
  finally { t.mock.timers.reset(); }
  // Another document's ticket does not open this one's file.
  const other = await f.register('other.md', '# Other');
  await f.agent('/agent/documents', { path: other.path, workspace: f.directory });
  const elsewhere = (await (await f.view(`/api/files/html?document=${other.id}&path=diagram.html`, {})).json()).ticket;
  assert.equal((await f.view(`${route('diagram.html')}&scripts=1&ticket=${elsewhere}`)).status, 403);
});

test('the HTML bridge is injected only into scripted bridge requests, before page scripts, with the same CSP', async t => {
  for (const code of [htmlBridge, shortcutHelper]) { assert.doesNotMatch(code, /<\/script/i); assert.doesNotThrow(() => new Function(code)); }
  const f = await fixture(t), doc = await f.register();
  await f.agent('/agent/documents', { path: doc.path, workspace: f.directory });
  await writeFile(join(f.directory, 'diagram.html'), '<p>Diagram</p>');
  const route = `/api/files/html?document=${doc.id}&path=diagram.html`;
  const policies = new Set<string>();
  for (const [query, bridged] of [['', false], ['&bridge=1', false], ['&scripts=1', false], ['&scripts=1&bridge=1', true]] as const) {
    const response = query.startsWith('&scripts=1') ? await scripted(f, route, query.slice('&scripts=1'.length)) : await f.view(route + query), body = await response.text();
    assert.equal(body.includes(htmlBridge), bridged, query);
    assert.equal(body, `${helpers(injectedNonce(body), bridged)}<p>Diagram</p>`, query);
    policies.add(response.headers.get('content-security-policy')!.replace(/script-src [^;]+;/, '').replace(' allow-scripts', ''));
  }
  assert.equal(policies.size, 1);
  assert.doesNotMatch((await scripted(f, route, '&bridge=1')).headers.get('content-security-policy')!, /allow-same-origin/);
  // After the doctype (standards mode kept) and before any page script.
  await writeFile(join(f.directory, 'diagram.html'), '<!DOCTYPE html><html><head><script>1</script></head></html>');
  let body = await (await scripted(f, route, '&bridge=1')).text();
  assert.equal(body, `<!DOCTYPE html>${helpers(injectedNonce(body), true)}<html><head><script>1</script></head></html>`);
  // A doctype-less file with many comments must not stall the owner server.
  const comments = '<!-- note -->\n'.repeat(50_000) + '<html><body>diagram</body></html>', started = performance.now();
  assert.equal(withBridge(comments, 'n', true), `${helpers('n', true)}${comments}`);
  assert.equal(withBridge(comments.replace('<html>', '<!doctype html><html>'), 'n', false).indexOf('<script nonce="n" data-sidecar-bridge>'), comments.indexOf('<html>') + '<!doctype html>'.length);
  assert.ok(performance.now() - started < 1000, 'prolog scan must stay linear');
  // Comments may precede the doctype; injecting before them would force quirks mode.
  await writeFile(join(f.directory, 'diagram.html'), '<!-- Generated -->\n<!doctype html><p>x</p>');
  body = await (await scripted(f, route, '&bridge=1')).text();
  assert.equal(body, `<!-- Generated -->\n<!doctype html>${helpers(injectedNonce(body), true)}<p>x</p>`);
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
  // A floating comment on an HTML page starts a new thread bound to that page; a file never re-routes an existing thread.
  const started = await (await f.view('/api/questions', { documentId: doc.id, file, text: 'New page thread', fileQuote, clientMessageId: 'new' })).json();
  assert.notEqual(started.threadId, id(1));
  assert.equal((await (await f.view('/api/state')).json()).threads[started.threadId].file, file);
  assert.equal((await f.view('/api/questions', { documentId: doc.id, threadId: id(1), file, text: 'Both', clientMessageId: 'both' })).status, 400);
  assert.equal((await f.view('/api/questions', { documentId: doc.id, file: 'relative.html', text: 'Relative', clientMessageId: 'relative' })).status, 400);
});

test('a registered HTML file is its own document: titled from <title>, served without a workspace, file-bound threads', async t => {
  const f = await fixture(t);
  const doc = await f.register('page.html', '<!doctype html><title>Q&amp;A\n  Page &#x1F600;</title><p>Body</p><script>1</script>');
  const directory = doc.path.slice(0, doc.path.lastIndexOf('/'));
  assert.equal(doc.workspace, undefined);
  assert.equal(doc.title, 'Q&A Page 😀');
  await writeFile(join(directory, 'other.html'), '<p>Sibling</p>');
  const own = `/api/files/html?document=${doc.id}&directory=${encodeURIComponent(directory)}&path=page.html`;
  assert.equal((await fetch(f.url + own)).status, 403);
  const frame = await f.view(own);
  assert.equal(frame.status, 200);
  assert.match(frame.headers.get('content-security-policy')!, /script-src 'nonce-[^']+';.*sandbox allow-scripts;/);
  assert.equal(await frame.text(), `<!doctype html>${helpers(nonceOf(frame)!, false)}<title>Q&amp;A\n  Page &#x1F600;</title><p>Body</p><script>1</script>`);
  const scriptedFrame = await scripted(f, own, '&bridge=1');
  assert.match(scriptedFrame.headers.get('content-security-policy')!, /script-src 'unsafe-inline'.*sandbox allow-scripts;/);
  assert.match(await scriptedFrame.text(), /data-sidecar-bridge/);
  // Only the registered file itself: siblings and other directories still need a workspace or grant.
  for (const route of [`/api/files/html?document=${doc.id}&directory=${encodeURIComponent(directory)}&path=other.html`, `/api/files/html?document=${doc.id}&path=page.html`,
    `/api/files/content?document=${doc.id}&directory=${encodeURIComponent(directory)}&path=page.html`, `/api/files?document=${doc.id}&dir=${encodeURIComponent(directory)}`])
    assert.equal((await f.view(route)).status, 404, route);
  const content = await (await f.view(`/api/documents/${doc.id}`)).json();
  assert.equal(content.html, '');
  assert.match(content.markdown, /<p>Body<\/p>/);
  // The viewer leaves standalone threads unbound: the registered document is the file.
  const thread = await (await f.view('/api/threads', { id: '00000000-0000-4000-8000-000000000009', documentId: doc.id })).json();
  const fileQuote = { path: doc.path, kind: 'html', exact: 'Body', selector: 'body > p' };
  assert.equal((await f.view('/api/questions', { documentId: doc.id, threadId: thread.id, text: 'Other?', fileQuote: { ...fileQuote, path: join(directory, 'other.html') }, clientMessageId: 'o' })).status, 400);
  const sent = await (await f.view('/api/questions', { documentId: doc.id, threadId: thread.id, text: 'What is this?', fileQuote, clientMessageId: 'q' })).json();
  const prepared = await (await f.agent(`/agent/requests/${sent.id}/prepare`, {})).json();
  assert.equal(prepared.thread.file, undefined);
  assert.deepEqual(prepared.fileQuote, fileQuote);
  await writeFile(doc.path, '<p>Revised</p>');
  for (let i = 0; i < 100 && (await (await f.view('/api/state')).json()).documents[doc.id].title !== 'page.html'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const state = await (await f.view('/api/state')).json();
  assert.equal(state.documents[doc.id].title, 'page.html');
  assert.notEqual(state.documents[doc.id].version, content.version);
});

test('a standalone HTML document with a workspace keeps ordinary file authorization for other files', async t => {
  const f = await fixture(t), doc = await f.register('page.html', '<p>Page</p>');
  const directory = doc.path.slice(0, doc.path.lastIndexOf('/'));
  await f.agent('/agent/documents', { path: doc.path, workspace: directory });
  await writeFile(join(directory, 'other.html'), '<p>Sibling</p>');
  assert.equal((await f.view(`/api/files/html?document=${doc.id}&path=other.html`)).status, 200);
  assert.equal((await f.view(`/api/files/html?document=${doc.id}&directory=/&path=etc/hosts`)).status, 403);
});

test('agent HTML targets parse beside Markdown highlights without shifting selection links', async () => {
  const { parseReply } = await import('../src/reply-metadata.ts');
  const meta = (highlights: unknown[]) => parseReply(`[[sc-meta ${JSON.stringify({ highlights })}]]\nSee [it](#selection-2).`).metadata.highlights;
  assert.deepEqual(meta([{ exact: 'Heading' }, { selector: '#go', exact: 'Go', element: true, label: 'Go button' }, { selector: 'p', exact: 'Body' }]),
    [{ exact: 'Heading' }, { exact: 'Go', label: 'Go button', selector: '#go', element: true }, { exact: 'Body', selector: 'p' }]);
  // Mixed or malformed HTML targets reject the whole optional array rather than renumbering links.
  for (const bad of [{ selector: '#go', exact: 'Go', prefix: 'x' }, { selector: '#go', exact: 'Go', proposal: { before: 'a', after: 'b' } }, { selector: '#go', exact: 'Go', element: 'yes' },
    { selector: '', exact: 'Go' }, { selector: '#go', exact: ' ' }, { exact: 'Go', element: true }])
    assert.equal(meta([{ exact: 'Heading' }, bad]), undefined, JSON.stringify(bad));
});

async function answer(f: Awaited<ReturnType<typeof fixture>>, documentId: string, threadId: string | undefined, highlights: unknown[]) {
  const sent = await (await f.view('/api/questions', { documentId, ...(threadId ? { threadId } : {}), text: 'Where is it?', clientMessageId: `q-${Math.random()}` })).json();
  await f.agent(`/agent/requests/${sent.id}/prepare`, {});
  const replied = await f.agent('/agent/replies', { requestId: sent.id, documentId, threadId: sent.threadId, text: `[[sc-meta ${JSON.stringify({ highlights })}]]\nSee [it](#selection-1).` });
  assert.equal(replied.status, 200);
  const state = await (await f.view('/api/state')).json();
  return state.threads[sent.threadId].messages.at(-1);
}

test('agent HTML targets attach to the thread page: standalone document, file-bound thread, never a plain Markdown thread', async t => {
  const f = await fixture(t);
  const page = await f.register('page.html', '<p id="result">Body</p><button id="go">Go</button>');
  const standalone = await answer(f, page.id, undefined, [{ selector: '#result', exact: 'Body', label: 'Result' }, { selector: '#go', exact: 'Go', element: true }, { exact: 'Body', label: 'Text' }]);
  assert.equal(standalone.selections, undefined);
  // A standalone page has no Markdown text: a selector-less target matches its exact text anywhere on the page.
  assert.deepEqual(standalone.fileSelections.map(({ id, ...rest }: { id: string }) => rest), [
    { slug: 'selection-1', label: 'Result', fileQuote: { path: page.path, kind: 'html', exact: 'Body', selector: '#result' } },
    { slug: 'selection-2', fileQuote: { path: page.path, kind: 'html', exact: 'Go', selector: '#go', isElement: true } },
    { slug: 'selection-3', label: 'Text', fileQuote: { path: page.path, kind: 'html', exact: 'Body', selector: 'body' } }]);
  const doc = await f.register(), diagram = join(doc.path.slice(0, doc.path.lastIndexOf('/')), 'diagram.html');
  const bound = await (await f.view('/api/threads', { id: '00000000-0000-4000-8000-000000000007', documentId: doc.id, file: diagram })).json();
  const mixed = await answer(f, doc.id, bound.id, [{ exact: 'First heading' }, { selector: '#go', exact: 'Go' }]);
  assert.deepEqual(mixed.selections.map((s: { slug: string; quote: { exact: string } }) => [s.slug, s.quote.exact]), [['selection-1', 'First heading']]);
  assert.deepEqual(mixed.fileSelections.map((s: { slug: string; fileQuote: { path: string } }) => [s.slug, s.fileQuote.path]), [['selection-2', diagram]]);
  // A plain Markdown thread has no page: the HTML target is dropped and Markdown keeps its own slug.
  const plain = await answer(f, doc.id, undefined, [{ selector: '#go', exact: 'Go' }, { exact: 'First heading' }]);
  assert.equal(plain.fileSelections, undefined);
  assert.deepEqual(plain.selections.map((s: { slug: string; isVisible: boolean }) => [s.slug, s.isVisible]), [['selection-2', true]]);
  await f.reopen();
  const reloaded = await (await f.view('/api/state')).json();
  assert.equal(reloaded.threads[bound.id].messages.at(-1).fileSelections.length, 1);
});

test('agent HTML element targets omit fingerprints; user picks still require them', async () => {
  const { isFileQuote } = await import('../src/quote.ts');
  const target = { path: '/a/page.html', kind: 'html', exact: 'Go', selector: '#go', isElement: true };
  assert.equal(isFileQuote(target, true), true);
  assert.equal(isFileQuote(target), false);
  assert.equal(isFileQuote({ ...target, fingerprint: '2:0123abcd' }, true), false);
  assert.equal(isFileQuote({ ...target, fingerprint: '2:0123abcd' }), true);
});
