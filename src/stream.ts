import { randomUUID } from 'node:crypto';
import { DomainError, isObject } from './store.ts';

export type StreamEvent = { messageId: string; turnId: string; index: number; delta: string; final: boolean };
export type ReplyRoute = { requestId: string; documentId: string; threadId: string };
export function isStreamEvent(value: unknown): value is StreamEvent {
  return isObject(value) && typeof value.messageId === 'string' && value.messageId.length > 0 && value.messageId.length < 256 && typeof value.turnId === 'string' && value.turnId.length > 0 && value.turnId.length < 256 && Number.isSafeInteger(value.index) && Number(value.index) >= 0 && typeof value.delta === 'string' && typeof value.final === 'boolean';
}

// One claimed request per owner already serializes replies. Drafts are transient;
// the existing reply transaction is the only durable completion boundary.
export class ReplyStream {
  readonly prefix: string;
  readonly suffix: string;
  text = '';
  error: string | null = null;
  done = false;
  private messages = new Map<string, { next: number; raw: string; pending: Map<number, StreamEvent>; ignored: boolean }>();
  private bound: string | undefined;
  private received = 0;
  constructor(readonly route: ReplyRoute) {
    const nonce = randomUUID();
    this.prefix = `[[sidecar:${nonce}]]\n`;
    this.suffix = `\n[[/sidecar:${nonce}]]`;
  }
  get hasStarted() { return this.bound !== undefined; }
  fail(message: string) { if (!this.done) this.error = message; }
  accept(event: StreamEvent) {
    if (this.done || this.error) return;
    const key = `${event.turnId}/${event.messageId}`;
    if (this.bound && this.bound !== key) return;
    let candidate = this.messages.get(key);
    if (!candidate) {
      if (this.messages.size >= 64) { this.fail('Too many messages while waiting for a reply. Send a complete reply.'); return; }
      candidate = { next: 0, raw: '', pending: new Map(), ignored: false };
      this.messages.set(key, candidate);
    }
    if (candidate.ignored) { if (event.final) this.messages.delete(key); return; }
    if (event.index < candidate.next || candidate.pending.has(event.index)) return;
    this.received += event.delta.length;
    if (this.received > 256 * 1024 || candidate.pending.size >= 4096) { this.fail('Stream exceeds the buffering limit. Send a shorter complete reply.'); return; }
    candidate.pending.set(event.index, event);
    while (candidate.pending.has(candidate.next)) {
      const next = candidate.pending.get(candidate.next);
      if (!next) break;
      candidate.pending.delete(candidate.next++);
      candidate.raw += next.delta;
      if (!candidate.raw.startsWith(this.prefix)) {
        if (!this.prefix.startsWith(candidate.raw) || next.final) { candidate.ignored = true; this.received -= candidate.raw.length; candidate.raw = ''; if (next.final || [...candidate.pending.values()].some(event => event.final)) this.messages.delete(key); candidate.pending.clear(); return; }
        continue;
      }
      this.bound = key;
      this.render(candidate.raw, next.final);
      if (this.done || this.error) return;
    }
  }
  private render(raw: string, final: boolean) {
    const body = raw.slice(this.prefix.length);
    const end = body.indexOf(this.suffix);
    if (end !== -1) this.text = body.slice(0, end);
    else {
      let held = Math.min(body.length, this.suffix.length - 1);
      while (held > 0 && !body.endsWith(this.suffix.slice(0, held))) held--;
      this.text = body.slice(0, body.length - held);
    }
    if (final) {
      if (end < 0 || body.slice(end + this.suffix.length).trim() !== '' || !this.text.trim()) this.fail('The streamed reply ended without a complete reply boundary. Send a complete reply to recover.');
      else this.done = true;
    }
  }
  finish(route: ReplyRoute) {
    if (route.requestId !== this.route.requestId || route.documentId !== this.route.documentId || route.threadId !== this.route.threadId) throw new DomainError('Reply routing does not match the stream', 409);
    if (!this.done || this.error) throw new DomainError(this.error ?? 'The reply is still streaming', 409);
    return this.text;
  }
  snapshot() { return { ...this.route, text: this.text, done: this.done, error: this.error }; }
}
