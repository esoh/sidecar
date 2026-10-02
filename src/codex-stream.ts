import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { isObject } from './store.ts';
import type { StreamEvent } from './stream.ts';

const defaultSocketPath = () => join(process.env.CODEX_HOME ?? homedir() + '/.codex', 'app-server-control/app-server-control.sock');

export async function observeCodex(threadId: string, onEvent: (event: StreamEvent) => void, onFailure: (message: string) => void, socketPath = defaultSocketPath(), prefix?: string): Promise<() => void> {
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: 5000 });
  let stopped = false, ready = false, nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let message: { id: string; turnId: string; index: number; text: string; ignored?: boolean } | undefined;
  let replyTurnId: string | undefined;
  function stop() { stopped = true; socket.terminate(); for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Codex observer closed')); } pending.clear(); }
  function failed() { if (!stopped) { if (ready) onFailure('Codex stream disconnected. Send a complete reply to recover.'); stop(); } }
  socket.on('error', failed); socket.on('close', failed);
  socket.on('message', bytes => {
    try {
      const value: unknown = JSON.parse(bytes.toString());
      if (!isObject(value)) return;
      if (typeof value.id === 'number' && pending.has(value.id)) {
        const call = pending.get(value.id)!; pending.delete(value.id); clearTimeout(call.timer);
        if (value.error) call.reject(new Error('Codex observer request rejected'));
        else call.resolve(value.result);
        return;
      }
      const p = value.params;
      if (!isObject(p) || p.threadId !== threadId || typeof p.turnId !== 'string') return;
      if (value.method === 'item/agentMessage/delta' && typeof p.itemId === 'string' && typeof p.delta === 'string') {
        if (!message || message.id !== p.itemId) message = { id: p.itemId, turnId: p.turnId, index: 0, text: '' };
        if (message.ignored) return;
        message.text += p.delta;
        if (prefix && !message.text.startsWith(prefix)) {
          if (!prefix.startsWith(message.text)) { message.ignored = true; message.text = ''; }
          return;
        }
        replyTurnId = p.turnId;
        if (message.text.length > 256 * 1024) { onFailure('Codex message exceeds the streaming limit.'); stop(); return; }
        onEvent({ messageId: message.id, turnId: message.turnId, index: message.index, delta: message.index++ === 0 ? message.text : p.delta, final: false });
      } else if (value.method === 'item/completed' && isObject(p.item) && p.item.type === 'agentMessage' && typeof p.item.id === 'string' && typeof p.item.text === 'string') {
        if (message?.id !== p.item.id) return;
        if (message.ignored || !message.index) { message = undefined; return; }
        if (message.text !== p.item.text) { onFailure('Codex stream was incomplete. Send a complete reply to recover.'); return; }
        onEvent({ messageId: message.id, turnId: message.turnId, index: message.index, delta: '', final: true });
        message = undefined;
      } else if (value.method === 'turn/completed' && replyTurnId === p.turnId) onFailure('Agent turn ended before the reply was finalized.');
    } catch { failed(); }
  });
  function request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex observer timed out')); }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('Codex observer closed'))); });
    await request('initialize', { clientInfo: { name: 'sidecar', version: '0.0.0' } });
    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    const read = await request('thread/read', { threadId, includeTurns: false });
    if (!isObject(read) || !isObject(read.thread) || read.thread.id !== threadId || !isObject(read.thread.status) || !['active', 'idle'].includes(String(read.thread.status.type))) throw new Error('The original Codex conversation is not loaded; no replacement was started');
    const result = await request('thread/resume', { threadId, excludeTurns: true });
    if (!isObject(result) || !isObject(result.thread) || result.thread.id !== threadId) throw new Error('Codex observer identity mismatch');
    ready = true;
    return stop;
  } catch (error) { stop(); throw error; }
}

// Read-only sampling: never subscribes, resumes, or creates an agent conversation.
export async function readCodexActivity(threadId: string, signal: AbortSignal, socketPath = defaultSocketPath()): Promise<string> {
  if (signal.aborted) return 'unknown';
  return new Promise(resolve => {
    const socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: 2000 });
    let finished = false;
    const finish = (activity: string) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); socket.terminate(); resolve(activity);
    };
    const abort = () => finish('unknown');
    const timer = setTimeout(abort, 2000);
    signal.addEventListener('abort', abort, { once: true });
    socket.on('error', abort); socket.on('close', abort);
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'sidecar-status', version: '0.0.0' } } })));
    socket.on('message', bytes => {
      try {
        const message: unknown = JSON.parse(bytes.toString());
        if (!isObject(message) || ![1, 2].includes(Number(message.id))) return;
        if (message.error) { finish('unknown'); return; }
        if (message.id === 1) {
          socket.send(JSON.stringify({ method: 'initialized', params: {} }));
          socket.send(JSON.stringify({ id: 2, method: 'thread/read', params: { threadId, includeTurns: false } }));
          return;
        }
        const result = message.result;
        if (!isObject(result) || !isObject(result.thread) || result.thread.id !== threadId || !isObject(result.thread.status)) { finish('unknown'); return; }
        const status = result.thread.status;
        if (status.type === 'active') {
          const waiting = Array.isArray(status.activeFlags) && status.activeFlags.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput');
          finish(waiting ? 'waiting' : 'busy');
        } else finish(status.type === 'idle' ? 'idle' : status.type === 'notLoaded' ? 'disconnected' : 'unknown');
      } catch { finish('unknown'); }
    });
  });
}
