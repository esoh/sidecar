import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, registerDocument, submit, claim, reply, resolveThread, setTitle, openStore } from '../src/store.ts';

const owner = { agent: 'codex' as const, sessionId: '11111111-1111-4111-8111-111111111111' };
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
    assert.deepEqual(follow.quote, quote);
    resolveThread(state, first.threadId, true);
    assert.equal(submit(state, followInput).id, follow.id);
    assert.equal(state.threads[first.threadId]?.isResolved, true);
    assert.equal(state.threads[first.threadId]?.messages.length, 2);
  }
});

test('a claim grants execution once and prevents a second active request', () => {
  const { state, input } = setup();
  const first = submit(state, input);
  const second = submit(state, { ...input, clientMessageId: 'second' });
  assert.equal(claim(state, first.id, {}).claimStatus, 'claimed');
  assert.equal(claim(state, first.id, {}).claimStatus, 'already-claimed');
  assert.throws(() => claim(state, second.id, {}));
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

test('follow-ups remain in their document and preserve quote context', () => {
  const { state, input, other } = setup();
  const quote = { exact: 'hello', prefix: '', suffix: ' world', start: 0, end: 5, version: 'v1', sentence: 'hello world.' };
  const first = submit(state, { ...input, quote });
  const follow = submit(state, { ...input, threadId: first.threadId, text: 'Why?', clientMessageId: 'follow' });
  assert.equal(follow.threadId, first.threadId);
  assert.deepEqual(follow.quote, quote);
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
