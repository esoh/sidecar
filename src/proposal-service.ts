import { randomUUID } from 'node:crypto';
import { readSourceFile } from './documents.ts';
import { planReplacements, type DecisionResult, type Proposal } from './proposals.ts';
import { discardFileWrite, prepareFileWrite, publishFileWrite } from './proposal-writes.ts';
import { saveDocumentVersion } from './snapshots.ts';
import { DomainError, get, type State, type Store } from './store.ts';

const resultFor = (proposals: Proposal[]): DecisionResult => ({
  accepted: proposals.filter(p => p.status === 'accepted').map(p => p.id),
  rejected: proposals.filter(p => p.status === 'rejected').map(p => p.id),
  outdated: proposals.filter(p => p.status === 'outdated').map(p => p.id),
  overlapping: proposals.filter(p => p.status === 'pending' && p.reason === 'overlap').map(p => p.id),
});

function recheck(state: State, documentId: string, markdown: string) {
  for (const proposal of Object.values(state.proposals)) {
    if (proposal.documentId !== documentId || proposal.status !== 'pending') continue;
    const stale = planReplacements(markdown, [proposal]).outdated[0];
    if (stale) { proposal.status = 'outdated'; proposal.reason = stale.reason; }
  }
}

export function createProposalService({ store, directory, changed }: { store: Store; directory: string; changed: () => void }) {
  const operations = new Map<string, Promise<unknown>>();
  async function withDocument<T>(documentId: string, operation: () => Promise<T>): Promise<T> {
    const path = get(store.read().documents, documentId).path;
    const work = (operations.get(path) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (get(store.read().documents, documentId).path !== path) throw new DomainError('Document registration changed', 409);
      return operation();
    });
    operations.set(path, work);
    try { return await work; }
    finally { if (operations.get(path) === work) operations.delete(path); }
  }
  async function recoverDocument(documentId: string) {
    const pending = Object.values(store.read().proposalWrites).filter(w => w.documentId === documentId && w.status === 'prepared');
    if (!pending.length) return;
    const source = await readSourceFile(get(store.read().documents, documentId).path);
    await store.update(state => {
      for (const write of pending) {
        if (source.version === write.afterVersion) {
          for (const id of write.proposalIds) Object.assign(get(state.proposals, id), { status: 'accepted', decidedAt: write.decidedAt, appliedVersion: write.afterVersion, appliedRange: write.appliedRanges[id] });
          for (const id of write.proposalIds) delete state.proposals[id].reason;
          delete state.proposalWrites[write.id];
        } else if (source.version === write.beforeVersion) delete state.proposalWrites[write.id];
        else {
          for (const id of write.proposalIds) Object.assign(get(state.proposals, id), { status: 'outdated', reason: 'application-unconfirmed' });
          get(state.proposalWrites, write.id).status = 'unconfirmed';
        }
      }
      recheck(state, documentId, source.markdown);
    });
    changed();
  }
  async function recover(documentId?: string) {
    if (documentId !== undefined) return withDocument(documentId, () => recoverDocument(documentId));
    // An unavailable file must not prevent its other documents from opening.
    // Its prepared evidence remains; a decision retries recovery and reports the I/O error.
    await Promise.allSettled([...new Set(Object.values(store.read().proposalWrites).map(w => w.documentId))].map(id => withDocument(id, () => recoverDocument(id))));
  }
  async function accept(documentId: string, ids: string[]): Promise<DecisionResult> {
    const selected = ids.map(id => get(store.read().proposals, id));
    const pending = selected.filter(p => p.status === 'pending');
    if (!pending.length) return resultFor(selected);
    const source = await readSourceFile(get(store.read().documents, documentId).path);
    const plan = planReplacements(source.markdown, pending);
    const recordUnapplied = (state: State) => {
      for (const stale of plan.outdated) Object.assign(get(state.proposals, stale.id), { status: 'outdated', reason: stale.reason });
      for (const id of plan.overlapping) get(state.proposals, id).reason = 'overlap';
    };
    if (plan.applied.length) {
      const prepared = await prepareFileWrite(source, plan.markdown);
      try {
        await saveDocumentVersion(directory, documentId, source);
        await saveDocumentVersion(directory, documentId, { markdown: prepared.markdown, version: prepared.afterVersion });
        const write = { id: randomUUID(), documentId, status: 'prepared' as const, proposalIds: plan.applied.map(p => p.id), decidedAt: Date.now(), beforeVersion: prepared.beforeVersion, afterVersion: prepared.afterVersion, appliedRanges: Object.fromEntries(plan.applied.map(p => [p.id, p.range])) };
        await store.update(state => { state.proposalWrites[write.id] = write; });
        publishFileWrite(prepared);
        await store.update(state => {
          recordUnapplied(state);
          for (const applied of plan.applied) {
            const proposal = get(state.proposals, applied.id);
            Object.assign(proposal, { status: 'accepted', decidedAt: write.decidedAt, appliedVersion: write.afterVersion, appliedRange: applied.range });
            delete proposal.reason;
          }
          delete state.proposalWrites[write.id];
          recheck(state, documentId, plan.markdown);
        });
      } finally { await discardFileWrite(prepared); }
    } else await store.update(recordUnapplied);
    changed();
    return resultFor(ids.map(id => get(store.read().proposals, id)));
  }
  async function decide(proposalId: string, decision: 'accept' | 'reject'): Promise<DecisionResult> {
    const { documentId } = get(store.read().proposals, proposalId);
    return withDocument(documentId, async () => {
      await recoverDocument(documentId);
      const proposal = get(store.read().proposals, proposalId);
      if (proposal.status === 'accepted' || proposal.status === 'rejected') return resultFor([proposal]);
      if (decision === 'accept') return accept(documentId, [proposalId]);
      await store.update(state => { Object.assign(get(state.proposals, proposalId), { status: 'rejected', decidedAt: Date.now() }); });
      changed(); return resultFor([get(store.read().proposals, proposalId)]);
    });
  }
  async function acceptReply(threadId: string, messageId: string): Promise<DecisionResult> {
    const { documentId } = get(store.read().threads, threadId);
    return withDocument(documentId, async () => {
      await recoverDocument(documentId);
      const state = store.read(), thread = get(state.threads, threadId);
      if (!thread.messages.some(m => m.id === messageId && m.role === 'agent')) throw new DomainError('Reply not found', 404);
      const ids = Object.values(state.proposals).filter(p => p.threadId === threadId && p.messageId === messageId && p.status === 'pending').map(p => p.id);
      return accept(documentId, ids);
    });
  }
  async function revalidate(documentId: string) {
    await withDocument(documentId, async () => {
      await recoverDocument(documentId);
      const state = store.read(), pending = Object.values(state.proposals).filter(p => p.documentId === documentId && p.status === 'pending');
      if (!pending.length) return;
      const source = await readSourceFile(get(state.documents, documentId).path);
      if (!pending.some(p => planReplacements(source.markdown, [p]).outdated.length)) return;
      await store.update(state => recheck(state, documentId, source.markdown)); changed();
    });
  }
  async function drain() { while (operations.size) await Promise.allSettled([...operations.values()]); }
  return { withDocument, decide, acceptReply, recover, revalidate, drain };
}
