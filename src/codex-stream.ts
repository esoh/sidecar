import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { isObject } from './store.ts';
import type { StreamEvent } from './stream.ts';

export async function observeCodex(threadId: string, onEvent: (event: StreamEvent) => void, onFailure: (message: string) => void, socketPath = join(process.env.CODEX_HOME ?? homedir() + '/.codex', 'app-server-control/app-server-control.sock')): Promise<() => void> {
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: 5000 });
  let stopped = false, ready = false, nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let message: { id: string; turnId: string; index: number; text: string } | undefined;
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
        message.text += p.delta;
        if (message.text.length > 256 * 1024) { onFailure('Codex message exceeds the streaming limit.'); stop(); return; }
        onEvent({ messageId: message.id, turnId: message.turnId, index: message.index++, delta: p.delta, final: false });
      } else if (value.method === 'item/completed' && isObject(p.item) && p.item.type === 'agentMessage' && typeof p.item.id === 'string' && typeof p.item.text === 'string') {
        if (message?.id !== p.item.id) return;
        if (message.text !== p.item.text) { onFailure('Codex stream was incomplete. Send a complete reply to recover.'); return; }
        onEvent({ messageId: message.id, turnId: message.turnId, index: message.index, delta: '', final: true });
        message = undefined;
      } else if (value.method === 'turn/completed') onFailure('Agent turn ended before the reply was finalized.');
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
