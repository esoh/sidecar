import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFileQuote, isQuote } from '../src/quote.ts';
import { createState, createThread, registerDocument, submit, claim, reply, resolveThread, setTitle, setBaseBranch, openStore, readSavedState } from '../src/store.ts';

for (const order of ['combined', 'older-first'] as const) test(`mid-turn receipts preserve immutable batches: ${order}`, () => {
  const { state, input } = setup(), a = submit(state, input);
  claim(state, a.id, {}); a.acceptedAt = 1;
  const b = submit(state, { ...input, threadId: a.threadId, text: 'Actually use cobalt', clientMessageId: 'b' });
  claim(state, b.id, {}); b.acceptedAt = 2;
  const x = submit(state, { ...input, text: 'Other thread', clientMessageId: 'x' });
  claim(state, x.id, {}); x.acceptedAt = 3;
  const c = submit(state, { ...input, threadId: a.threadId, text: 'Not delivered yet', clientMessageId: 'c' });
  assert.deepEqual(b.covers, [a.id]);
  assert.equal(a.batchId, a.id); assert.equal(b.batchId, b.id);
  assert.deepEqual(x.covers, []);
  const answer = (id: string, text: string) => reply(state, { requestId: id, documentId: a.documentId, threadId: a.threadId, text });
  if (order === 'older-first') {
    answer(a.id, 'Earlier answer');
    assert.equal(b.status, 'claimed');
  }
  answer(b.id, 'Cobalt');
  assert.equal(a.status, 'completed'); assert.equal(b.status, 'completed');
  assert.equal(x.status, 'claimed'); assert.equal(c.status, 'queued');
  if (order === 'combined') {
    assert.equal(a.answeredBy, b.id);
    answer(a.id, 'Late older final');
    assert.deepEqual(state.threads[a.threadId].messages.filter(m => m.role === 'agent').map(m => m.text), ['Cobalt']);
  } else {
    assert.equal(a.answer?.text, 'Earlier answer');
    assert.throws(() => answer(a.id, 'Different answer'), /different reply/i);
  }
  assert.deepEqual(readSavedState(state), state);
  for (const coverage of [[x.id], [b.id], [c.id]]) {
    const invalid = structuredClone(state); invalid.requests[b.id].covers = coverage;
    assert.throws(() => readSavedState(invalid), /Malformed/);
  }
});

const owner = { agent: 'codex' as const, sessionId: '11111111-1111-4111-8111-111111111111' };

test('unsupported state versions are rejected without overwriting saved input', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-unsupported-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const version of [1, 2, 3, 4, 7, 99]) {
    const raw = JSON.stringify({ ...createState(owner), version });
    await writeFile(join(directory, 'state.json'), raw);
    await assert.rejects(openStore(directory, owner), /Unsupported Sidecar state version/);
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), raw);
  }
});
function setup() {
  const state = createState(owner);
  const doc = registerDocument(state, { path: '/tmp/a.md', title: 'A', generated: false });
  const other = registerDocument(state, { path: '/tmp/b.md', title: 'B', generated: false });
  const input = { documentId: doc.id, text: 'What does this mean?', clientMessageId: 'first' };
  return { state, doc, other, input };
}

test('retrying a question creates one request and rejects conflicting reuse', () => {
  const { state, input } = setup();
  const first = submit(state, input);
  assert.equal(submit(state, input).id, first.id);
  assert.equal(Object.keys(state.requests).length, 1);
  assert.equal(state.threads[first.threadId]?.messages.length, 1);
  assert.throws(() => submit(state, { ...input, text: 'Different question' }));
});

test('message quotes retain their source, replace document selections, and deduplicate independently', () => {
  const { state, input, other } = setup();
  const original = submit(state, input);
  claim(state, original.id, {});
  reply(state, { requestId: original.id, documentId: original.documentId, threadId: original.threadId, text: 'An **important** detail.' });
  const messageQuote = { threadId: original.threadId, messageId: state.threads[original.threadId]!.messages.at(-1)!.id, exact: 'important detail' };
  const next = { ...input, text: 'Explain this', clientMessageId: 'quoted', messageQuote };
  const request = submit(state, next);
  assert.deepEqual(request.messageQuote, messageQuote);
  assert.equal(request.quote, undefined);
  assert.deepEqual(state.threads[request.threadId]!.messages[0]!.messageQuote, messageQuote);
  assert.equal(state.threads[request.threadId]!.messages[0]!.selections, undefined);
  assert.equal(submit(state, next).id, request.id);
  assert.throws(() => submit(state, { ...next, messageQuote: { ...messageQuote, exact: 'Different' } }), /different content/);
  assert.throws(() => submit(state, { ...next, clientMessageId: 'wrong-doc', documentId: other.id }), /another document/);
  assert.throws(() => submit(state, { ...next, clientMessageId: 'missing', messageQuote: { ...messageQuote, messageId: 'missing' } }), /Message not found/);
  assert.throws(() => submit(state, { ...next, clientMessageId: 'both', quote: { exact: 'doc', prefix: '', suffix: '', start: 0, end: 3, version: 'v' } }), /one selection/);
});

test('file quotes keep their source and literal text across saves and retries without becoming document highlights', () => {
  const { state, doc, input } = setup();
  doc.workspace = '/tmp/work';
  const fileQuote = { path: '/tmp/work/src/app.ts', kind: 'code' as const, exact: '  return true;\n', startLine: 4, endLine: 4 };
  const next = { ...input, fileQuote };
  const request = submit(state, next);
  assert.deepEqual(request.fileQuote, fileQuote);
  assert.equal(request.quote, undefined);
  assert.deepEqual(state.threads[request.threadId].messages[0].fileQuote, fileQuote);
  assert.equal(state.threads[request.threadId].messages[0].selections, undefined);
  assert.deepEqual(readSavedState(JSON.parse(JSON.stringify(state))), state);
  assert.equal(submit(state, next).id, request.id);
  assert.throws(() => submit(state, { ...next, fileQuote: { ...fileQuote, exact: 'return false;' } }), /different content/);
  assert.throws(() => submit(state, { ...next, clientMessageId: 'both', quote: { exact: 'doc', prefix: '', suffix: '', start: 0, end: 3, version: 'v' } }), /one selection/);
  assert.equal(submit(state, { ...next, clientMessageId: 'outside', fileQuote: { ...fileQuote, path: '/tmp/elsewhere.ts' } }).fileQuote?.path, '/tmp/elsewhere.ts');
});

test('new user messages reopen resolved threads, while invalid submissions and retries retain resolution', () => {
  for (const quote of [undefined, { exact: 'hello', prefix: '', suffix: ' world', start: 0, end: 5, version: 'v1' }]) {
    const { state, input } = setup();
    const firstInput = { ...input, quote };
    const first = submit(state, firstInput);
    resolveThread(state, first.threadId, true);
    submit(state, firstInput);
    assert.equal(state.threads[first.threadId]?.isResolved, true);
    const followInput = { ...input, threadId: first.threadId, text: 'One more question', clientMessageId: 'follow' };
    assert.throws(() => submit(state, { ...followInput, text: ' ' }));
    assert.equal(state.threads[first.threadId]?.isResolved, true);
    const follow = submit(state, followInput);
    assert.equal(follow.threadId, first.threadId);
    assert.equal(state.threads[first.threadId]?.isResolved, false);
    assert.equal(follow.quote, undefined);
    resolveThread(state, first.threadId, true);
    assert.equal(submit(state, followInput).id, follow.id);
    assert.equal(state.threads[first.threadId]?.isResolved, true);
    assert.equal(state.threads[first.threadId]?.messages.length, 2);
  }
});

test('a claim grants execution once independently in each thread', () => {
  const { state, input } = setup();
  const first = submit(state, input);
  const second = submit(state, { ...input, clientMessageId: 'second' });
  assert.equal(claim(state, first.id, {}).claimStatus, 'claimed');
  assert.equal(claim(state, first.id, {}).claimStatus, 'already-claimed');
  assert.equal(claim(state, second.id, {}).claimStatus, 'claimed');
  assert.deepEqual(second.covers, []);
});

test('replies validate routing, deduplicate, and retain user resolution', () => {
  const { state, input, other } = setup();
  const request = submit(state, input);
  claim(state, request.id, {});
  const answer = { requestId: request.id, documentId: request.documentId, threadId: request.threadId, text: 'Explanation' };
  assert.throws(() => reply(state, { ...answer, documentId: other.id }));
  resolveThread(state, request.threadId, true);
  reply(state, answer);
  reply(state, answer);
  assert.equal(state.threads[request.threadId]?.isResolved, true);
  assert.equal(state.threads[request.threadId]?.messages.filter(m => m.role === 'agent').length, 1);
  assert.equal(claim(state, request.id, {}).claimStatus, 'completed');
  assert.throws(() => reply(state, { ...answer, text: 'Conflicting answer' }));
  resolveThread(state, request.threadId, false);
  assert.equal(state.threads[request.threadId]?.isResolved, false);
});

test('follow-ups remain in their document and use only their own quote context', () => {
  const { state, input, other } = setup();
  const quote = { exact: 'hello', prefix: '', suffix: ' world', start: 0, end: 5, version: 'v1' };
  const first = submit(state, { ...input, quote });
  const follow = submit(state, { ...input, threadId: first.threadId, text: 'Why?', clientMessageId: 'follow' });
  assert.equal(follow.threadId, first.threadId);
  assert.equal(follow.quote, undefined);
  assert.throws(() => submit(state, { ...input, quote: { ...quote, sentence: 'hello world.' } as any, clientMessageId: 'has-sentence' }));
  assert.throws(() => submit(state, { ...input, documentId: other.id, threadId: first.threadId, clientMessageId: 'bad' }));
  assert.throws(() => submit(state, { ...input, documentId: '__proto__', clientMessageId: 'bad' }));
  assert.throws(() => submit(state, { ...input, text: ' ', clientMessageId: 'empty' }));
});

test('re-registering a file retains its ID and user title', () => {
  const { state, doc } = setup();
  setTitle(state, doc.id, 'My title');
  const again = registerDocument(state, { path: doc.path, title: 'New automatic title', generated: false });
  assert.equal(again.id, doc.id);
  assert.equal(again.userTitle, 'My title');
  setTitle(state, doc.id, '');
  assert.equal(again.userTitle, undefined);
});

test('disk reopen preserves pending work and requires reconciliation of interrupted claims', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory, owner);
  const { first, second } = await store.update(state => {
    const doc = registerDocument(state, { path: '/tmp/a.md', generated: true });
    const first = submit(state, { documentId: doc.id, text: 'Revise', clientMessageId: 'one' });
    const second = submit(state, { documentId: doc.id, text: 'Explain', clientMessageId: 'two' });
    claim(state, first.id, {});
    return { first, second };
  });
  const reopened = await openStore(directory, owner);
  assert.equal(reopened.read().requests[second.id]?.status, 'queued');
  assert.equal((await reopened.update(s => claim(s, first.id, {}))).claimStatus, 'uncertain');
  assert.equal((await reopened.update(s => claim(s, first.id, { resume: true }))).claimStatus, 'claimed');
  await assert.rejects(openStore(directory, { ...owner, agent: 'claude' }));
});

test('serialized writes and detached snapshots prevent lost or external updates', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory, owner);
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.update(s => registerDocument(s, { path: `/tmp/${index}.md`, generated: false }))));
  const snapshot = store.read();
  snapshot.documents = {};
  assert.equal(Object.keys(store.read().documents).length, 8);
  assert.equal(Object.keys((await openStore(directory, owner)).read().documents).length, 8);
});

test('a failed disk write preserves the last snapshot and does not poison later writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-store-'));
  const moved = directory + '-moved';
  t.after(async () => { await rm(directory, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true }); });
  const store = await openStore(directory, owner);
  const before = await readFile(join(directory, 'state.json'), 'utf8');
  await rename(directory, moved);
  await assert.rejects(store.update(s => registerDocument(s, { path: '/tmp/lost.md', generated: false })));
  assert.equal(Object.keys(store.read().documents).length, 0);
  await rename(moved, directory);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), before);
  await store.update(s => registerDocument(s, { path: '/tmp/kept.md', generated: false }));
  assert.equal(Object.keys(store.read().documents).length, 1);
});

test('malformed persisted data is reported without being overwritten', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bad = JSON.stringify({ ...createState(owner), requests: { broken: { status: 'claimed' } } });
  await writeFile(join(directory, 'state.json'), bad);
  await assert.rejects(openStore(directory, owner));
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), bad);
});


test('missing optional thread metadata is filled without losing history or resolution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { state, input } = setup();
  const request = submit(state, input);
  resolveThread(state, request.threadId, true);
  const legacy = JSON.parse(JSON.stringify(state));
  for (const thread of Object.values<any>(legacy.threads)) { delete thread.createdAt; delete thread.title; }
  await writeFile(join(directory, 'state.json'), JSON.stringify(legacy));
  const restored = (await openStore(directory, owner)).read();
  assert.deepEqual(restored.threads[request.threadId]?.messages, state.threads[request.threadId]?.messages);
  assert.equal(restored.threads[request.threadId]?.isResolved, true);
  const persisted = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(persisted.threads[request.threadId].createdAt, request.createdAt);
});


test('one thread can hold selected and unselected inputs without inheriting an earlier quote', () => {
  const { state, input } = setup();
  const quote = { exact: 'hello', prefix: '', suffix: ' world', start: 0, end: 5, version: 'v1' };
  const first = submit(state, { ...input, quote });
  const unselected = submit(state, { ...input, threadId: first.threadId, clientMessageId: 'general' });
  const nextQuote = { exact: 'world', prefix: 'hello ', suffix: '', start: 6, end: 11, version: 'v2' };
  const selectedInput = { ...input, threadId: first.threadId, quote: nextQuote, clientMessageId: 'selected' };
  const selected = submit(state, selectedInput);
  assert.equal(submit(state, selectedInput).id, selected.id);
  assert.deepEqual(state.threads[first.threadId].messages.map(m => m.selections?.[0].quote.exact), ['hello', undefined, 'world']);
  assert.equal(unselected.quote, undefined);
  assert.deepEqual(selected.quote, nextQuote);
  assert.equal('quote' in state.threads[first.threadId], false);
  assert.equal('scope' in state.threads[first.threadId], false);
  nextQuote.exact = 'other';
  assert.equal(state.threads[first.threadId].messages[2].selections?.[0].quote.exact, 'world');
});

test('base branch round-trips, is kept when omitted, can be cleared, and rejects option-like names', () => {
  const state = createState({ agent: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' });
  const input = { path: '/tmp/a.md', generated: false };
  const doc = registerDocument(state, { ...input, baseBranch: 'release/1.x' });
  assert.equal(registerDocument(state, input).baseBranch, 'release/1.x');
  assert.equal(readSavedState(JSON.parse(JSON.stringify(state))).documents[doc.id]!.baseBranch, 'release/1.x');
  for (const bad of ['-x', '--upload-pack=x', 'a..b', 'a b', 'a/', '/a', 'a.lock', '']) {
    assert.throws(() => registerDocument(state, { ...input, baseBranch: bad }), /Invalid base branch/, bad);
    assert.throws(() => setBaseBranch(state, doc.id, bad), /Invalid base branch/, bad);
  }
  setBaseBranch(state, doc.id, null);
  assert.equal(state.documents[doc.id]!.baseBranch, undefined);
  assert.throws(() => readSavedState({ ...JSON.parse(JSON.stringify(state)), documents: { [doc.id]: { ...doc, baseBranch: '-x' } } }));
});

test('threads may be bound to an absolute file and html file quotes need a selector', () => {
  const { state, doc, input } = setup(), id = '11111111-1111-4111-8111-111111111112';
  doc.workspace = '/tmp/work';
  const thread = createThread(state, { id, documentId: doc.id, file: '/tmp/work/a.html' });
  assert.equal(thread.file, '/tmp/work/a.html');
  assert.equal(createThread(state, { id, documentId: doc.id, file: '/tmp/work/a.html' }), thread);
  for (const file of [undefined, '/tmp/work/b.html']) assert.throws(() => createThread(state, { id, documentId: doc.id, file }), /already used/);
  assert.equal(createThread(state, { documentId: doc.id }).file, undefined);
  assert.deepEqual(readSavedState(JSON.parse(JSON.stringify(state))), state);
  for (const file of ['relative.html', '/tmp/a\nb.html', '/' + 'x'.repeat(4096), 7]) {
    const invalid = structuredClone(state); (invalid.threads[id] as any).file = file;
    assert.throws(() => readSavedState(invalid), /Malformed/);
  }
  const html = { path: '/tmp/work/a.html', kind: 'html' as const, exact: '<b>x</b>', selector: 'body > b', isElement: true as const, fingerprint: '8:0123abcd' };
  assert.ok(isFileQuote(html) && isFileQuote({ ...html, isElement: undefined, fingerprint: undefined }));
  for (const bad of [{ ...html, selector: undefined }, { ...html, selector: '' }, { ...html, selector: 'a\nb' }, { ...html, selector: 'x'.repeat(1025) }, { ...html, startLine: 1, endLine: 1 }, { ...html, isElement: false },
    { ...html, fingerprint: undefined }, { ...html, fingerprint: 'abc' }, { ...html, isElement: undefined }, { ...html, kind: 'doc' }, { ...html, kind: 'code', isElement: undefined, fingerprint: undefined }]) assert.equal(isFileQuote(bad), false);
  assert.equal(submit(state, { ...input, fileQuote: html, clientMessageId: 'html' }).fileQuote?.selector, 'body > b');
  assert.deepEqual(readSavedState(JSON.parse(JSON.stringify(state))), state);
});

test('version 5 state migrates to source anchors and keeps non-Markdown references', () => {
  const { state } = (() => { const state = createState(owner); return { state }; })();
  const md = registerDocument(state, { path: '/tmp/a.md', generated: false, workspace: '/tmp' }), html = registerDocument(state, { path: '/tmp/p.html', generated: false });
  const base = { clientMessageId: 'c' };
  const quote = { exact: 'hello', prefix: '', suffix: ' world', start: 0, end: 5, version: 'v1' };
  const first = submit(state, { documentId: md.id, text: 'Q', quote, clientMessageId: 'q1' });
  const thread = state.threads[first.threadId];
  const html1 = { path: '/tmp/p.html', kind: 'html', exact: 'x', selector: 'body' }, code = { path: '/tmp/c.ts', kind: 'code', exact: 'y', startLine: 1, endLine: 1 };
  const doc1 = { path: '/tmp/b.md', kind: 'doc', exact: 'z' }, own = { path: '/tmp/a.md', kind: 'doc', exact: 'w', startLine: 2, endLine: 2 };
  const withFile = (fileQuote: object, id: string) => submit(state, { documentId: md.id, threadId: thread.id, text: id, fileQuote: fileQuote as any, clientMessageId: id });
  const reqs = [withFile(html1, 'h'), withFile(code, 'c'), withFile(doc1, 'd'), withFile(own, 'o')];
  const msgQuote = submit(state, { documentId: md.id, threadId: thread.id, text: 'm', messageQuote: { threadId: thread.id, messageId: thread.messages[0].id, exact: 'Q' }, clientMessageId: 'm' });
  const answer = (requestId: string) => { claim(state, requestId, {}); reply(state, { requestId, documentId: md.id, threadId: thread.id, text: 'A', selectionVersion: 'v1', metadata: { highlights: [{ exact: 'hello' }] } as any }); };
  answer(first.id);
  const selection = thread.messages.filter(m => m.role === 'agent').flatMap(m => m.selections ?? [])[0];
  assert.ok(selection);
  const saved: any = structuredClone({ ...state, version: 5 });
  saved.requests[first.id].quote.sentence = 'hello world.';
  saved.proposals['00000000-0000-4000-8000-000000000001'] = { id: '00000000-0000-4000-8000-000000000001', documentId: md.id, threadId: thread.id, messageId: thread.messages.find(m => m.role === 'agent' && m.selections?.length)!.id, selectionId: selection.id, before: 'hello', after: 'bye', prefix: '', suffix: '', baseRange: { start: 0, end: 5 }, status: 'pending', baseVersion: 'v1', createdAt: 1 };
  const migrated = (() => { try { return readSavedState(saved); } catch (error) { return error as Error; } })();
  assert.ok(!(migrated instanceof Error), String(migrated));
  assert.equal(migrated.version, 6);
  assert.equal(migrated.requests[first.id].quote, undefined);
  assert.equal(migrated.requests[reqs[0].id].fileQuote?.kind, 'html');
  assert.equal(migrated.requests[reqs[1].id].fileQuote?.kind, 'code');
  assert.equal(migrated.requests[reqs[2].id].fileQuote, undefined);
  assert.equal(migrated.requests[reqs[3].id].fileQuote, undefined);
  assert.ok(migrated.requests[msgQuote.id].messageQuote);
  assert.equal(migrated.threads[thread.id].messages.length, thread.messages.length);
  assert.ok(!JSON.stringify(migrated).includes('sentence'));
  assert.equal(html.id.length > 0, true); void base;
  const kept = migrated.threads[thread.id].messages.flatMap(m => m.selections ?? []);
  assert.deepEqual(kept.map(s => [s.id, s.isVisible]), [[selection.id, false]]);
  assert.equal(Object.keys(migrated.proposals).length, 1);
  assert.equal(isQuote({ ...selection.quote, sentence: 'hello' }), false);
});
