import { createViewerHost, bodyOf, json, sendBody, type ViewerContext } from './viewer-http.ts';
import { viewerHtml, serveViewerAsset } from './viewer-assets.ts';
import { openAgentIds, isAgentAlias, type IdKind } from './agent-ids.ts';
import { compactNotification, compactContext } from './agent-protocol.ts';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, join, dirname, relative, isAbsolute, extname } from 'node:path';
import { notifyCodex } from './agent.ts';
import { reconcileCodexQueue } from './codex-queue.ts';
import { observeCodex, readCodexControl, resetCodexSession, type CodexObserver, type NativeResetResult, type NativeControl } from './codex-stream.ts';
import { ReplyStream, ThreadReplyRouter, isStreamEvent, findReplyBlocks } from './stream.ts';
import { parseReply } from './reply-metadata.ts';
import { readDocument } from './documents.ts';
import { prepareProposal } from './proposals.ts';
import { createProposalService } from './proposal-service.ts';
import { saveDocumentVersion } from './snapshots.ts';
import { readAppVersion } from './version.ts';
import { readTunnelConfig } from './tunnel-config.ts';
import { libraryDocument, listLibrary, recordDocumentOpen, closeLibraryDocument, cleanupClosedDocument } from './library.ts';
import { listFiles, readCode, readPreview } from './files.ts';
import { claim, createThread, closeDocument, discardEmptyThread, nameThread, pinMessage, DomainError, get, isObject, isQuote, isRepoInfo, openStore, ownerKey, registerDocument, reply, recordProgress, resolveThread, reanchorSelection, setSelectionVisibility, setTitle, submit, type DocumentRecord, type Owner, type SubmitInput, type ReplyInput } from './store.ts';
import { isPinStyle } from './pin-style.ts';
import { stopRequest, prepareBatch, requestBatch, setMessageSelectionVisibility, type State } from './store.ts';
import { isMessageQuote, isFileQuote } from './quote.ts';

type DocumentData = Awaited<ReturnType<typeof readDocument>>;
type Cached = { data: DocumentData } | { error: string; status: number };
export type ServerOptions = { owner: Owner; directory: string; stateRoot: string; port?: number; pollMs?: number };
function errorInfo(error: unknown): { error: string; status: number } {
  if (error instanceof DomainError) return { error: error.message, status: error.status };
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { error: 'The registered file is unavailable', status: 404 };
  return { error: error instanceof Error ? error.message : 'Unexpected server error', status: 500 };
}
function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new DomainError(`Expected ${key} to be text`);
  return value;
}
function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  return body[key] === undefined ? undefined : text(body, key);
}
function boolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') throw new DomainError(`Expected ${key} to be a boolean`);
  return value;
}
function markAccepted(state: State, id: string, nativeTurnId?: string) {
  for (const request of requestBatch(state, id)) {
    request.acceptedAt ??= Date.now();
    if (['claimed', 'queued', 'uncertain'].includes(request.status)) {
      request.handoff = 'accepted';
      if (nativeTurnId) request.nativeTurnId = nativeTurnId;
    }
  }
}
function requestContext(state: State, id: string) {
  const requests = requestBatch(state, id), request = get(state.requests, id), thread = get(state.threads, request.threadId);
  const questions = thread.messages.filter(message => message.role === 'user');
  const previous = questions[questions.findIndex(message => message.requestId === requests[0].id) - 1];
  const messages = requests.map(request => ({
    requestId: request.id, text: request.text,
    ...(request.quote ? { quote: { exact: request.quote.exact, ...(request.quote.sentence ? { sentence: request.quote.sentence } : {}) } } : {}),
    ...(request.messageQuote ? { messageQuote: request.messageQuote } : {}),
    ...(request.fileQuote ? { fileQuote: request.fileQuote } : {}),
  }));
  const { requestId: _, ...single } = messages[0];
  return { documentId: request.documentId, thread: { id: thread.id, lastRequestId: previous?.requestId ?? null, ...(thread.title ? { title: thread.title } : {}) }, ...(request.covers?.length ? { covers: request.covers } : {}), ...(messages.length > 1 ? { messages } : single) };
}
export async function startServer({ owner, directory, stateRoot, port = 0, pollMs = 1000 }: ServerOptions) {
  const ids = await openAgentIds(stateRoot), key = ownerKey(owner);
  await ids.allocate(key, []);
  const ownerAlias = ids.encode(key, 'o', key);
  const resolveId = async (kind: IdKind, value: string) => isAgentAlias(value, kind) ? ids.resolve(key, kind, value) : value;
  const appVersion = await readAppVersion();
  const store = await openStore(directory, owner);
  const browsingRoots = new Map<string, Set<string>>();
  directory = await realpath(directory);
  const tokenPath = join(directory, 'agent-token');
  try { await writeFile(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const agentToken = (await readFile(tokenPath, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(agentToken)) throw new Error('Invalid agent capability file');
  const cookieName = `sidecar_${ownerKey(owner).replaceAll('-', '_')}`;
  const cache = new Map<string, Cached>();
  const documentReads = new Set<{ documentId: string; done: Promise<void> }>();
  const viewers = new Map<ServerResponse, boolean>();
  let stateRevision = 0, runtimeRevision = 0, sentRuntimeRevision = 0, lastRuntime = '';
  const agents = new Map<ServerResponse, Set<string>>();
  let url = '';
  let closed = false;
  let refreshing = false;
  let closePromise: Promise<void> | undefined;
  const instanceId = randomUUID();
  const transportAbort = new AbortController();
  const announced = new Set<string>();
  let dispatching = false;
  let dispatchWork: Promise<void> | undefined;
  let nativeQueueWork: Promise<void> | undefined;
  let nativeCleanupVersion = 0, nativeCleanedVersion = 0;
  const pendingNativeCleanup = new Set<string>();
  let connectionError: string | null = null;
  let compacting = false, claudeProtocolAt = 0, nativeDeliveryAt = 0;
  const nativeDelivery = () => nativeDeliveryAt > Date.now() - 2500;
  const compactCapable = (requested: boolean) => requested && (owner.agent === 'codex' || claudeProtocolAt > Date.now() - 2500);
  async function deliveryFormat(id: string, requested = false) {
    const previous = await ids.deliveryFormat(key, id);
    if (previous) return previous;
    const record = get(store.read().requests, id);
    const format = compactCapable(requested) && record.status === 'queued' && !record.handoff && !record.acceptedAt ? 'compact-v1' : 'legacy';
    await ids.allocate(key, [], { requestId: id, format });
    return format;
  }
  async function wire(event: Record<string, unknown>) {
    return typeof event.requestId === 'string' && await ids.deliveryFormat(key, event.requestId) === 'compact-v1' ? compactNotification(owner, event, ids) : event;
  }
  async function replyStream(route: import('./stream.ts').ReplyRoute) {
    const compact = await ids.deliveryFormat(key, route.requestId) === 'compact-v1';
    return new ReplyStream(route, true, compact ? ids.encode(key, 'r', route.requestId) : undefined);
  }
  let agentActivity = 'unknown';
  let activityTurnId: string | undefined;
  let stream: ReplyStream | undefined;
  const streams = new Map<string, ReplyStream>(), replyRouter = new ThreadReplyRouter();
  let codexControl: NativeControl = { activity: 'unknown' };
  let directRequestId: string | undefined;
  let streamReady: Promise<void> | undefined;
  let stopObserver: CodexObserver | undefined;
  let streamTimer: NodeJS.Timeout | undefined;
  let finalizing: Promise<void> | undefined;
  let captureWork: Promise<unknown> = Promise.resolve();
  const proposalService = createProposalService({ store, directory, changed: () => { if (url) changed(); } });
  function capture<T>(work: () => Promise<T>): Promise<T> {
    const next = captureWork.then(work);
    captureWork = next.catch(() => {});
    return next;
  }
  let claudeControl: { turnId: string; seenAt: number; requestId?: string } | undefined;
  let stopping: { stream?: ReplyStream; turnId: string; timer: NodeJS.Timeout } | undefined;
  let stopAttempt: { stream: ReplyStream; turnId: string } | undefined;
  let stopError: string | undefined;
  let reset: { id: string; status: 'checking' | 'interrupting' | 'done' | 'failed'; error?: string; turnId?: string; confirm: (result: NativeResetResult) => void; reject: (error: Error) => void } | undefined;
  let resetWork: Promise<void> | undefined;
  const isResetting = () => reset?.status === 'checking' || reset?.status === 'interrupting';
  const controlTurn = (active = stream) => active ? store.read().requests[active.route.requestId]?.nativeTurnId ?? (owner.agent === 'codex' ? active.turnId : claudeControl?.requestId === active.route.requestId ? claudeControl.turnId : undefined) : undefined;
  const nativeTurn = () => owner.agent === 'codex' ? codexControl.turnId : claudeControl && claudeControl.seenAt > Date.now() - 2500 && agentActivity !== 'idle' ? claudeControl.turnId : undefined;
  const agentCanStop = () => !isResetting() && !!nativeTurn() && ['busy', 'waiting'].includes(agentActivity);
  function canStop(active = stream) {
    const turnId = controlTurn(active);
    return !isResetting() && !!active && !!turnId && !active.done && get(store.read().requests, active.route.requestId).status === 'claimed' &&
      (owner.agent === 'codex' ? active.isTurnActive && !!stopObserver?.canInterrupt(turnId) : !!claudeControl && Date.now() - claudeControl.seenAt < 2500);
  }
  function clearStop(forget = false) { clearTimeout(stopping?.timer); stopping = undefined; if (forget) stopAttempt = undefined; }
  function stopFailed(active?: ReplyStream) {
    if (!stopping || active && stopping.stream !== active) return;
    clearStop(); stopError = 'Stopping was not confirmed. The request may still be running.'; changed();
  }
  async function turnEnded(active: ReplyStream, turnId: string, status: string, answer?: string) {
    const matches = controlTurn(active) === turnId || (stopAttempt?.stream === active && stopAttempt.turnId === turnId);
    if (streams.get(active.route.requestId) !== active || !matches) return;
    active.endTurn(active.turnId ?? turnId);
    // Native completion is authoritative even when display hooks are late.
    if (answer?.startsWith(active.prefix) && answer.trimEnd().endsWith(active.suffix)) {
      await acceptStream({ messageId: `native-final:${turnId}`, turnId, index: 0, delta: answer, final: true });
      if (!streams.has(active.route.requestId)) return;
    }
    // The matched native turn may have been interrupted from the terminal too.
    if (status === 'interrupted') {
      if (active.done) { stopFailed(active); return; }
      // Claude's display hooks can still be in flight; the native turn has the final partial text.
      if (answer) active.recoverPartial(answer);
      const partial = active.text;
      if (finalizing) await finalizing.catch(() => {});
      if (!streams.has(active.route.requestId)) return;
      try {
        await store.update(state => stopRequest(state, active.route.requestId, partial));
        if (owner.agent === 'codex') { nativeCleanupVersion++; pendingNativeCleanup.add(active.route.requestId); }
        retireStreams();
        if (stopping?.turnId === turnId) { clearStop(true); stopError = undefined; }
      } catch { stopFailed(active); }
    } else {
      if (stopping?.stream === active) stopFailed(active);
      // A native turn may yield while delegated work is still pending.
      if (status === 'completed' && !active.hasFinalStarted && !active.error && !store.read().requests[active.route.requestId]?.replyRecovery) return;
      active.fail('Reply could not be saved.');
      await store.update(state => {
        const request = get(state.requests, active.route.requestId);
        if (request.status !== 'claimed' || request.replyRecovery?.turnId === turnId) return;
        request.replyRecovery = { id: request.replyRecovery?.id ?? randomUUID(), turnId,
          status: !request.replyRecovery && status === 'completed' ? 'pending' : 'failed' };
      });
    }
    changed();
  }
  function retireStreams() {
    const state = store.read();
    for (const [id] of streams) if (!state.requests[id] || ['completed', 'failed', 'stopped'].includes(state.requests[id].status)) streams.delete(id);
    if (stream && !streams.has(stream.route.requestId)) stream = [...streams.values()].find(s => s.text) ?? streams.values().next().value;
  }
  async function nativeEnded(turnId: string, status: string, answer?: string) {
    // ID-only handoffs can be interrupted before the agent fetches/claims them.
    // They still belong to this confirmed turn, even without a reply parser yet.
    for (const request of Object.values(store.read().requests)) {
      if (request.nativeTurnId !== turnId || request.batchId !== request.id || streams.has(request.id) || !['queued', 'claimed', 'uncertain'].includes(request.status)) continue;
      await store.update(state => claim(state, request.id, { resume: true }));
      const active = await replyStream({ requestId: request.id, documentId: request.documentId, threadId: request.threadId });
      streams.set(request.id, active); stream ??= active;
    }
    if (answer) for (const block of findReplyBlocks(answer, streams)) {
      if (!answer.startsWith(block.stream.prefix, block.start)) continue;
      if (block.end !== null)
        await acceptReply(block.stream, { messageId: `native-final:${turnId}:${block.start}`, turnId, index: 0, delta: answer.slice(block.start, block.end), final: true });
      else if (controlTurn(block.stream) === turnId) block.stream.recoverPartial(answer.slice(block.start));
    }
    for (const active of [...streams.values()]) await turnEnded(active, turnId, status, answer);
    replyRouter.endTurn(turnId);
    if (stopping?.turnId === turnId) { clearStop(true); stopError = undefined; }
    if (owner.agent === 'codex' && codexControl.turnId === turnId) { codexControl = { activity: 'idle' }; agentActivity = 'idle'; }
    if (owner.agent === 'claude' && claudeControl?.turnId === turnId) { claudeControl = undefined; agentActivity = 'idle'; }
    runtimeChanged();
  }
  function startAgentStop(turnId: string) {
    if (stopping?.turnId === turnId) return;
    if (!agentCanStop() || nativeTurn() !== turnId) throw new DomainError('The attached agent has no matching active turn. Stop was not sent.', 409);
    stopError = undefined;
    stopping = { turnId, timer: setTimeout(() => stopFailed(), 10000) };
    if (owner.agent === 'codex') void resetCodexSession(owner.sessionId, AbortSignal.any([transportAbort.signal, AbortSignal.timeout(10000)]), undefined, turnId)
      .then(result => capture(() => nativeEnded(turnId, 'interrupted', result.answer))).catch(() => { if (stopping?.turnId === turnId) stopFailed(); });
    runtimeChanged();
  }
  function startReset() {
    if (isResetting()) throw new DomainError('Reset is already in progress', 409);
    let confirm!: (result: NativeResetResult) => void, reject!: (error: Error) => void;
    const confirmation = new Promise<NativeResetResult>((resolve, fail) => { confirm = resolve; reject = fail; });
    // Codex uses its native socket; keep the Claude confirmation rejection handled too.
    void confirmation.catch(() => {});
    const attempt = { id: randomUUID(), status: 'checking' as const, confirm, reject };
    reset = attempt;
    const inFlight = Promise.all([dispatchWork, nativeQueueWork]);
    resetWork = (async () => {
      const abort = new AbortController();
      const cancel = () => { abort.abort(); reject(new Error('Could not verify the attached session. Reconnect it and try Reset again.')); };
      const timer = setTimeout(cancel, 10000);
      transportAbort.signal.addEventListener('abort', cancel, { once: true });
      try {
        await inFlight;
        const requests = Object.values(store.read().requests);
        const targets = requests.filter(r => (!r.batchId || r.batchId === r.id) && (['claimed', 'uncertain'].includes(r.status) || (r.status === 'queued' && r.acceptedAt))).map(r => r.id);
        if (owner.agent === 'codex') {
          // Withdraw native deliveries before interrupting: otherwise an old queued
          // submission can start after Sidecar has already marked it Stopped.
          const cancelled = [...new Set([...targets, ...terminalCodexRequests()])];
          await reconcileCodexQueue(owner.sessionId, { cancelRequestIds: cancelled, agentIds: ids }, abort.signal);
        }
        const result = owner.agent === 'codex' ? await resetCodexSession(owner.sessionId, abort.signal) : await confirmation;
        await capture(async () => {
          if (closed || abort.signal.aborted) throw new Error('Reset could not be confirmed.');
          if (result.answer) for (const active of [...streams.values()]) {
            if (!targets.includes(active.route.requestId)) continue;
            const block = findReplyBlocks(result.answer, new Map([[active.route.requestId, active]]))[0];
            if (block?.end != null && result.answer.startsWith(active.prefix, block.start))
              await acceptReply(active, { messageId: `reset-final:${attempt.id}`, turnId: result.turnId ?? attempt.id, index: 0, delta: result.answer.slice(block.start, block.end), final: true });
            else if (block) active.recoverPartial(result.answer.slice(block.start));
          }
          if ([...streams.values()].some(active => active.done)) throw new Error('The completed reply could not be saved. Retry saving it before Reset.');
          await store.update(state => {
            for (const id of targets) {
              const request = state.requests[id];
              if (!request || !(['claimed', 'uncertain'].includes(request.status) || (request.status === 'queued' && request.acceptedAt))) continue;
              // Explicit Reset also releases a delivery left uncertain by an app restart.
              for (const member of requestBatch(state, id)) { member.status = 'claimed'; delete member.replyRecovery; }
              stopRequest(state, id, streams.get(id)?.text ?? '');
            }
          });
          retireStreams(); clearStop(true); stopError = undefined;
          if (result.turnId) replyRouter.endTurn(result.turnId);
          if (reset === attempt) reset.status = 'done';
          connectionError = null;
        });
      } catch (error) {
        if (reset === attempt) { reset.status = 'failed'; reset.error = error instanceof Error ? error.message : 'Reset failed.'; }
      } finally {
        clearTimeout(timer); transportAbort.signal.removeEventListener('abort', cancel); changed();
      }
    })();
    changed();
  }
  async function saveVersion(documentId: string, data: DocumentData) {
    await saveDocumentVersion(directory, documentId, data);
  }
  async function saveReply(input: ReplyInput) {
    return proposalService.withDocument(input.documentId, () => saveReplyLocked(input));
  }
  async function saveReplyLocked(input: ReplyInput) {
    const state = store.read(), request = get(state.requests, input.requestId);
    if (request.documentId !== input.documentId || request.threadId !== input.threadId) throw new DomainError('Reply routing does not match the request', 409);
    if (request.answeredBy) return;
    if (!request.answer && input.metadata?.highlights?.length) {
      const highlights = input.metadata.highlights;
      let data: DocumentData | undefined;
      try { data = await readDocument(get(state.documents, input.documentId).path); }
      catch (error) {
        // A proposal that cannot be prepared still belongs to a valid answer.
        if (!highlights.some(h => h.proposal || h.proposalError)) throw error;
      }
      if (data) await saveVersion(input.documentId, data);
      input.selectionVersion = data?.version ?? '';
      input.proposalTargets = highlights.map(h => h.proposal ? prepareProposal(data?.markdown ?? null, data?.version ?? null, h.proposal) : null);
    }
    await store.update(state => reply(state, input));
    // Do not wait for dispatch here: recovery preparation also uses the capture
    // queue. Reconcile after any in-flight native enqueue has settled instead.
    if (owner.agent === 'codex') { nativeCleanupVersion++; pendingNativeCleanup.add(input.requestId); }
  }
  function streamChanged() { if (!closed && !streamTimer) streamTimer = setTimeout(() => { streamTimer = undefined; runtimeChanged(); }, 50); }
  async function acceptStream(event: import('./stream.ts').StreamEvent) {
    if (closed) return;
    for (const part of replyRouter.accept(event, streams, owner.agent === 'claude' ? nativeTurn() : event.turnId)) await acceptReply(part.stream, part.event);
  }
  async function acceptReply(active: ReplyStream, event: import('./stream.ts').StreamEvent) {
    if (!streams.has(active.route.requestId)) return;
    const progress = active.accept(event);
    if (active.hasStarted) stream = active;
    // Matching output is proof of receipt even if the handoff acknowledgement was lost.
    const received = store.read().requests[active.route.requestId];
    if (active.hasStarted && (!received?.acceptedAt || received.status === 'uncertain' || owner.agent === 'codex' && received.nativeTurnId !== event.turnId)) {
      await store.update(state => {
        for (const member of requestBatch(state, active.route.requestId)) if (member.status === 'uncertain') member.status = 'claimed';
        markAccepted(state, active.route.requestId, owner.agent === 'codex' ? event.turnId : nativeTurn());
      });
      changed();
    }
    if (progress) {
      try { await store.update(state => recordProgress(state, { ...active.route, ...progress })); }
      catch { active.fail('Could not save the progress update. Send a complete reply to recover.'); }
      changed();
      return;
    }
    streamChanged();
    if (active.done && !finalizing) {
      finalizing = (async () => {
        await saveReply({ ...active.route, text: active.text, metadata: active.metadata });
        retireStreams();
      })();
      try { await finalizing; }
      catch { active.error = 'Could not save the streamed reply. Send a complete reply to recover.'; changed(); }
      finally { finalizing = undefined; changed(); }
    }
  }
  let lastLifecycle: { event: string; turnId?: string } | null = null;
  let finish!: () => void;
  const done = new Promise<void>(resolveDone => { finish = resolveDone; });
  function title(document: DocumentRecord): string {
    const cached = cache.get(document.id);
    return document.userTitle ?? document.providedTitle ?? (cached && 'data' in cached ? cached.data.heading : null) ?? basename(document.path);
  }
  async function refresh(document: DocumentRecord): Promise<Cached> {
    let result: Cached;
    try { result = { data: await readDocument(document.path) }; }
    catch (error) { result = errorInfo(error); }
    const previous = cache.get(document.id);
    const oldKey = previous && ('data' in previous ? previous.data.version : previous.error);
    const newKey = 'data' in result ? result.data.version : result.error;
    if (!Object.hasOwn(store.read().documents, document.id)) return result;
    cache.set(document.id, result);
    if (oldKey !== newKey) {
      changed();
      // Keep tracked viewer reads outside the document queue: close waits for
      // those reads before removing snapshots, so awaiting this here deadlocks.
      if ('data' in result) void proposalService.revalidate(document.id).catch(() => {});
    }
    return result;
  }
  function pending() {
    const requests = Object.values(store.read().requests);
    return requests.find(r => (!r.batchId || r.batchId === r.id) && (r.status === 'queued' || r.status === 'uncertain' && !r.replyRecovery && r.handoff !== 'uncertain') && !r.acceptedAt && (owner.agent !== 'codex' || !announced.has(r.id)));
  }
  function pendingRecovery() {
    return Object.values(store.read().requests).find(r => r.status === 'claimed' && r.replyRecovery?.status === 'pending');
  }
  async function recoveryFailed(id: string, recoveryId: string) {
    await store.update(state => {
      const request = state.requests[id];
      if (request?.status === 'claimed' && request.replyRecovery?.id === recoveryId) request.replyRecovery.status = 'failed';
    });
    changed();
  }
  function notifyAgent(response: ServerResponse, sent: Set<string>) {
    if (isResetting() || stopping || nativeDelivery()) return;
    const recovering = pendingRecovery();
    if (recovering?.replyRecovery && !sent.has(recovering.replyRecovery.id) && !response.destroyed) {
      response.write(JSON.stringify({ type: 'sidecar.recovery', ownerKey: ownerKey(owner), requestId: recovering.id, recoveryId: recovering.replyRecovery.id }) + '\n');
      sent.add(recovering.replyRecovery.id);
      return;
    }
    const request = pending();
    if (request && !sent.has(request.id) && !response.destroyed) {
      response.write(JSON.stringify({ type: 'sidecar.request', ownerKey: ownerKey(owner), requestId: request.id }) + '\n');
      sent.add(request.id);
    }
  }
  async function dispatchCodex() {
    if (closed || owner.agent !== 'codex' || dispatching || isResetting() || stopping) return;
    const recovering = pendingRecovery();
    if (recovering?.replyRecovery) {
      dispatching = true;
      const { id } = recovering.replyRecovery;
      try {
        const event = await prepareRecovery(recovering.id, id);
        if (event.type && !closed && get(store.read().requests, recovering.id).status === 'claimed') {
          await deliverCodex(recovering.id, event, id);
        }
      } catch {
        await recoveryFailed(recovering.id, id);
      } finally { dispatching = false; changed(); }
      return;
    }
    const request = pending();
    if (!request || announced.has(request.id)) return;
    dispatching = true; announced.add(request.id);
    try {
      const notification = await prepareNotification(request.id, true);
      if ('claimStatus' in notification && notification.claimStatus !== 'claimed') return;
      if (closed) return;
      await deliverCodex(request.id, notification);
      connectionError = null;
    } catch (error) {
      if (!closed) {
        // A failed queue command may already have delivered. Do not automatically execute it twice.
        await store.update(state => {
          const current = state.requests[request.id];
          if (current?.status === 'claimed') for (const member of requestBatch(state, current.id)) { member.status = error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'queued' : 'uncertain'; member.handoff = 'uncertain'; }
        });
        if (directRequestId === request.id) directRequestId = undefined;
        connectionError = 'Codex delivery could not be confirmed. The question is retained for reconciliation; it was not sent again.';
      }
    } finally { dispatching = false; changed(); }
  }
  async function deliverCodex(id: string, notification: Record<string, unknown>, inputId = id) {
    codexControl = await readCodexControl(owner.sessionId, transportAbort.signal);
    agentActivity = codexControl.activity; runtimeChanged();
    const turnId = codexControl.turnId;
    if (turnId) await ensureObserver();
    await store.update(state => {
      const request = get(state.requests, id);
      request.handoff = 'sending';
      if (turnId) request.nativeTurnId = turnId;
      else delete request.nativeTurnId;
    });
    if (turnId && stopObserver && await stopObserver.steer(turnId, notification, inputId) === 'accepted') {
      await store.update(state => markAccepted(state, id, turnId)); return;
    }
    // No input was steered. Native queueing retains ordinary terminal ordering.
    await store.update(state => { delete get(state.requests, id).nativeTurnId; });
    await notifyCodex(owner, notification, transportAbort.signal);
    await store.update(state => markAccepted(state, id));
    await startCodexDelivery(id);
  }
  function waitingCodexDelivery() {
    if (owner.agent !== 'codex') return;
    return Object.values(store.read().requests).find(r => (!r.batchId || r.batchId === r.id) && ['queued', 'claimed'].includes(r.status) && r.acceptedAt && !r.nativeTurnId);
  }
  function terminalCodexRequests() {
    // Closing a document can remove its saved requests while a recovery enqueue
    // is finishing. Retain those identities until native withdrawal succeeds.
    return [...new Set([...pendingNativeCleanup, ...Object.values(store.read().requests).filter(r => ['completed', 'failed', 'stopped'].includes(r.status)).map(r => r.id)])];
  }
  async function startCodexDelivery(id?: string) {
    if (closed || isResetting() || stopping || nativeQueueWork) return;
    const request = id ? store.read().requests[id] : undefined;
    const canStart = () => !closed && !isResetting() && !!id && ['queued', 'claimed', 'uncertain'].includes(store.read().requests[id]?.status);
    const startRequestId = request && canStart() ? id : undefined;
    const cancelRequestIds = terminalCodexRequests(), cleanupVersion = nativeCleanupVersion;
    if (!startRequestId && !cancelRequestIds.length) return;
    nativeQueueWork = (async () => {
      try {
        const turnId = await reconcileCodexQueue(owner.sessionId, { startRequestId, cancelRequestIds, canStart, agentIds: ids }, transportAbort.signal);
        if (turnId && startRequestId) await store.update(state => { if (state.requests[startRequestId]) markAccepted(state, startRequestId, turnId); });
        nativeCleanedVersion = cleanupVersion;
        for (const requestId of cancelRequestIds) pendingNativeCleanup.delete(requestId);
        if (connectionError?.startsWith('Codex accepted')) { connectionError = null; changed(); }
      } catch {
        // Delivery already succeeded. Never submit the message again because the
        // subsequent start/check failed or raced with another native turn.
        if (!closed) { connectionError = 'Codex accepted the message, but its queue could not be started. Reconnect the agent or try Reset.'; changed(); }
      }
    })();
    try { await nativeQueueWork; } finally { nativeQueueWork = undefined; }
  }
  function runtimeSnapshot() {
    const runtime = { stateRevision, reset: reset ? { status: reset.status, error: reset.error } : null,
      agentControl: { turnId: nativeTurn(), canStop: agentCanStop(), stopping: !!stopping, error: stopError },
      stream: stream ? { ...stream.snapshot(), turnId: controlTurn(), canStop: canStop(), stopping: stopping?.stream === stream, stopError } : null,
      streams: [...streams.values()].filter(active => active.hasStarted).map(active => active.snapshot()),
      lastLifecycle, activity: compacting ? 'compacting' : agentActivity,
      connection: connectionError ? 'error' : agents.size || nativeDelivery() ? 'connected' : 'waiting', connectionError };
    const encoded = JSON.stringify(runtime);
    if (encoded !== lastRuntime) { lastRuntime = encoded; runtimeRevision++; }
    return { ...runtime, runtimeRevision };
  }
  function runtimeChanged() {
    if (closed) return;
    const runtime = runtimeSnapshot();
    if (runtime.runtimeRevision === sentRuntimeRevision) return;
    sentRuntimeRevision = runtime.runtimeRevision;
    const event = `event: runtime\ndata: ${JSON.stringify(runtime)}\n\n`;
    for (const [response, supportsRuntime] of viewers) if (!response.destroyed)
      response.write(supportsRuntime ? event : 'event: change\ndata: {}\n\n');
  }
  function changed() {
    if (closed) return;
    clearTimeout(streamTimer); streamTimer = undefined;
    stateRevision++;
    runtimeChanged();
    for (const response of viewers.keys()) if (!response.destroyed) response.write('event: change\ndata: {}\n\n');
    for (const [response, sent] of agents) notifyAgent(response, sent);
    if (!dispatching) dispatchWork = dispatchCodex();
  }
  function snapshot() {
    const state = store.read();
    // Show Working once native delivery succeeds; reserving the request alone is still Queued.
    for (const delivered of Object.values(state.requests)) if ((!delivered.batchId || delivered.batchId === delivered.id) && delivered.handoff === 'prepared' && delivered.status === 'claimed' && !delivered.replyRecovery && !delivered.acceptedAt && !streams.get(delivered.id)?.hasStarted) for (const member of requestBatch(state, delivered.id)) member.status = 'queued';
    for (const request of Object.values(state.requests)) if (request.status === 'queued' && request.acceptedAt) request.status = 'claimed';
    return { ...state, appVersion, ...runtimeSnapshot(), documents: Object.fromEntries(Object.values(state.documents).map(document => {
      const cached = cache.get(document.id);
      return [document.id, { ...document, title: title(document), version: cached && 'data' in cached ? cached.data.version : null, error: cached && 'error' in cached ? cached.error : null }];
    })) };
  }
  async function documentContext(document: DocumentRecord) {
    const result = await refresh(document);
    return 'data' in result ? { id: document.id, path: document.path, title: title(document), ...result.data } : { id: document.id, path: document.path, title: title(document), error: result.error };
  }
  async function startReplyStream(route: import('./stream.ts').ReplyRoute) {
    const state = store.read(); requestBatch(state, route.requestId);
    const current = get(state.requests, route.requestId);
    if (current.status !== 'claimed' || current.documentId !== route.documentId || current.threadId !== route.threadId) throw new DomainError('Claim the matching request before streaming', 409);
    let active = streams.get(current.id);
    if (!active) { active = await replyStream(route); streams.set(current.id, active); stream ??= active; }
    try { await ensureObserver(); }
    catch (error) { active.fail('Streaming unavailable. Use a complete reply.'); changed(); throw error; }
    if (closed) throw new Error('Sidecar stopped');
    return { prefix: active.prefix, suffix: active.suffix, progress: active.progress };
  }
  async function ensureObserver() {
    if (owner.agent === 'codex' && !streamReady) {
      streamReady = (async () => {
        const stop = await observeCodex(owner.sessionId, event => { void capture(() => acceptStream(event)); }, message => {
          for (const active of streams.values()) active.fail(message);
          stopObserver = undefined; streamReady = undefined; stopFailed(); changed();
        }, undefined, undefined, (turnId, status, answer) => { void capture(() => nativeEnded(turnId, status, answer)); });
        if (closed) { stop(); throw new Error('Sidecar stopped'); }
        stopObserver = stop;
      })();
      void streamReady.catch(() => { streamReady = undefined; });
    }
    await streamReady;
  }
  function prepareNotification(id: string, compact = false) { return capture(() => reserveNotification(id, compact)); }
  async function reserveNotification(id: string, compact = false) {
    await deliveryFormat(id, compact);
    if (isResetting()) throw new DomainError('Agent Reset is in progress', 409);
    const notification = { type: 'sidecar.request', ownerKey: ownerKey(owner), requestId: id };
    const prepared = await store.update(state => {
      const request = get(state.requests, id);
      if (request.replyRecovery && ['claimed', 'uncertain'].includes(request.status)) return { claimStatus: 'reply-recovery' };
      if (request.status === 'uncertain') return {};
      if (request.status !== 'queued') return { claimStatus: request.status === 'claimed' ? 'already-claimed' : 'completed' };
      prepareBatch(state, id);
      const context = requestContext(state, id);
      // ponytail: large contexts retain the fetch path; avoid OS argument and native watcher output limits.
      if (Buffer.byteLength(JSON.stringify(context)) > 48 * 1024) return {};
      const result = claim(state, id, {});
      request.handoff = 'prepared';
      return { claimStatus: result.claimStatus, context: requestContext(state, id) };
    });
    if (!prepared.context) return wire({ ...notification, ...(prepared.claimStatus ? { claimStatus: prepared.claimStatus } : {}) });
    const request = get(store.read().requests, id);
    directRequestId = id;
    const route = { requestId: id, documentId: request.documentId, threadId: request.threadId };
    let markers: { prefix: string; suffix: string } | { error: string };
    try { markers = await startReplyStream(route); }
    catch { markers = { error: 'Streaming unavailable. Use the complete-reply command.' }; }
    if (get(store.read().requests, id).status !== 'claimed') return { ...notification, claimStatus: 'completed' };
    changed();
    return wire({ ...notification, ...prepared.context, stream: markers, instruction: 'Follow the Sidecar skill.' });
  }
  function prepareRecovery(id: string, recoveryId: string): Promise<Record<string, unknown>> {
    // Do not hand off a recovery while an earlier final answer is still saving.
    return capture(() => reserveRecovery(id, recoveryId));
  }
  async function reserveRecovery(id: string, recoveryId: string): Promise<Record<string, unknown>> {
    if (isResetting()) throw new DomainError('Agent Reset is in progress', 409);
    const reserved = await store.update(state => {
      const request = get(state.requests, id);
      if (!['claimed', 'uncertain'].includes(request.status)) return false;
      if (request.replyRecovery?.id !== recoveryId) throw new DomainError('This recovery has been replaced', 409);
      if (request.replyRecovery.status !== 'pending') return false;
      claim(state, id, { resume: true });
      request.replyRecovery.status = 'sent';
      return true;
    });
    if (!reserved) return { claimStatus: 'completed-or-delivered' };
    const request = get(store.read().requests, id);
    let markers: unknown;
    try {
      markers = await startReplyStream({ requestId: id, documentId: request.documentId, threadId: request.threadId });
      const active = streams.get(id);
      if (active?.done && active.error) markers = { error: 'Use the complete-reply command.' };
    }
    catch { markers = { error: 'Use the complete-reply command.' }; }
    if (closed || get(store.read().requests, id).status !== 'claimed') return { claimStatus: 'completed' };
    changed();
    return wire({ type: 'sidecar.recovery', ownerKey: ownerKey(owner), requestId: id, recoveryId,
      documentId: request.documentId, thread: { id: request.threadId }, stream: markers,
      instruction: 'Follow the Sidecar skill. Reply recovery only: resend the existing answer using these exact markers. Do not repeat the original task, tools, or edits. If you cannot recover the answer, send an isError reply explaining that. Leave later queued messages for their own delivery.' });
  }
  async function closeRegisteredDocument(id: string) {
    return proposalService.withDocument(id, async () => {
      const threadIds = await store.update(state => closeDocument(state, id));
      // Finish reads that started before deletion so none can recreate a removed snapshot.
      await Promise.allSettled([...documentReads].filter(reading => reading.documentId === id).map(reading => reading.done));
      const cleanup = await cleanupClosedDocument(directory, id);
      cache.delete(id);
      browsingRoots.delete(id);
      const result = { documentId: id, threadIds, nextDocumentId: Object.keys(store.read().documents)[0] ?? null, ...cleanup };
      for (const viewer of viewers.keys()) if (!viewer.destroyed) viewer.write(`event: document-closed\ndata: ${JSON.stringify(result)}\n\n`);
      changed(); return result;
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse, context: ViewerContext) {
    const { target, method, origin, isAgent } = context, isLan = !context.isLocal;
    let { path } = context;
    try {
      if (closed) throw new DomainError('Sidecar is stopping. Reopen it from your agent.', 503);
      if (method === 'GET' && path === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(await viewerHtml()); return; }
      if (await serveViewerAsset(path, method, response)) return;
      if (method === 'GET' && path === '/api/image') {
        const key = target.searchParams.get('owner');
        const document = key
          ? await libraryDocument(dirname(directory), key, target.searchParams.get('document') ?? '')
          : get(store.read().documents, target.searchParams.get('document') ?? '');
        const base = dirname(document.path);
        const imageUrl = new URL(target.searchParams.get('path') ?? '', pathToFileURL(document.path));
        if (imageUrl.protocol !== 'file:') throw new DomainError('Expected a local image', 400);
        const imagePath = await realpath(fileURLToPath(imageUrl));
        const fromBase = relative(base, imagePath);
        if (fromBase.startsWith('..') || isAbsolute(fromBase)) throw new DomainError('Image must be inside the document directory', 403);
        const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };
        const mime = types[extname(imagePath).toLowerCase()];
        if (!mime) throw new DomainError('Unsupported image type', 415);
        // SVG remains an image even if opened directly; it cannot execute or fetch resources.
        response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
        response.setHeader('Content-Type', mime);
        response.end(await readFile(imagePath));
        return;
      }
      if (method === 'GET' && path === '/api/state') { json(response, snapshot()); return; }
      if (method === 'GET' && (path === '/api/network' || path === '/agent/network')) { json(response, host.networkStatus(!isLan)); return; }
      if (method === 'GET' && path === '/api/library') {
        const library = await listLibrary(dirname(directory));
        // Other owners have their own opt-in listener; never send a phone to its own localhost.
        if (isLan) for (const session of library.sessions) session.url = session.ownerKey === ownerKey(owner) ? origin : null;
        json(response, library); return;
      }
      if (method === 'GET' && (path === '/api/files' || path === '/api/files/content' || path === '/api/files/code')) {
        const document = get(store.read().documents, target.searchParams.get('document') ?? '');
        if (!document.workspace) throw new DomainError('This document has no recorded workspace. Reopen it from your agent.', 404);
        const root = target.searchParams.get('directory') ?? document.workspace;
        if (!isAbsolute(root) || root.includes('\0')) throw new DomainError('Expected an absolute directory path');
        if (root !== document.workspace && !browsingRoots.get(document.id)?.has(root))
          throw new DomainError('Open this folder in the file browser first', 403);
        const file = target.searchParams.get('path') ?? '';
        json(response, path === '/api/files' ? await listFiles(root)
          : path === '/api/files/code' ? await readCode(root, file)
          : await readPreview(root, file));
        return;
      }
      const libraryRead = path.match(/^\/api\/library\/([^/]+)\/documents\/([^/]+)$/);
      if (method === 'DELETE' && libraryRead) {
        json(response, libraryRead[1] === ownerKey(owner)
          ? await closeRegisteredDocument(libraryRead[2])
          : await closeLibraryDocument(dirname(directory), libraryRead[1], libraryRead[2]));
        return;
      }
      if (method === 'GET' && libraryRead) {
        const document = await libraryDocument(dirname(directory), libraryRead[1], libraryRead[2]);
        const content = await readDocument(document.path);
        json(response, { ...content, title: document.userTitle ?? document.providedTitle ?? content.heading ?? basename(document.path) }); return;
      }
      const openedDocument = path.match(/^\/api\/documents\/([^/]+)\/opened$/);
      if (method === 'POST' && openedDocument) {
        const document = get(store.read().documents, openedDocument[1]);
        await recordDocumentOpen(directory, document.id); json(response, { ok: true }); return;
      }
      const openedPreview = path.match(/^\/api\/library\/([^/]+)\/documents\/([^/]+)\/opened$/);
      if (method === 'POST' && openedPreview) {
        const document = await libraryDocument(dirname(directory), openedPreview[1], openedPreview[2]);
        await recordDocumentOpen(join(dirname(directory), openedPreview[1]), document.id); json(response, { ok: true }); return;
      }
      const original = path.match(/^\/api\/documents\/([^/]+)\/versions\/([a-f0-9]{64})$/);
      if ((method === 'GET' || method === 'HEAD') && original) {
        const document = get(store.read().documents, original[1]);
        try {
          const saved = await readDocument(join(directory, 'versions', document.id, `${original[2]}.md`));
          if (method === 'HEAD') response.end();
          else json(response, { ...saved, version: original[2] });
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            throw new DomainError('Original document unavailable. This version was not saved.', 404);
          throw error;
        }
        return;
      }
      if (method === 'GET' && path.startsWith('/api/documents/')) {
        const document = get(store.read().documents, path.slice('/api/documents/'.length));
        const reading = { documentId: document.id, done: (async () => {
          const result = await refresh(document);
          if ('error' in result) { json(response, { error: result.error }, result.status); return; }
          // Keep each version actually shown to a reader, including unsent passage drafts.
          // ponytail: retain viewed Markdown versions; add pruning if snapshot storage grows large.
          await saveVersion(document.id, result.data);
          json(response, { ...document, ...result.data, title: title(document) });
        })() };
        documentReads.add(reading);
        try { await reading.done; } finally { documentReads.delete(reading); }
        return;
      }
      const closingDocument = path.match(/^\/api\/documents\/([^/]+)$/);
      if (method === 'DELETE' && closingDocument) {
        json(response, await closeRegisteredDocument(closingDocument[1])); return;
      }

      if (method === 'GET' && (path === '/api/events' || path === '/agent/events')) {
        response.writeHead(200, { 'Content-Type': isAgent ? 'application/x-ndjson' : 'text/event-stream', Connection: 'keep-alive' });
        response.flushHeaders();
        if (isAgent) {
          const sent = new Set<string>(); agents.set(response, sent); notifyAgent(response, sent); changed();
          response.on('close', () => { agents.delete(response); changed(); });
        } else {
          const supportsRuntime = target.searchParams.get('updates') === '1';
          viewers.set(response, supportsRuntime);
          if (!supportsRuntime) response.write('event: change\ndata: {}\n\n');
          response.on('close', () => viewers.delete(response));
        }
        return;
      }
      if (method === 'GET' && path === '/api/tunnel-config') {
        if (isLan) throw new DomainError('Manage tunnel settings from the local viewer', 403);
        json(response, await readTunnelConfig()); return;
      }
      if (method === 'GET' && path === '/agent/status') { json(response, { ownerKey: ownerKey(owner), ownerAlias, agentProtocol: 'sc1', nativeDelivery: nativeDelivery(), instanceId, state: 'running', connection: connectionError ? 'error' : agents.size || nativeDelivery() ? 'connected' : 'waiting', connectionError }); return; }
      if (method === 'POST' && path === '/agent/stop') { json(response, { ok: true }); setImmediate(() => { void close(); }); return; }
      const body = ['POST', 'PATCH'].includes(method) ? await bodyOf(request) : {};
      const compact = request.headers['x-sidecar-protocol'] === 'sc1';
      if (isAgent) {
        const match = /^\/agent\/(requests|threads|documents)\/([^/]+)(.*)$/.exec(path);
        if (match) path = `/agent/${match[1]}/${await resolveId(match[1] === 'requests' ? 'r' : match[1] === 'threads' ? 't' : 'd', match[2])}${match[3]}`;
        for (const [field, kind] of Object.entries({ requestId: 'r', documentId: 'd', threadId: 't', recoveryId: 'e' } as const)) if (typeof body[field] === 'string') body[field] = await resolveId(kind, body[field]);
        if (Array.isArray(body.requestIds)) body.requestIds = await Promise.all(body.requestIds.map(id => typeof id === 'string' ? resolveId('r', id) : id));
        if (typeof body.ownerKey === 'string' && isAgentAlias(body.ownerKey, 'o')) body.ownerKey = await ids.resolveOwner(body.ownerKey);
      }
      if (method === 'POST' && path === '/agent/inbox') {
        if (owner.agent !== 'claude' || body.ownerKey !== key || !nativeDelivery()) throw new DomainError('Native delivery is unavailable', 409);
        const notification = await capture(async () => {
          if (isResetting() || stopping || (body.turnId === 'idle' ? agentActivity !== 'idle' : body.turnId !== nativeTurn())) return;
          const recovering = pendingRecovery();
          if (recovering?.replyRecovery) return reserveRecovery(recovering.id, recovering.replyRecovery.id);
          const next = pending();
          if (!next) return;
          const notification = await reserveNotification(next.id, compact);
          if (body.turnId !== 'idle') await store.update(state => { for (const member of requestBatch(state, next.id)) member.nativeTurnId = text(body, 'turnId'); });
          return notification;
        }).catch(error => { connectionError = 'Claude delivery could not be prepared. The question is retained; check the app and use Reset if needed.'; changed(); throw error; });
        json(response, { ownerKey: key, instanceId, ...(notification ? { notification } : {}) }); return;
      }

      if (method === 'POST' && (path === '/api/network' || path === '/agent/network')) {
        if (isLan) throw new DomainError('Manage network access from the local viewer', 403);
        await host.setNetworkAccess(boolean(body, 'enabled'), optionalText(body, 'passphrase'), optionalText(body, 'publicUrl'), optionalText(body, 'expectedTunnelTarget'), optionalText(body, 'expectedInstanceId'));
        json(response, host.networkStatus(true)); return;
      }
      const agentClose = path.match(/^\/agent\/documents\/([^/]+)\/close$/);
      if (method === 'POST' && agentClose) {
        if (body.instanceId !== instanceId) throw new DomainError('The original viewer changed. Refresh the list and try again.', 409);
        json(response, await closeRegisteredDocument(agentClose[1])); return;
      }
      const proposalDecision = path.match(/^\/api\/proposals\/([^/]+)\/decision$/);
      if (method === 'POST' && proposalDecision) {
        if (body.decision !== 'accept' && body.decision !== 'reject') throw new DomainError('Expected accept or reject');
        json(response, await proposalService.decide(proposalDecision[1], body.decision)); return;
      }
      const acceptProposals = path.match(/^\/api\/threads\/([^/]+)\/messages\/([^/]+)\/proposals\/accept$/);
      if (method === 'POST' && acceptProposals) {
        json(response, await proposalService.acceptReply(acceptProposals[1], acceptProposals[2])); return;
      }
      if (method === 'POST' && path === '/api/files/root') {
        // Only explicit local viewer actions call this; previews/hover discovery cannot grant access.
        const document = get(store.read().documents, text(body, 'documentId'));
        const requestedRoot = text(body, 'directory');
        if (!isAbsolute(requestedRoot) || requestedRoot.includes('\0')) throw new DomainError('Expected an absolute directory path');
        const root = await realpath(requestedRoot).catch(() => { throw new DomainError('Directory is unavailable', 404); });
        if (!(await stat(root)).isDirectory()) throw new DomainError('Expected a directory');
        const roots = browsingRoots.get(document.id) ?? new Set<string>();
        roots.add(root); browsingRoots.set(document.id, roots);
        json(response, { root }); return;
      }
      if (method === 'POST' && path === '/api/agent/reset') { startReset(); json(response, { ok: true }, 202); return; }
      if (method === 'POST' && path === '/api/agent/stop') { startAgentStop(text(body, 'turnId')); json(response, { ok: true }, 202); return; }
      const stopPath = path.match(/^\/api\/requests\/([^/]+)\/stop$/);
      if (method === 'POST' && stopPath) {
        const active = stream, turnId = text(body, 'turnId');
        if (!active || active.route.requestId !== stopPath[1] || controlTurn(active) !== turnId || !canStop(active)) throw new DomainError('This Sidecar request has no interruptible active turn', 409);
        if (!stopping) {
          stopError = undefined;
          stopAttempt = { stream: active, turnId };
          stopping = { stream: active, turnId, timer: setTimeout(() => stopFailed(active), 10000) };
          if (owner.agent === 'codex') void stopObserver?.interrupt(turnId).catch(() => stopFailed(active));
        }
        changed(); json(response, { ok: true }, 202); return;
      }
      if (method === 'POST' && path === '/agent/control') {
        if (owner.agent !== 'claude' || text(body, 'ownerKey') !== ownerKey(owner)) throw new DomainError('Control belongs to another owner', 409);
        if (body.protocol === 'sc1') claudeProtocolAt = Date.now();
        if (body.delivery === 'tool-context-v1') nativeDeliveryAt = Date.now();
        const event = text(body, 'event'), turnId = text(body, 'turnId');
        if (!turnId || turnId.length > 256 || !['poll', 'received', 'delivery-failed', 'started', 'completed', 'interrupted', 'stop-failed', 'reset-idle', 'reset-started', 'reset-failed'].includes(event)) throw new DomainError('Invalid native control event');
        if (event === 'delivery-failed') {
          if (!Array.isArray(body.requestIds) || body.requestIds.length !== 1 || typeof body.requestIds[0] !== 'string') throw new DomainError('Invalid failed delivery');
          const id = body.requestIds[0];
          if (typeof body.recoveryId === 'string') {
            await recoveryFailed(id, body.recoveryId);
            json(response, { ok: true }); return;
          }
          await store.update(state => {
            const request = get(state.requests, id);
            if (request.acceptedAt || !['claimed', 'queued'].includes(request.status)) return;
            for (const member of requestBatch(state, id)) { member.status = 'uncertain'; member.handoff = 'uncertain'; }
            connectionError = 'Claude delivery could not be confirmed. The question is retained; use Reset before retrying.';
          });
          changed(); json(response, { ok: true }); return;
        }
        if (event === 'received') {
          const ids = body.requestIds;
          if (!Array.isArray(ids) || ids.length > 64 || !ids.every(id => typeof id === 'string')) throw new DomainError('Invalid native receipt');
          await store.update(state => {
            for (const id of ids) {
              const request = state.requests[id];
              if (!request || request.batchId && request.batchId !== id || !['queued', 'claimed', 'uncertain'].includes(request.status)) continue;
              markAccepted(state, id, turnId);
            }
          });
          claudeControl = { turnId, seenAt: Date.now() }; agentActivity = 'busy';
          const state = store.read();
          const notifications = await Promise.all(ids.flatMap(id => {
            const request = state.requests[id], active = streams.get(id);
            if (!request || request.status !== 'claimed' || !active) return [];
            const stream = { prefix: active.prefix, suffix: active.suffix, progress: active.progress };
            return [wire(request.replyRecovery ? {
              type: 'sidecar.recovery', ownerKey: ownerKey(owner), requestId: id, recoveryId: request.replyRecovery.id,
              documentId: request.documentId, thread: { id: request.threadId }, stream,
              instruction: 'Follow the Sidecar skill. Reply recovery only: resend the existing answer. Do not repeat the original task, tools, or edits.',
            } : { type: 'sidecar.request', ownerKey: ownerKey(owner), requestId: id, stream, ...requestContext(state, id), instruction: 'Follow the Sidecar skill.' })];
          }));
          changed(); json(response, { ok: true, notifications }); return;
        }
        if (event.startsWith('reset-')) {
          if (!reset || !isResetting() || text(body, 'resetId') !== reset.id) throw new DomainError('This Reset is no longer active', 409);
          if (event === 'reset-idle') reset.confirm({ turnId, answer: optionalText(body, 'answer') });
          else if (event === 'reset-failed') reset.reject(new Error('Could not verify or interrupt the attached Claude session. Reconnect it and try Reset again.'));
          else {
            if (reset.turnId && reset.turnId !== turnId) throw new DomainError('The native turn changed during Reset', 409);
            reset.turnId = turnId; reset.status = 'interrupting'; changed();
          }
          json(response, { ok: true }); return;
        }
        if (event === 'poll') {
          // A heartbeat may overtake the previous turn's completion hook. Keep
          // its marker binding until that hook arrives, but don't offer Stop.
          if (body.activity === 'idle' || body.activity === 'unknown') {
            if (claudeControl) claudeControl.seenAt = 0;
          } else claudeControl = { ...(claudeControl?.turnId === turnId ? claudeControl : {}), turnId, seenAt: Date.now() };
          if (body.activity === 'idle') agentActivity = 'idle';
          else if (body.activity === 'busy' && agentActivity !== 'waiting') agentActivity = 'busy';
          const stop = stopping?.turnId === turnId ? { turnId, ...(stopping.stream ? { requestId: stopping.stream.route.requestId } : {}) } : undefined;
          runtimeChanged(); json(response, { ownerKey: ownerKey(owner), instanceId, ...(stop ? { stop } : {}), ...(isResetting() && reset ? { reset: { id: reset.id } } : {}) }); return;
        }
        if (event === 'started') {
          const marker = text(body, 'marker');
          const matching = [...streams.values()].filter(active => !active.done && [active.prefix, active.progress.prefix].some(prefix => prefix.startsWith(marker)));
          if (matching.length) {
            for (const active of matching) if (active.prefix.startsWith(marker)) active.hasFinalStarted = true;
            await store.update(state => { for (const active of matching) markAccepted(state, active.route.requestId, turnId); });
            claudeControl = { turnId, seenAt: Date.now(), requestId: matching[0].route.requestId };
            agentActivity = 'busy';
            runtimeChanged();
          }
          json(response, { ok: true }); return;
        }
        if (event === 'stop-failed') { if (stopping?.turnId === turnId) stopFailed(); }
        else {
          await capture(() => nativeEnded(turnId, event, optionalText(body, 'answer')));
          if (isResetting() && reset?.turnId === turnId) reset.confirm({ turnId, answer: optionalText(body, 'answer') });
          if (claudeControl?.turnId === turnId) claudeControl = undefined;
          changed();
        }
        json(response, { ok: true }); return;
      }
      if (method === 'POST' && path === '/agent/lifecycle') {
        if (text(body, 'ownerKey') !== ownerKey(owner)) throw new DomainError('Lifecycle belongs to another owner', 409);
        const event = text(body, 'event');
        if (!['compaction-started', 'compaction-completed', 'interrupted', 'agent-busy', 'agent-idle', 'agent-waiting', 'agent-disconnected', 'agent-unknown'].includes(event) || (event === 'interrupted' && owner.agent !== 'codex')) throw new DomainError('Unsupported lifecycle event');
        const turnId = optionalText(body, 'turnId');
        if (turnId && activityTurnId && turnId !== activityTurnId && ['agent-idle', 'interrupted', 'compaction-completed'].includes(event)) {
          json(response, { ok: true }); return;
        }
        if (event === 'compaction-started') compacting = true;
        else if (event === 'compaction-completed') compacting = false;
        else {
          compacting = false;
          agentActivity = event === 'interrupted' ? 'idle' : event.slice('agent-'.length);
          if (turnId) activityTurnId = turnId;
          else if (event === 'agent-unknown' || event === 'agent-disconnected') activityTurnId = undefined;
        }
        lastLifecycle = { event, turnId };
        runtimeChanged(); json(response, { ok: true }); return;
      }
      if (method === 'POST' && path === '/agent/documents') {
        const repoInfo = body.repoInfo;
        if (repoInfo !== undefined && !isRepoInfo(repoInfo)) throw new DomainError('Invalid repository metadata');
        let workspace: string | undefined;
        if (body.workspace !== undefined) {
          const declared = text(body, 'workspace');
          if (!isAbsolute(declared)) throw new DomainError('Workspace must be an absolute directory path');
          workspace = await realpath(declared).catch(() => { throw new DomainError('Workspace must be an existing directory'); });
          if (!(await stat(workspace)).isDirectory()) throw new DomainError('Workspace must be an existing directory');
        }
        const canonical = await realpath(text(body, 'path'));
        await readDocument(canonical);
        const document = await store.update(state => registerDocument(state, { path: canonical, title: optionalText(body, 'title'), generated: body.generated === undefined ? false : boolean(body, 'generated'), repoInfo, workspace }));
        if (closed) throw new DomainError('Sidecar stopped while opening the document. Open it again from your agent.', 503);
        await refresh(document); changed(); json(response, { ...document, title: title(document) }); return;
      }
      if (method === 'POST' && path === '/api/threads') {
        const input = { id: text(body, 'id'), documentId: text(body, 'documentId') };
        const thread = await store.update(state => createThread(state, input));
        changed(); json(response, thread); return;
      }
      const emptyThread = path.match(/^\/api\/threads\/([^/]+)$/);
      if (method === 'DELETE' && emptyThread?.[1]) {
        const isDeleted = await store.update(state => discardEmptyThread(state, emptyThread[1]));
        changed(); json(response, { isDeleted }); return;
      }
      const threadTitle = path.match(/^\/agent\/threads\/([^/]+)\/title$/);
      if (method === 'POST' && threadTitle?.[1]) {
        const id = threadTitle[1], value = text(body, 'title');
        await store.update(state => nameThread(state, id, value)); changed(); json(response, { ok: true }); return;
      }
      const editThreadTitle = path.match(/^\/api\/threads\/([^/]+)\/title$/);
      if (method === 'PATCH' && editThreadTitle) {
        const id = editThreadTitle[1], value = text(body, 'title');
        await store.update(state => nameThread(state, id, value, { canRename: true })); changed(); json(response, { ok: true }); return;
      }
      if (method === 'POST' && path === '/api/questions') {
        const input: SubmitInput = { documentId: text(body, 'documentId'), text: text(body, 'text'), clientMessageId: text(body, 'clientMessageId') };
        if (body.threadId !== undefined) input.threadId = text(body, 'threadId');
        if (body.quote !== undefined) { if (!isQuote(body.quote)) throw new DomainError('Invalid selection'); input.quote = body.quote; }
        if (body.messageQuote !== undefined) { if (!isMessageQuote(body.messageQuote)) throw new DomainError('Invalid message quote'); input.messageQuote = body.messageQuote; }
        if (body.fileQuote !== undefined) { if (!isFileQuote(body.fileQuote)) throw new DomainError('Invalid file quote'); input.fileQuote = body.fileQuote; }
        const result = await store.update(state => submit(state, input));
        changed(); json(response, result); return;
      }
      const resolution = path.match(/^\/api\/threads\/([^/]+)\/resolution$/);
      if (method === 'POST' && resolution?.[1]) {
        const id = resolution[1], isResolved = boolean(body, 'isResolved');
        await store.update(state => resolveThread(state, id, isResolved)); changed(); json(response, { ok: true }); return;
      }
      const anchor = path.match(/^\/api\/threads\/([^/]+)\/selections\/([^/]+)\/anchor$/);
      if (method === 'POST' && anchor) {
        const expectedQuote = body.expectedQuote, quote = body.quote;
        if (!isQuote(expectedQuote) || !isQuote(quote)) throw new DomainError('Invalid selection');
        // Validate routing and the immutable version before accepting browser-confirmed offsets.
        const preview = structuredClone(store.read());
        reanchorSelection(preview, anchor[1], anchor[2], expectedQuote, quote);
        if (!/^[a-f0-9]{64}$/.test(quote.version)) throw new DomainError('Original document unavailable', 404);
        const documentId = get(preview.threads, anchor[1]).documentId;
        try { await readDocument(join(directory, 'versions', documentId, `${quote.version}.md`)); }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new DomainError('Original document unavailable', 404);
          throw error;
        }
        await store.update(state => reanchorSelection(state, anchor[1], anchor[2], expectedQuote, quote));
        changed(); json(response, { ok: true }); return;
      }
      const visibility = path.match(/^\/api\/threads\/([^/]+)\/selections(?:\/([^/]+))?$/);
      if (method === 'POST' && visibility) {
        const isVisible = boolean(body, 'isVisible');
        await store.update(state => setSelectionVisibility(state, visibility[1], isVisible, visibility[2]));
        changed(); json(response, { ok: true }); return;
      }
      const messageVisibility = path.match(/^\/api\/threads\/([^/]+)\/messages\/([^/]+)\/selections$/);
      if (method === 'POST' && messageVisibility) {
        const isVisible = boolean(body, 'isVisible');
        await store.update(state => setMessageSelectionVisibility(state, messageVisibility[1], messageVisibility[2], isVisible));
        changed(); json(response, { ok: true }); return;
      }
      const pin = path.match(/^\/api\/threads\/([^/]+)\/messages\/([^/]+)\/pin$/);
      if (method === 'POST' && pin) {
        const isPinned = boolean(body, 'isPinned');
        const style = body.pinStyle;
        if (style !== undefined && !isPinStyle(style)) throw new DomainError('Invalid pin style');
        await store.update(state => pinMessage(state, pin[1], pin[2], isPinned, style));
        changed(); json(response, { ok: true }); return;
      }
      const renameTitle = path.match(/^\/api\/documents\/([^/]+)\/title$/);
      if (method === 'PATCH' && renameTitle?.[1]) {
        const id = renameTitle[1], value = text(body, 'title');
        await store.update(state => setTitle(state, id, value)); changed(); json(response, { ok: true }); return;
      }
      const acceptedPath = path.match(/^\/agent\/requests\/([^/]+)\/accepted$/);
      if (method === 'POST' && acceptedPath?.[1]) {
        const id = acceptedPath[1];
        await store.update(state => markAccepted(state, id));
        changed(); json(response, { ok: true }); return;
      }
      const preparePath = path.match(/^\/agent\/requests\/([^/]+)\/prepare$/);
      if (method === 'POST' && preparePath?.[1]) { json(response, await prepareNotification(preparePath[1], compact)); return; }
      const recoverPath = path.match(/^\/agent\/requests\/([^/]+)\/recover$/);
      if (method === 'POST' && recoverPath) { json(response, await prepareRecovery(recoverPath[1], text(body, 'recoveryId'))); return; }
      const recoveryFailedPath = path.match(/^\/agent\/requests\/([^/]+)\/recovery-failed$/);
      if (method === 'POST' && recoveryFailedPath) {
        await recoveryFailed(recoveryFailedPath[1], text(body, 'recoveryId'));
        json(response, { ok: true }); return;
      }
      const retryPath = path.match(/^\/api\/requests\/([^/]+)\/retry-reply$/);
      if (method === 'POST' && retryPath) {
        const recoveryId = text(body, 'recoveryId');
        await capture(async () => {
          await store.update(state => {
            const request = get(state.requests, retryPath[1]);
            if (!['claimed', 'uncertain'].includes(request.status) || request.replyRecovery?.id !== recoveryId || request.replyRecovery.status !== 'failed') throw new DomainError('This reply no longer needs that retry', 409);
            claim(state, request.id, { resume: true });
            request.replyRecovery = { id: randomUUID(), turnId: request.replyRecovery.turnId, status: 'pending' };
          });
        });
        changed(); json(response, { ok: true }, 202); return;
      }
      const claimPath = path.match(/^\/agent\/requests\/([^/]+)\/claim$/);
      if (method === 'POST' && claimPath?.[1]) {
        if (isResetting()) throw new DomainError('Agent Reset is in progress', 409);
        const id = claimPath[1];
        const result = await store.update(state => {
          const result = claim(state, id, { resume: body.resume === undefined ? false : boolean(body, 'resume') });
          // This endpoint is called by the agent after receiving an ID-only event.
          if (result.claimStatus !== 'uncertain') markAccepted(state, id);
          return result;
        });
        const state = store.read();
        const document = await documentContext(get(state.documents, result.request.documentId));
        // Recover a prepared event truncated by a native monitor; never replace its stream.
        const active = streams.get(id);
        const markers = result.claimStatus === 'already-claimed' && active
          ? active.error ? { error: active.error } : { prefix: active.prefix, suffix: active.suffix, progress: active.progress }
          : undefined;
        const context = { ...result, ...requestContext(state, id), ...(markers ? { stream: markers } : {}), document, thread: get(state.threads, result.request.threadId), proposals: Object.values(state.proposals).filter(p => p.threadId === result.request.threadId) };
        changed(); json(response, compact ? await compactContext(owner, context, ids) : context); return;
      }
      if (method === 'POST' && path === '/agent/streams') {
        const route = { requestId: text(body, 'requestId'), documentId: text(body, 'documentId'), threadId: text(body, 'threadId') };
        const markers = await startReplyStream(route);
        changed(); json(response, markers); return;
      }
      if (method === 'POST' && path === '/agent/stream-events') {
        if (text(body, 'ownerKey') !== ownerKey(owner) || owner.agent !== 'claude') throw new DomainError('Stream belongs to another owner', 409);
        if (!isStreamEvent(body)) throw new DomainError('Invalid stream event');
        await capture(() => acceptStream(body)); json(response, { ok: true }); return;
      }
      if (method === 'POST' && path === '/agent/replies') {
        const input: ReplyInput = { requestId: text(body, 'requestId'), documentId: text(body, 'documentId'), threadId: text(body, 'threadId'), text: '', isError: body.isError === undefined ? false : boolean(body, 'isError') };
        if (body.stream === true) {
          const previous = get(store.read().requests, input.requestId).answer;
          const active = streams.get(input.requestId);
          input.text = previous?.text ?? (active ? active.finish(input) : (() => { throw new DomainError('No completed stream; send a complete reply', 409); })());
          if (previous) input.isError = previous.isError;
          else input.metadata = active?.metadata;
        } else Object.assign(input, parseReply(text(body, 'text')));
        await capture(async () => {
          await saveReply(input);
          retireStreams();
        });
        changed(); json(response, { ok: true }); return;
      }
      throw new DomainError('Not found', 404);
    } catch (error) {
      const info = error instanceof URIError ? { error: 'Invalid URL', status: 400 } : errorInfo(error);
      if (!response.headersSent) json(response, { error: info.error }, info.status);
      else response.end();
    }
  }
  await proposalService.recover();
  const host = await createViewerHost({ directory, port, cookieName, capability: agentToken, instanceId, handle });
  url = host.url;
  await Promise.all(Object.values(store.read().documents).map(refresh));
  const polling = setInterval(() => {
    if (claudeControl?.seenAt && Date.now() - claudeControl.seenAt >= 2500) { claudeControl.seenAt = 0; runtimeChanged(); }
    if (closed || refreshing) return;
    refreshing = true;
    void (async () => {
      for (const document of Object.values(store.read().documents)) await refresh(document);
    })().finally(() => { refreshing = false; });
  }, pollMs);
  let readingActivity = false;
  const activityPolling = owner.agent === 'codex' ? setInterval(() => {
    if (closed || readingActivity || (!viewers.size && !waitingCodexDelivery() && nativeCleanupVersion === nativeCleanedVersion)) return;
    readingActivity = true;
    void readCodexControl(owner.sessionId, transportAbort.signal).then(control => {
      const { activity } = control;
      if (!closed) { codexControl = control; agentActivity = activity; runtimeChanged(); }
      const waiting = waitingCodexDelivery();
      if (!dispatching && ((activity === 'idle' && waiting) || nativeCleanupVersion !== nativeCleanedVersion)) return startCodexDelivery(waiting?.id);
    }).finally(() => { readingActivity = false; });
  }, 1000) : undefined;
  const heartbeat = setInterval(() => {
    for (const response of viewers.keys()) if (!response.destroyed) response.write(': keepalive\n\n');
    for (const response of agents.keys()) if (!response.destroyed) response.write('\n');
  }, 5000);
  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true; stopObserver?.(); clearStop(); clearTimeout(streamTimer); transportAbort.abort(); clearInterval(polling); clearInterval(heartbeat); clearInterval(activityPolling);
    for (const response of [...viewers.keys(), ...agents.keys()]) response.end();
    closePromise = host.close();
    await closePromise; await dispatchWork; await nativeQueueWork; await resetWork; await captureWork; await finalizing; await proposalService.drain(); finish();
  }
  changed();
  return { url, close, instanceId, ownerAlias, done };
}
