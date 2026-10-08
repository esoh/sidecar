import { isObject, ownerKey, type Owner } from './store.ts';
import type { AgentIds, IdKind, IdRef } from './agent-ids.ts';

// Explicit record schemas: UUID-looking prose and file contents are never rewritten.
export async function compactContext(owner: Owner, context: Record<string, unknown>, ids: AgentIds): Promise<Record<string, unknown>> {
  const key = ownerKey(owner), refs: IdRef[] = [];
  let collecting = true;
  const id = (kind: IdKind, value: unknown) => {
    if (typeof value !== 'string' || !value) return value;
    if (collecting) { refs.push({ kind, id: value }); return value; }
    return ids.encode(key, kind, value);
  };
  const fields = (value: unknown, mapping: Record<string, IdKind>, omit: string[] = []): Record<string, unknown> => {
    if (!isObject(value)) return {};
    const result = { ...value };
    for (const field of omit) delete result[field];
    for (const [field, kind] of Object.entries(mapping)) if (field in result) result[field] = id(kind, result[field]);
    return result;
  };
  const array = (value: unknown, fn: (value: unknown) => unknown) => Array.isArray(value) ? value.map(fn) : value;
  const quote = (value: unknown) => fields(value, { version: 'v' });
  const messageQuote = (value: unknown) => fields(value, { threadId: 't', messageId: 'm' });
  const selection = (value: unknown) => {
    const result = fields(value, { id: 's' });
    if (result.quote) result.quote = quote(result.quote);
    return result;
  };
  const input = (value: unknown, kind?: IdKind) => {
    const result = fields(value, { ...(kind ? { id: kind } : {}), requestId: 'r', documentId: 'd', threadId: 't', batchId: 'r', answeredBy: 'r' }, ['clientMessageId', 'submission', 'nativeTurnId', 'handoff', 'acceptedAt']);
    if (result.covers) result.covers = array(result.covers, v => id('r', v));
    if (result.quote) result.quote = quote(result.quote);
    if (result.messageQuote) result.messageQuote = messageQuote(result.messageQuote);
    if (result.selections) result.selections = array(result.selections, selection);
    if (result.replyRecovery) result.replyRecovery = fields(result.replyRecovery, { id: 'e' }, ['turnId']);
    return result;
  };
  const project = () => {
    const result = input(context);
    if (result.ownerKey) result.ownerKey = id('o', key);
    if (result.recoveryId) result.recoveryId = id('e', result.recoveryId);
    if (result.request) result.request = input(result.request, 'r');
    if (result.messages) result.messages = array(result.messages, v => input(v));
    if (result.document) result.document = fields(result.document, { id: 'd', version: 'v' });
    if (result.thread) {
      const thread = fields(result.thread, { id: 't', documentId: 'd', lastRequestId: 'r' });
      if (thread.messages) thread.messages = array(thread.messages, v => input(v, 'm'));
      result.thread = thread;
    }
    if (result.proposals) result.proposals = array(result.proposals, v => fields(v, { id: 'p', documentId: 'd', threadId: 't', messageId: 'm', selectionId: 's', baseVersion: 'v', appliedVersion: 'v' }));
    return result;
  };
  project(); await ids.allocate(key, refs); collecting = false;
  return project();
}
export async function compactNotification(owner: Owner, event: Record<string, unknown>, ids: AgentIds) {
  const result = await compactContext(owner, { ...event, ownerKey: ownerKey(owner) }, ids);
  result.type = event.type === 'sidecar.recovery' ? 'sc.recovery' : 'sc.request';
  if (isObject(event.stream) && typeof event.stream.error === 'string') result.streamError = event.stream.error;
  delete result.stream;
  return result;
}
