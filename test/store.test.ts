import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, registerDocument, submit, claim, reply, resolveThread, setTitle, setBaseBranch, openStore, readSavedState } from '../src/store.ts';

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

test('v4 migration keeps exact backup and interrupted multi-thread deliveries recoverable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-v4-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { state, input } = setup(), a = submit(state, input);
  claim(state, a.id, {});
  const raw = JSON.stringify({ ...state, version: 4 }, null, 2) + '\n';
  await writeFile(join(directory, 'state.json'), raw);
  const migrated = (await openStore(directory, owner)).read();
  assert.equal(migrated.version, 5);
  assert.equal(await readFile(join(directory, 'state.v4.backup.json'), 'utf8'), raw);
  assert.equal(migrated.requests[a.id].status, 'uncertain');
  assert.deepEqual(migrated.threads, state.threads);
  assert.deepEqual(migrated.documents, state.documents);
});

const owner = { agent: 'codex' as const, sessionId: '11111111-1111-4111-8111-111111111111' };

test('v3 upgrade preserves history and snapshot bytes, including older migration backups', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-v3-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { state, input } = setup(), request = submit(state, input);
  claim(state, request.id, {});
  reply(state, { requestId: request.id, documentId: request.documentId, threadId: request.threadId, text: 'Existing answer' });
  const { proposals, proposalWrites, ...existing } = state;
  const v3 = { ...existing, version: 3 }, raw = JSON.stringify(v3, null, 2) + '\n';
  const older = JSON.stringify({ ...v3, requests: {}, threads: {} });
  await writeFile(join(directory, 'state.json'), raw);
  await writeFile(join(directory, 'state.v3.backup.json'), older);
  const snapshots = join(directory, 'versions', request.documentId); await mkdir(snapshots, { recursive: true });
  const bytes = Buffer.from('\uFEFF# Snapshot\r\noriginal\r\n'); await writeFile(join(snapshots, 'original.md'), bytes);
  const migrated = (await openStore(directory, owner)).read();
  assert.equal(migrated.version, 5);
  assert.deepEqual(migrated.documents, state.documents); assert.deepEqual(migrated.threads, state.threads); assert.deepEqual(migrated.requests, state.requests);
  assert.deepEqual(migrated.proposals, {}); assert.deepEqual(migrated.proposalWrites, {});
  assert.equal(await readFile(join(directory, 'state.v3.backup.json'), 'utf8'), older);
  assert.equal(await readFile(join(directory, `state.v3.${createHash('sha256').update(raw).digest('hex')}.backup.json`), 'utf8'), raw);
  assert.deepEqual(await readFile(join(snapshots, 'original.md')), bytes);
  assert.deepEqual((await openStore(directory, owner)).read(), migrated);
});

test('invalid v4 proposal state and unknown versions never overwrite the saved input', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-invalid-proposals-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const saved of [{ ...createState(owner), version: 99 }, { ...createState(owner), version: 4, proposals: { bad: {} } }]) {
    const raw = JSON.stringify(saved); await writeFile(join(directory, 'state.json'), raw);
    await assert.rejects(openStore(directory, owner));
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
  const quote = { exact: 'hello', prefix: '', suffix: ' world', start: 0, end: 5, version: 'v1', sentence: 'hello world.' };
  const first = submit(state, { ...input, quote });
  const follow = submit(state, { ...input, threadId: first.threadId, text: 'Why?', clientMessageId: 'follow' });
  assert.equal(follow.threadId, first.threadId);
  assert.equal(follow.quote, undefined);
  assert.throws(() => submit(state, { ...input, quote: { ...quote, sentence: 'unrelated' }, clientMessageId: 'invalid-sentence' }));
  assert.throws(() => submit(state, { ...input, quote: { ...quote, sentence: 'hello' + 'x'.repeat(512) }, clientMessageId: 'long-sentence' }));
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
  const bad = JSON.stringify({ version: 1, owner, documents: {}, threads: {}, requests: { broken: { status: 'claimed' } } });
  await writeFile(join(directory, 'state.json'), bad);
  await assert.rejects(openStore(directory, owner));
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), bad);
});


test('legacy thread metadata is upgraded without losing history or resolution', async t => {
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

function legacySelectionState() {
  const documentId = '22222222-2222-4222-8222-222222222222';
  const threadId = '33333333-3333-4333-8333-333333333333';
  const firstId = '44444444-4444-4444-8444-444444444444';
  const nextId = '55555555-5555-4555-8555-555555555555';
  const quote = { exact: 'hello', prefix: '', suffix: ' world', start: 0, end: 5, version: 'saved-hash' };
  return {
    version: 1, owner,
    documents: { [documentId]: { id: documentId, path: '/tmp/legacy.md', generated: false, userTitle: 'Preserved title' } },
    threads: { [threadId]: { id: threadId, documentId, scope: 'passage', quote, title: 'Existing thread', createdAt: 1, isResolved: true, messages: [
      { id: 'first-message', role: 'user', text: 'Explain', requestId: firstId, createdAt: 2 },
      { id: 'progress-message', role: 'agent', text: 'Checking', requestId: firstId, createdAt: 3 },
      { id: 'answer-message', role: 'agent', text: 'Answer', requestId: firstId, createdAt: 4 },
      { id: 'next-message', role: 'user', text: 'Follow-up', requestId: nextId, createdAt: 5 },
    ] } },
    requests: {
      [firstId]: { id: firstId, documentId, threadId, text: 'Explain', clientMessageId: 'old-1', submission: 'preserve-original-signature-1', quote, status: 'completed', createdAt: 2, acceptedAt: 2, answer: { text: 'Answer', isError: false } },
      [nextId]: { id: nextId, documentId, threadId, text: 'Follow-up', clientMessageId: 'old-2', submission: 'preserve-original-signature-2', quote, status: 'queued', createdAt: 5 },
    },
  };
}

test('v1 selections migrate once to the first user message with a byte-exact backup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = legacySelectionState(), raw = JSON.stringify(old, null, 2) + '\n';
  await writeFile(join(directory, 'state.json'), raw);
  const result = (await openStore(directory, owner)).read();
  assert.equal(result.version, 5);
  assert.deepEqual(result.proposals, {}); assert.deepEqual(result.proposalWrites, {});
  const previous = Object.values(old.threads)[0], thread = result.threads[previous.id];
  assert.deepEqual(thread.messages[0].selections, [{ id: 'first-message', slug: 'selection-1', quote: previous.quote, isVisible: false }]);
  assert.deepEqual(thread.messages.slice(1), previous.messages.slice(1));
  assert.equal('quote' in thread, false); assert.equal('scope' in thread, false);
  assert.equal(thread.title, previous.title); assert.equal(thread.isResolved, true);
  assert.deepEqual(result.requests, old.requests);
  assert.deepEqual(result.documents, old.documents);
  assert.equal(await readFile(join(directory, 'state.v1.backup.json'), 'utf8'), raw);
  assert.deepEqual((await openStore(directory, owner)).read(), result);
  assert.equal(await readFile(join(directory, 'state.v1.backup.json'), 'utf8'), raw);
});

test('ambiguous migration and failed publication preserve the original state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-migrate-fail-'));
  t.after(async () => { await chmod(directory, 0o700); await rm(directory, { recursive: true, force: true }); });
  const old = legacySelectionState();
  Object.values(old.threads)[0].messages = [];
  const ambiguous = JSON.stringify(old);
  await writeFile(join(directory, 'state.json'), ambiguous);
  await assert.rejects(openStore(directory, owner), /selection|user message/i);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), ambiguous);
  const raw = JSON.stringify(legacySelectionState());
  await writeFile(join(directory, 'state.json'), raw);
  await writeFile(join(directory, 'state.v1.backup.json'), raw);
  await chmod(directory, 0o500);
  await assert.rejects(openStore(directory, owner));
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), raw);
  assert.equal(await readFile(join(directory, 'state.v1.backup.json'), 'utf8'), raw);
  await chmod(directory, 0o700);
  assert.equal((await openStore(directory, owner)).read().version, 5);
});

test('v2 migration preserves each message selection, visibility, and version with an exact backup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-v2-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = legacySelectionState();
  const v2 = JSON.parse(JSON.stringify(old)); v2.version = 2;
  for (const thread of Object.values<any>(v2.threads)) {
    thread.messages[0].quote = thread.quote;
    delete thread.quote; delete thread.scope;
  }
  const raw = JSON.stringify(v2, null, 2) + '\n';
  await writeFile(join(directory, 'state.json'), raw);
  const migrated = (await openStore(directory, owner)).read();
  assert.deepEqual(migrated.proposals, {}); assert.deepEqual(migrated.proposalWrites, {});
  const thread = Object.values(migrated.threads)[0];
  assert.equal(thread.messages[0].selections?.[0].isVisible, false);
  assert.deepEqual(thread.messages[0].selections?.[0].quote, Object.values(old.threads)[0].quote);
  assert.deepEqual(migrated.requests, old.requests);
  assert.equal(await readFile(join(directory, 'state.v2.backup.json'), 'utf8'), raw);
  resolveThread(migrated, thread.id, false);
  assert.equal(thread.messages[0].selections?.[0].isVisible, false);
  v2.threads[thread.id].isResolved = false;
  const { readSavedState } = await import('../src/store.ts');
  assert.equal(readSavedState(v2).threads[thread.id].messages[0].selections?.[0].isVisible, true);
  assert.deepEqual((await openStore(directory, owner)).read().threads[thread.id].messages, thread.messages);
  // A rollback can leave an older backup while the old app accepts more edits.
  v2.threads[thread.id].title = 'Edited after rollback';
  const newer = JSON.stringify(v2);
  await writeFile(join(directory, 'state.json'), newer);
  assert.equal((await openStore(directory, owner)).read().threads[thread.id].title, 'Edited after rollback');
  assert.equal(await readFile(join(directory, 'state.v2.backup.json'), 'utf8'), raw);
  assert.equal(await readFile(join(directory, `state.v2.${createHash('sha256').update(newer).digest('hex')}.backup.json`), 'utf8'), newer);
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
