import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { isObject } from './store.ts';

// A successful `codex queue` only enqueues. Idle sessions need an explicit start,
// and Reset must withdraw cancelled submissions before releasing the next one.
export async function reconcileCodexQueue(threadId: string, options: { cancelRequestIds?: string[]; startRequestId?: string; canStart?: () => boolean }, signal: AbortSignal, socketPath = join(process.env.CODEX_HOME ?? homedir() + '/.codex', 'app-server-control/app-server-control.sock')): Promise<void> {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  abort.throwIfAborted();
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: 2000 });
  let nextId = 0;
  const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const fail = () => {
    for (const call of calls.values()) call.reject(new Error('Could not reconcile the original Codex queue. Try Reset after reconnecting.'));
    calls.clear(); socket.terminate();
  };
  socket.on('error', fail); socket.on('close', fail); abort.addEventListener('abort', fail, { once: true });
  socket.on('message', bytes => {
    try {
      const message: unknown = JSON.parse(String(bytes));
      if (!isObject(message) || typeof message.id !== 'number') return;
      const call = calls.get(message.id); if (!call) return;
      calls.delete(message.id);
      if (message.error) call.reject(new Error('Codex queue changed or refused the operation. Try Reset again.'));
      else call.resolve(message.result);
    } catch { fail(); }
  });
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    if (abort.aborted || socket.readyState !== WebSocket.OPEN) { reject(new Error('Codex queue connection closed.')); return; }
    const id = ++nextId; calls.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const status = async () => {
    const result = await request('thread/read', { threadId, includeTurns: false });
    if (!isObject(result) || !isObject(result.thread) || result.thread.id !== threadId || !isObject(result.thread.status) || !['idle', 'active'].includes(String(result.thread.status.type)))
      throw new Error('The original Codex session is not available. Reconnect it before Reset.');
    return result.thread.status.type;
  };
  const list = async () => {
    const entries: { id: string; requestId?: string }[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await request('thread/queue/list', { threadId, limit: 25, ...(cursor ? { cursor } : {}) });
      if (!isObject(page) || !Array.isArray(page.data)) throw new Error('Could not read the native Codex queue.');
      for (const entry of page.data) {
        if (!isObject(entry) || typeof entry.id !== 'string' || !Array.isArray(entry.input)) throw new Error('Invalid native queue entry.');
        let requestId: string | undefined;
        const input = entry.input[0];
        if (entry.input.length === 1 && isObject(input) && input.type === 'text' && typeof input.text === 'string') {
          try {
            const event: unknown = JSON.parse(input.text);
            if (isObject(event) && ['sidecar.request', 'sidecar.recovery'].includes(String(event.type)) && event.ownerKey === `codex-${threadId}` && typeof event.requestId === 'string') requestId = event.requestId;
          } catch { /* Ordinary terminal messages are never Sidecar queue entries. */ }
        }
        entries.push({ id: entry.id, ...(requestId ? { requestId } : {}) });
      }
      if (page.nextCursor != null && (typeof page.nextCursor !== 'string' || cursors.has(page.nextCursor))) throw new Error('Invalid native queue cursor.');
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return entries;
  };
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('Codex queue connection closed.'))); });
    await request('initialize', { clientInfo: { name: 'sidecar-queue', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    const initialStatus = await status(), cancelled = new Set(options.cancelRequestIds);
    if (!cancelled.size && options.startRequestId && initialStatus !== 'idle') return;
    const queue = await list();
    for (const entry of queue) if (entry.requestId && cancelled.has(entry.requestId))
      await request('thread/queue/delete', { threadId, queuedSubmissionId: entry.id });
    if (options.startRequestId) {
      const first = (cancelled.size ? await list() : queue)[0];
      // Do not jump ahead of unrelated terminal input or start another turn while busy.
      if (first?.requestId !== options.startRequestId || await status() !== 'idle') return;
      if (options.canStart && !options.canStart()) return;
      const result = await request('thread/queue/start', { threadId, queuedSubmissionId: first.id });
      if (!isObject(result) || !isObject(result.turn) || typeof result.turn.id !== 'string') throw new Error('Could not confirm Codex started the queued request.');
    }
  } finally {
    abort.removeEventListener('abort', fail); socket.removeListener('error', fail); socket.removeListener('close', fail);
    socket.on('error', () => {}); socket.terminate();
  }
}
