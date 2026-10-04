import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { claim, closeDocument, openStore, readSavedState, registerDocument, reply, submit, type Store } from '../src/store.ts';
import { prepareProposal } from '../src/proposals.ts';
import { readSourceFile } from '../src/documents.ts';

async function setup(t: { after(fn: () => Promise<void>): void }, markdown = '# Title\n\nOriginal content\n') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-proposal-service-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = { agent: 'codex' as const, sessionId: randomUUID() }, file = join(directory, 'doc.md'); await writeFile(file, markdown);
  const persisted = await openStore(directory, owner);
  let fail: 'journal' | 'final' | undefined, afterJournal: (() => Promise<void>) | undefined;
  const store: Store = { read: () => persisted.read(), async update(change) {
    const oldWrites = Object.keys(persisted.read().proposalWrites);
    const result = await persisted.update(draft => {
      const result = change(draft);
      if (fail === 'final' && Object.values(draft.proposals).some(p => p.status === 'accepted')) { fail = undefined; throw new Error('injected final save failure'); }
      return result;
    });
    if (Object.keys(persisted.read().proposalWrites).some(id => !oldWrites.includes(id))) {
      if (afterJournal) { const callback = afterJournal; afterJournal = undefined; await callback(); }
      if (fail === 'journal') { fail = undefined; throw new Error('injected journal acknowledgement failure'); }
    }
    return result;
  } };
  const doc = await store.update(s => registerDocument(s, { path: file, generated: false }));
  async function propose(replacements: Array<{ before: string; after: string; prefix?: string; suffix?: string }>, threadId?: string) {
    const source = await readSourceFile(file);
    const request = await store.update(s => { const r = submit(s, { documentId: doc.id, threadId, text: 'Propose', clientMessageId: randomUUID() }); claim(s, r.id, {}); return r; });
    await store.update(s => reply(s, { requestId: request.id, documentId: doc.id, threadId: request.threadId, text: 'Review.', selectionVersion: source.version,
      metadata: { highlights: replacements.map(proposal => ({ exact: proposal.before, proposal })) }, proposalTargets: replacements.map(input => prepareProposal(source.markdown, source.version, input)) }));
    const message = store.read().threads[request.threadId].messages.at(-1)!;
    return { request, message, proposals: Object.values(store.read().proposals).filter(p => p.messageId === message.id) };
  }
  const { createProposalService } = await import('../src/proposal-service.ts');
  const service = createProposalService({ store, directory, changed() {} });
  return { directory, file, owner, store, doc, propose, service, injectFailure(mode: typeof fail) { fail = mode; }, afterJournal(callback: () => Promise<void>) { afterJournal = callback; } };
}

test('proposal decisions serialize double clicks and Accept/Reject races with terminal idempotence', async t => {
  const f = await setup(t), first = await f.propose([{ before: 'Original content', after: 'Revised content' }]);
  const id = first.proposals[0].id;
  const results = await Promise.all([f.service.decide(id, 'accept'), f.service.decide(id, 'reject'), f.service.decide(id, 'accept')]);
  assert.ok(results.every(r => r.accepted.includes(id)));
  assert.equal(await readFile(f.file, 'utf8'), '# Title\n\nRevised content\n');
  assert.equal(f.store.read().proposals[id].status, 'accepted');
  assert.deepEqual(f.store.read().proposalWrites, {});
  assert.deepEqual(readSavedState(f.store.read()), f.store.read());
  const second = await f.propose([{ before: 'Revised content', after: 'Another revision' }]);
  await f.service.decide(second.proposals[0].id, 'reject');
  assert.deepEqual((await f.service.decide(second.proposals[0].id, 'accept')).rejected, [second.proposals[0].id]);
  assert.equal(await readFile(f.file, 'utf8'), '# Title\n\nRevised content\n');
});

test('Accept all is reply-scoped, excludes every overlap and stale member, and supports individual follow-up', async t => {
  const source = 'abcdef' + '.'.repeat(40) + 'valid' + '.'.repeat(40) + 'stale' + '.'.repeat(40) + 'other';
  const f = await setup(t, source), first = await f.propose([{ before: 'abc', after: 'A' }, { before: 'bcd', after: 'B' }, { before: 'def', after: 'C' }, { before: 'valid', after: 'accepted' }, { before: 'stale', after: 'old' }]);
  const later = await f.propose([{ before: 'other', after: 'unchosen' }], first.request.threadId);
  await writeFile(f.file, source.replace('stale', 'gone'));
  const result = await f.service.acceptReply(first.request.threadId, first.message.id);
  assert.deepEqual(result.accepted, [first.proposals[3].id]);
  assert.deepEqual(result.overlapping, first.proposals.slice(0, 3).map(p => p.id));
  assert.deepEqual(result.outdated, [first.proposals[4].id]);
  assert.equal(await readFile(f.file, 'utf8'), source.replace('stale', 'gone').replace('valid', 'accepted'));
  assert.equal(f.store.read().proposals[later.proposals[0].id].status, 'pending');
  await f.service.decide(first.proposals[4].id, 'reject');
  assert.equal(f.store.read().proposals[first.proposals[4].id].status, 'rejected');
  await f.service.decide(first.proposals[0].id, 'accept');
  assert.equal(f.store.read().proposals[first.proposals[1].id].status, 'outdated');
  await assert.rejects(f.service.acceptReply(later.request.threadId, 'missing'));
  await assert.rejects(f.service.decide(randomUUID(), 'accept'));
});

test('bulk versus individual acceptance applies once while another claimed request stays intact', async t => {
  const f = await setup(t), proposed = await f.propose([{ before: 'Original content', after: 'New content' }]);
  const request = await f.store.update(s => { const r = submit(s, { documentId: f.doc.id, text: 'Unrelated work', clientMessageId: 'active' }); claim(s, r.id, {}); return r; });
  await Promise.all([f.service.acceptReply(proposed.request.threadId, proposed.message.id), f.service.decide(proposed.proposals[0].id, 'accept')]);
  assert.equal(await readFile(f.file, 'utf8'), '# Title\n\nNew content\n');
  assert.equal(f.store.read().requests[request.id].status, 'claimed');
});

for (const boundary of ['snapshots', 'journal', 'final'] as const) test(`proposal recovery after ${boundary} failure never applies twice`, async t => {
  const f = await setup(t), proposed = await f.propose([{ before: 'Original content', after: 'Revised content' }]), id = proposed.proposals[0].id;
  if (boundary === 'snapshots') await writeFile(join(f.directory, 'versions'), 'blocked');
  else f.injectFailure(boundary);
  await assert.rejects(f.service.decide(id, 'accept'));
  const before = await readFile(f.file, 'utf8'), identity = await stat(f.file);
  assert.equal(before, boundary === 'final' ? '# Title\n\nRevised content\n' : '# Title\n\nOriginal content\n');
  if (boundary === 'snapshots') await rm(join(f.directory, 'versions'));
  const store = await openStore(f.directory, f.owner), { createProposalService } = await import('../src/proposal-service.ts');
  const restarted = createProposalService({ store, directory: f.directory, changed() {} });
  await restarted.recover();
  assert.equal(store.read().proposals[id].status, boundary === 'final' ? 'accepted' : 'pending');
  assert.deepEqual(store.read().proposalWrites, {});
  assert.equal((await stat(f.file)).ino, identity.ino, 'recovery must not publish a second file');
  await restarted.decide(id, 'accept');
  assert.equal(await readFile(f.file, 'utf8'), '# Title\n\nRevised content\n');
  assert.ok((await readdir(f.directory)).every(name => !name.startsWith('.sidecar-')));
});

test('uncertain recovery retains external content and evidence, even if that content later matches the proposed result', async t => {
  const f = await setup(t), proposed = await f.propose([{ before: 'Original content', after: 'Revised content' }]), id = proposed.proposals[0].id;
  f.injectFailure('final'); await assert.rejects(f.service.decide(id, 'accept'));
  await writeFile(f.file, 'External edits');
  await f.service.recover();
  assert.equal(await readFile(f.file, 'utf8'), 'External edits');
  assert.equal(f.store.read().proposals[id].reason, 'application-unconfirmed');
  assert.equal(Object.values(f.store.read().proposalWrites)[0].status, 'unconfirmed');
  await writeFile(f.file, '# Title\n\nRevised content\n'); await f.service.recover();
  assert.equal(f.store.read().proposals[id].status, 'outdated');
  await f.service.decide(id, 'reject');
  assert.deepEqual(readSavedState(f.store.read()), f.store.read());
});

test('external edits after journal preparation are preserved and cannot be published over', async t => {
  const f = await setup(t), proposed = await f.propose([{ before: 'Original content', after: 'New content' }]);
  f.afterJournal(() => writeFile(f.file, 'External content'));
  await assert.rejects(f.service.decide(proposed.proposals[0].id, 'accept'));
  assert.equal(await readFile(f.file, 'utf8'), 'External content');
  await f.service.recover();
  assert.equal(f.store.read().proposals[proposed.proposals[0].id].status, 'outdated');
});

test('document close and drain wait for acceptance, remove proposal evidence and preserve the applied file', async t => {
  const f = await setup(t), proposed = await f.propose([{ before: 'Original content', after: 'New content' }]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.afterJournal(async () => { entered(); await gate; });
  const accepting = f.service.decide(proposed.proposals[0].id, 'accept'); await started;
  const closing = f.service.withDocument(f.doc.id, async () => { await f.store.update(s => closeDocument(s, f.doc.id)); await rm(join(f.directory, 'versions', f.doc.id), { recursive: true, force: true }); });
  let drained = false; const draining = f.service.drain().then(() => { drained = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release(); await Promise.all([accepting, closing, draining]);
  assert.deepEqual(f.store.read().proposals, {}); assert.deepEqual(f.store.read().proposalWrites, {});
  assert.equal(await readFile(f.file, 'utf8'), '# Title\n\nNew content\n');
  await assert.rejects(readFile(join(f.directory, 'versions', f.doc.id, proposed.proposals[0].baseVersion + '.md')));
});

test('a completed reply queued behind acceptance is saved before a following document close', async t => {
  const f = await setup(t), first = await f.propose([{ before: 'Original content', after: 'New content' }]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.afterJournal(async () => { entered(); await gate; });
  const accepting = f.service.decide(first.proposals[0].id, 'accept'); await started;
  const next = await f.store.update(s => { const r = submit(s, { documentId: f.doc.id, threadId: first.request.threadId, text: 'Next', clientMessageId: 'next' }); claim(s, r.id, {}); return r; });
  const completing = f.service.withDocument(f.doc.id, async () => {
    const source = await readSourceFile(f.file), input = { before: 'New content', after: 'Later content' };
    const { saveDocumentVersion } = await import('../src/snapshots.ts'); await saveDocumentVersion(f.directory, f.doc.id, source);
    await f.store.update(s => reply(s, { requestId: next.id, documentId: f.doc.id, threadId: next.threadId, text: 'Next proposal', selectionVersion: source.version,
      metadata: { highlights: [{ exact: 'New content', proposal: input }] }, proposalTargets: [prepareProposal(source.markdown, source.version, input)] }));
  });
  const closing = f.service.withDocument(f.doc.id, async () => {
    assert.equal(Object.keys(f.store.read().proposals).length, 2);
    assert.equal(f.store.read().requests[next.id].status, 'completed');
    await f.store.update(s => closeDocument(s, f.doc.id)); await rm(join(f.directory, 'versions', f.doc.id), { recursive: true, force: true });
  });
  release(); await Promise.all([accepting, completing, closing]); await f.service.drain();
  assert.deepEqual(f.store.read().proposals, {}); assert.deepEqual(readSavedState(f.store.read()), f.store.read());
  assert.deepEqual(await readdir(join(f.directory, 'versions')), []);
  assert.equal(await readFile(f.file, 'utf8'), '# Title\n\nNew content\n');
});
