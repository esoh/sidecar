import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export type Owner = { agent: 'codex' | 'claude'; sessionId: string };
import { isQuote, type Quote } from './quote.ts';
export { isQuote, type Quote } from './quote.ts';
export type RepoInfo = { display: string; branch?: string };
export type DocumentRecord = { id: string; path: string; generated: boolean; providedTitle?: string; userTitle?: string; repoInfo?: RepoInfo };
export type Message = { id: string; role: 'user' | 'agent'; text: string; requestId: string; createdAt: number; quote?: Quote };
export type Thread = { id: string; documentId: string; title?: string; createdAt?: number; isResolved: boolean; messages: Message[] };
export type RequestRecord = {
  id: string; documentId: string; threadId: string; text: string; clientMessageId: string;
  quote?: Quote; status: 'queued' | 'claimed' | 'completed' | 'failed' | 'uncertain'; createdAt: number;
  submission: string; answer?: { text: string; isError: boolean }; acceptedAt?: number;
};
export type State = { version: 2; owner: Owner; documents: Record<string, DocumentRecord>; threads: Record<string, Thread>; requests: Record<string, RequestRecord> };
export type Store = { read(): State; update<T>(change: (draft: State) => T): Promise<T> };
export type SubmitInput = { documentId: string; threadId?: string; text: string; quote?: Quote; clientMessageId: string };
export type ReplyInput = { requestId: string; documentId: string; threadId: string; text: string; isError?: boolean };
export type ClaimResult = { claimStatus: 'claimed' | 'already-claimed' | 'completed' | 'uncertain'; request: RequestRecord };

export class DomainError extends Error {
  constructor(message: string, public status: number = 400) { super(message); }
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isOwner(value: unknown): value is Owner {
  return isObject(value) && (value.agent === 'codex' || value.agent === 'claude') && typeof value.sessionId === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.sessionId);
}
export function ownerKey(owner: Owner): string {
  if (!isOwner(owner)) throw new DomainError('Expected an agent type and native session UUID');
  return `${owner.agent}-${owner.sessionId.toLowerCase()}`;
}
const string = (v: unknown): v is string => typeof v === 'string';
const optionalString = (v: unknown) => v === undefined || string(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function isRepoInfo(v: unknown): v is RepoInfo {
  return isObject(v) && string(v.display) && v.display.trim().length > 0 && v.display.length <= 512 && (v.branch === undefined || (string(v.branch) && v.branch.length > 0 && v.branch.length <= 512));
}
function isDocument(v: unknown): v is DocumentRecord {
  return isObject(v) && string(v.id) && string(v.path) && isAbsolute(v.path) && typeof v.generated === 'boolean' && optionalString(v.providedTitle) && optionalString(v.userTitle) && (v.repoInfo === undefined || isRepoInfo(v.repoInfo));
}
function isMessage(v: unknown): v is Message {
  return isObject(v) && string(v.id) && (v.role === 'user' || v.role === 'agent') && string(v.text) && string(v.requestId) && number(v.createdAt) && (v.quote === undefined || (v.role === 'user' && isQuote(v.quote)));
}
type LegacyThread = Thread & { scope: 'passage' | 'document'; quote?: Quote };
function isThreadFields(v: unknown): v is Thread {
  return isObject(v) && string(v.id) && string(v.documentId) && optionalString(v.title) && (v.createdAt === undefined || number(v.createdAt)) && typeof v.isResolved === 'boolean' && Array.isArray(v.messages) && v.messages.every(isMessage);
}
function isThread(v: unknown): v is Thread {
  return isThreadFields(v) && !('scope' in v) && !('quote' in v);
}
function isLegacyThread(v: unknown): v is LegacyThread {
  return isThreadFields(v) && 'scope' in v && (v.scope === 'passage' || v.scope === 'document') && ((v.scope === 'passage' && 'quote' in v && isQuote(v.quote)) || (v.scope === 'document' && !('quote' in v))) && v.messages.every(message => message.quote === undefined);
}
function isRequest(v: unknown): v is RequestRecord {
  return isObject(v) && string(v.id) && string(v.documentId) && string(v.threadId) && string(v.text) && string(v.clientMessageId) && string(v.submission) && number(v.createdAt) && string(v.status) && ['queued','claimed','completed','failed','uncertain'].includes(v.status) && (v.quote === undefined || isQuote(v.quote)) && (v.acceptedAt === undefined || number(v.acceptedAt)) && (v.answer === undefined || (isObject(v.answer) && string(v.answer.text) && typeof v.answer.isError === 'boolean'));
}
function records<T extends {id: string}>(v: unknown, check: (v: unknown) => v is T): v is Record<string,T> {
  return isObject(v) && Object.entries(v).every(([key, item]) => check(item) && key === item.id && /^[0-9a-f-]{36}$/i.test(key));
}
export function isState(v: unknown): v is State {
  return isObject(v) && v.version === 2 && isOwner(v.owner) && records(v.documents, isDocument) && records(v.threads, isThread) && records(v.requests, isRequest);
}
type LegacyState = Omit<State, 'version' | 'threads'> & { version: 1; threads: Record<string, LegacyThread> };
function isLegacyState(v: unknown): v is LegacyState {
  return isObject(v) && v.version === 1 && isOwner(v.owner) && records(v.documents, isDocument) && records(v.threads, isLegacyThread) && records(v.requests, isRequest);
}
export function readSavedState(value: unknown): State {
  if (!isLegacyState(value) && !isState(value)) throw new Error('Malformed Sidecar state; the existing file was preserved');
  let state: State;
  if (isLegacyState(value)) {
    const threads: Record<string, Thread> = {};
    for (const thread of Object.values(value.threads)) {
      const { scope, quote, ...plain } = structuredClone(thread);
      if (quote) {
        const first = plain.messages.find(message => message.role === 'user');
        if (!first) throw new Error('Legacy selection has no user message; the existing file was preserved');
        first.quote = quote;
      }
      threads[thread.id] = plain;
    }
    state = { version: 2, owner: structuredClone(value.owner), documents: structuredClone(value.documents), requests: structuredClone(value.requests), threads };
  } else if (isState(value)) state = structuredClone(value);
  else throw new Error('Malformed Sidecar state');
  for (const thread of Object.values(state.threads)) {
    get(state.documents, thread.documentId);
    for (const message of thread.messages) {
      if (get(state.requests, message.requestId).threadId !== thread.id) throw new Error('Malformed message routing');
    }
  }
  for (const request of Object.values(state.requests)) {
    if (get(state.threads, request.threadId).documentId !== request.documentId) throw new Error('Malformed request routing');
  }
  return state;
}
export function get<T>(items: Record<string,T>, id: string): T {
  if (!Object.hasOwn(items, id)) throw new DomainError('Not found', 404);
  const value = items[id];
  if (value === undefined) throw new DomainError('Not found', 404);
  return value;
}
export function createState(owner: Owner): State {
  ownerKey(owner);
  return { version: 2, owner: structuredClone(owner), documents: {}, threads: {}, requests: {} };
}
export function registerDocument(state: State, input: {path: string; title?: string; generated: boolean; repoInfo?: RepoInfo}): DocumentRecord {
  if (!isAbsolute(input.path)) throw new DomainError('Document path must be absolute');
  if (input.repoInfo !== undefined && !isRepoInfo(input.repoInfo)) throw new DomainError('Invalid repository metadata');
  const path = resolve(input.path);
  let document = Object.values(state.documents).find(d => d.path === path);
  if (!document) {
    document = { id: randomUUID(), path, generated: input.generated };
    state.documents[document.id] = document;
  }
  if (input.repoInfo !== undefined) document.repoInfo = structuredClone(input.repoInfo);
  ensureGeneralThread(state, document.id);
  if (input.title?.trim()) document.providedTitle = input.title.trim();
  return document;
}
export function closeDocument(state: State, documentId: string): string[] {
  get(state.documents, documentId);
  const requests = Object.values(state.requests).filter(request => request.documentId === documentId);
  if (requests.some(request => ['queued', 'claimed', 'uncertain'].includes(request.status)))
    throw new DomainError('Wait for this document’s pending agent requests to finish before closing it.', 409);
  const threadIds = Object.values(state.threads).filter(thread => thread.documentId === documentId).map(thread => thread.id);
  for (const id of threadIds) delete state.threads[id];
  for (const request of requests) delete state.requests[request.id];
  delete state.documents[documentId];
  return threadIds;
}
export function createThread(state: State, input: { id?: string; documentId: string }): Thread {
  get(state.documents, input.documentId);
  const id = input.id ?? randomUUID();
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new DomainError('Expected a thread UUID');
  if (Object.hasOwn(state.threads, id)) {
    const existing = get(state.threads, id);
    if (existing.documentId !== input.documentId) throw new DomainError('Thread ID was already used for another conversation', 409);
    return existing;
  }
  const thread: Thread = { id, documentId: input.documentId, createdAt: Date.now(), isResolved: false, messages: [] };
  state.threads[id] = thread;
  return thread;
}
export function discardEmptyThread(state: State, threadId: string): boolean {
  if (!Object.hasOwn(state.threads, threadId)) return false;
  const thread = state.threads[threadId];
  if (thread.messages.length || Object.values(state.requests).some(request => request.threadId === threadId)) return false;
  delete state.threads[threadId];
  return true;
}
function ensureGeneralThread(state: State, documentId: string) {
  if (!Object.values(state.threads).some(thread => thread.documentId === documentId)) createThread(state, { documentId });
}
export function nameThread(state: State, threadId: string, title: string, { canRename = false } = {}): void {
  const thread = get(state.threads, threadId), value = title.trim();
  if (!value || value.length > 80 || /[\r\n\x00-\x1f]/.test(value)) throw new DomainError('Thread name must be 1–80 characters on one line');
  if (!canRename && thread.title && thread.title !== value) throw new DomainError('Thread already has a name', 409);
  thread.title = value;
}
export function submit(state: State, input: SubmitInput): RequestRecord {
  get(state.documents, input.documentId);
  if (!input.text.trim() || !input.clientMessageId || input.clientMessageId.length > 128) throw new DomainError('A question and message ID are required');
  if (input.quote !== undefined && !isQuote(input.quote)) throw new DomainError('Invalid selection');
  const signature = JSON.stringify([input.documentId, input.threadId ?? null, input.text, input.quote ?? null]);
  const previous = Object.values(state.requests).find(r => r.clientMessageId === input.clientMessageId);
  if (previous) {
    if (previous.submission !== signature) throw new DomainError('Message ID was already used for different content', 409);
    return previous;
  }
  let thread: Thread;
  if (input.threadId) {
    thread = get(state.threads, input.threadId);
    if (thread.documentId !== input.documentId) throw new DomainError('Thread belongs to another document', 409);
  } else {
    thread = createThread(state, { documentId: input.documentId });
  }
  const request: RequestRecord = { id: randomUUID(), documentId: input.documentId, threadId: thread.id, text: input.text, clientMessageId: input.clientMessageId, submission: signature, status: 'queued', createdAt: Date.now() };
  if (input.quote) request.quote = structuredClone(input.quote);
  state.requests[request.id] = request;
  thread.isResolved = false;
  thread.messages.push({ id: randomUUID(), role: 'user', text: input.text, requestId: request.id, createdAt: request.createdAt, ...(input.quote ? { quote: structuredClone(input.quote) } : {}) });
  return request;
}
export function claim(state: State, requestId: string, options: {resume?: boolean}): ClaimResult {
  const request = get(state.requests, requestId);
  if (request.status === 'completed' || request.status === 'failed') return { claimStatus: 'completed', request };
  if (request.status === 'claimed') return { claimStatus: 'already-claimed', request };
  if (request.status === 'uncertain' && !options.resume) return { claimStatus: 'uncertain', request };
  if (Object.values(state.requests).some(r => r.id !== requestId && r.status === 'claimed')) throw new DomainError('Another request is in progress', 409);
  request.status = 'claimed';
  return { claimStatus: 'claimed', request };
}
export function recordProgress(state: State, input: ReplyInput & { messageId: string }): void {
  const request = get(state.requests, input.requestId);
  if (request.documentId !== input.documentId || request.threadId !== input.threadId) throw new DomainError('Progress routing does not match the request', 409);
  if (request.status !== 'claimed') throw new DomainError('Claim the request before reporting progress', 409);
  if (!input.text.trim()) throw new DomainError('Progress text is required');
  const thread = get(state.threads, request.threadId);
  const id = `progress:${request.id}:${input.messageId}`;
  const previous = thread.messages.find(message => message.id === id);
  if (previous) {
    if (previous.text !== input.text) throw new DomainError('A different progress update already exists', 409);
    return;
  }
  thread.messages.push({ id, role: 'agent', text: input.text, requestId: request.id, createdAt: Date.now() });
}
export function reply(state: State, input: ReplyInput): void {
  const request = get(state.requests, input.requestId);
  if (request.documentId !== input.documentId || request.threadId !== input.threadId) throw new DomainError('Reply routing does not match the request', 409);
  if (!input.text.trim()) throw new DomainError('Reply text is required');
  const answer = { text: input.text, isError: input.isError === true };
  if (request.answer) {
    if (request.answer.text !== answer.text || request.answer.isError !== answer.isError) throw new DomainError('A different reply already exists', 409);
    return;
  }
  if (request.status !== 'claimed') throw new DomainError('Claim the request before replying', 409);
  request.answer = answer;
  request.status = answer.isError ? 'failed' : 'completed';
  get(state.threads, request.threadId).messages.push({ id: randomUUID(), role: 'agent', text: answer.text, requestId: request.id, createdAt: Date.now() });
}
export function resolveThread(state: State, threadId: string, isResolved: boolean): void {
  get(state.threads, threadId).isResolved = isResolved;
}
export function setTitle(state: State, documentId: string, title: string): void {
  const document = get(state.documents, documentId);
  if (title.trim()) document.userTitle = title.trim();
  else delete document.userTitle;
}
export async function openStore(directory: string, owner: Owner): Promise<Store> {
  ownerKey(owner);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'state.json');
  let state = createState(owner);
  let raw: string | undefined;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (raw !== undefined) {
    const value: unknown = JSON.parse(raw);
    const parsed = readSavedState(value);
    if (ownerKey(parsed.owner) !== ownerKey(owner)) throw new Error('State belongs to another owner');
    if (isObject(value) && value.version === 1) {
      const backup = join(directory, 'state.v1.backup.json');
      try { await writeFile(backup, raw, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        const saved: unknown = JSON.parse(await readFile(backup, 'utf8'));
        if (!isObject(saved) || saved.version !== 1 || ownerKey(readSavedState(saved).owner) !== ownerKey(owner)) throw new Error('Invalid migration backup; the existing state was preserved');
      }
    }
    for (const request of Object.values(parsed.requests)) if (request.status === 'claimed') request.status = 'uncertain';
    for (const thread of Object.values(parsed.threads)) thread.createdAt ??= thread.messages[0]?.createdAt ?? Date.now();
    for (const document of Object.values(parsed.documents)) ensureGeneralThread(parsed, document.id);
    state = parsed;
  }
  async function persist(next: State): Promise<void> {
    const temporary = join(directory, `state-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  await persist(state);
  let pending: Promise<void> = Promise.resolve();
  return {
    read: () => structuredClone(state),
    update<T>(change: (draft: State) => T): Promise<T> {
      const operation = pending.then(async () => {
        const draft = structuredClone(state);
        const result = change(draft);
        await persist(draft);
        state = structuredClone(draft);
        return structuredClone(result);
      });
      pending = operation.then(() => {}, () => {});
      return operation;
    },
  };
}
