import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReply } from '../src/reply-metadata.ts';
import { claim, createState, openStore, readSavedState, registerDocument, reply, submit } from '../src/store.ts';

const owner = { agent: 'codex' as const, sessionId: '11111111-1111-4111-8111-111111111111' };
const proposal = { before: 'Retries: **3**', after: 'Retries: **4**' };
const meta = (highlights: unknown[]) => parseReply(`[[sidecar-meta ${JSON.stringify({ highlights })}]]\nReview [this](#selection-2).`);

test('proposal metadata retains source text and ordinary highlights without shifting links', () => {
  const result = meta([{ exact: 'Retries', proposal }, { exact: 'Other', label: 'Another passage' }]);
  assert.equal(result.text, 'Review [this](#selection-2).');
  assert.deepEqual(result.metadata.highlights, [{ exact: 'Retries', proposal }, { exact: 'Other', label: 'Another passage' }]);
});

test('invalid nested proposals become diagnostics while preserving the answer and highlight positions', () => {
  for (const invalid of [null, {}, { before: '', after: 'a' }, { before: 'same', after: 'same' }, { before: 'a' },
    { before: 'a'.repeat(16385), after: 'b' }, { before: 'a', after: 'b'.repeat(16385) },
    { ...proposal, prefix: 'x'.repeat(513) }, { ...proposal, suffix: 'x'.repeat(513) }]) {
    const result = meta([{ exact: 'First', proposal: invalid }, { exact: 'Second', proposal }]);
    assert.equal(result.text, 'Review [this](#selection-2).');
    assert.equal(result.metadata.highlights?.length, 2);
    assert.equal(result.metadata.highlights?.[0].proposal, undefined);
    assert.equal(result.metadata.highlights?.[0].proposalError, 'This proposed change could not be prepared.');
    assert.deepEqual(result.metadata.highlights?.[1].proposal, proposal);
  }
});

test('proposal boundaries allow deletion and maximum source/context lengths but not excessive highlights', () => {
  const inputs = [{ before: 'a', after: '' }, { before: 'a'.repeat(16384), after: 'b'.repeat(16384), prefix: 'p'.repeat(512), suffix: 's'.repeat(512) }];
  for (const input of inputs) assert.deepEqual(meta([{ exact: 'Passage', proposal: input }]).metadata.highlights?.[0].proposal, input);
  assert.equal(meta(Array.from({ length: 21 }, () => ({ exact: 'Passage', proposal }))).metadata.highlights, undefined);
  assert.deepEqual(parseReply('[[sidecar-meta {"highlights":['), { text: '', metadata: {} });
  assert.deepEqual(parseReply('[[sidecar-meta not JSON]]\nAnswer'), { text: 'Answer', metadata: {} });
});

function answered() {
  const state = createState(owner), doc = registerDocument(state, { path: '/tmp/proposal.md', generated: false });
  const request = submit(state, { documentId: doc.id, text: 'Propose a change', clientMessageId: 'first' });
  claim(state, request.id, {});
  const input = { requestId: request.id, documentId: doc.id, threadId: request.threadId, text: 'Review this.',
    selectionVersion: 'v1', metadata: { highlights: [{ exact: 'Retries: 3', proposal }] },
    proposalTargets: [{ ...proposal, prefix: '', suffix: '', baseVersion: 'v1', baseRange: { start: 0, end: 14 } }] };
  reply(state, input);
  return { state, doc, request, input };
}

test('a completed reply persists independently routed proposals exactly once', () => {
  const { state, doc, request, input } = answered();
  assert.equal(state.version, 4);
  assert.equal(Object.keys(state.proposals).length, 1);
  const saved = Object.values(state.proposals)[0], message = state.threads[request.threadId].messages.at(-1)!;
  assert.equal(saved.status, 'pending');
  assert.equal(saved.documentId, doc.id); assert.equal(saved.threadId, request.threadId);
  assert.equal(saved.messageId, message.id); assert.equal(saved.selectionId, message.selections?.[0].id);
  assert.equal(saved.before, 'Retries: **3**'); assert.equal(saved.after, 'Retries: **4**');
  reply(state, input);
  assert.deepEqual(Object.values(state.proposals), [saved]);
  assert.deepEqual(readSavedState(state), state);
});

test('saved proposal routing and write evidence reject dangling or inconsistent relationships', () => {
  const { state } = answered();
  const saved = Object.values(state.proposals)[0];
  assert.ok(saved);
  for (const patch of [{ threadId: owner.sessionId }, { documentId: owner.sessionId }, { messageId: 'missing' }, { selectionId: 'missing' },
    { createdAt: Infinity }, { baseRange: { start: -1, end: 2 } }, { status: 'accepted' }, { status: 'outdated', reason: undefined }]) {
    const invalid = structuredClone(state);
    Object.assign(invalid.proposals[saved.id], patch);
    assert.throws(() => readSavedState(invalid));
  }
  const duplicate = structuredClone(state);
  duplicate.proposals[owner.sessionId] = { ...saved, id: owner.sessionId };
  assert.throws(() => readSavedState(duplicate));
  const write = { id: owner.sessionId, documentId: saved.documentId, status: 'prepared' as const, proposalIds: [saved.id], decidedAt: 10, beforeVersion: 'v1', afterVersion: 'v2', appliedRanges: { [saved.id]: { start: 0, end: 14 } } };
  const valid = structuredClone(state); valid.proposalWrites[write.id] = write;
  assert.deepEqual(readSavedState(valid), valid);
  for (const patch of [{ documentId: 'missing' }, { proposalIds: ['missing'] }, { appliedRanges: {} }, { decidedAt: NaN }]) {
    const invalid = structuredClone(valid); Object.assign(invalid.proposalWrites[write.id], patch);
    assert.throws(() => readSavedState(invalid));
  }
});

test('v4 restarts retain proposal decisions and reject malformed selection diagnostics without rewriting state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidecar-proposal-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { state, request } = answered(), saved = Object.values(state.proposals)[0];
  saved.status = 'accepted'; saved.decidedAt = 10; saved.appliedVersion = 'v2'; saved.appliedRange = { start: 0, end: 14 };
  await writeFile(join(directory, 'state.json'), JSON.stringify(state));
  assert.deepEqual((await openStore(directory, owner)).read(), state);
  const invalid = JSON.parse(JSON.stringify(state));
  invalid.proposals = {};
  invalid.threads[request.threadId].messages.at(-1).selections[0].proposalError = 42;
  const raw = JSON.stringify(invalid); await writeFile(join(directory, 'state.json'), raw);
  await assert.rejects(openStore(directory, owner));
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), raw);
});

test('unavailable proposal sources keep the reply with no invented revision or actionable proposal', () => {
  const { state, doc } = answered();
  const request = submit(state, { documentId: doc.id, text: 'Propose another', clientMessageId: 'second' });
  claim(state, request.id, {});
  reply(state, { requestId: request.id, documentId: doc.id, threadId: request.threadId, text: 'Still saved', selectionVersion: '',
    metadata: meta([{ exact: 'First', proposal: {} }, { exact: 'Second', proposal }]).metadata,
    proposalTargets: [null, { ...proposal, prefix: '', suffix: '', baseVersion: null, baseRange: null, reason: 'source-unavailable' }] });
  const message = state.threads[request.threadId].messages.at(-1)!;
  assert.equal(message.selections?.[0].proposalError, 'This proposed change could not be prepared.');
  assert.equal(message.selections?.[1].quote.version, '');
  assert.equal(message.selections?.[1].slug, 'selection-2');
  const saved = Object.values(state.proposals).find(p => p.messageId === message.id)!;
  assert.equal(saved.status, 'outdated'); assert.equal(saved.reason, 'source-unavailable'); assert.equal(saved.baseVersion, null);
  assert.deepEqual(readSavedState(state), state);
});
