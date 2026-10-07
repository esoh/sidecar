import { randomUUID } from 'node:crypto';
import { DomainError, isObject } from './store.ts';
import { parseReply, type ReplyMetadata } from './reply-metadata.ts';

export type StreamEvent = { messageId: string; turnId: string; index: number; delta: string; final: boolean };
export type ProgressReply = { messageId: string; text: string };
export type ReplyRoute = { requestId: string; documentId: string; threadId: string };
export function isStreamEvent(value: unknown): value is StreamEvent {
  return isObject(value) && typeof value.messageId === 'string' && value.messageId.length > 0 && value.messageId.length < 256 && typeof value.turnId === 'string' && value.turnId.length > 0 && value.turnId.length < 256 && Number.isSafeInteger(value.index) && Number(value.index) >= 0 && typeof value.delta === 'string' && typeof value.final === 'boolean';
}

// Drafts are transient; the reply transaction is the durable completion boundary.
export class ReplyStream {
  readonly prefix: string;
  readonly suffix: string;
  readonly progress: { prefix: string; suffix: string };
  text = '';
  private progressMessageId: string | undefined;
  metadata: ReplyMetadata = {};
  error: string | null = null;
  done = false;
  turnId: string | undefined;
  private endedTurns = new Set<string>();
  private messages = new Map<string, { next: number; raw: string; pending: Map<number, StreamEvent>; ignored: boolean }>();
  private started = false;
  private completedProgress = new Set<string>();
  private received = 0;
  constructor(readonly route: ReplyRoute, stableThreadTag = false) {
    const nonce = stableThreadTag ? route.threadId : randomUUID();
    const receipt = stableThreadTag ? `[[sidecar-reply:${route.requestId}]]\n` : '';
    this.prefix = `[[sidecar:${nonce}]]\n${receipt}`;
    this.suffix = `\n[[/sidecar:${nonce}]]`;
    this.progress = { prefix: `[[sidecar-progress:${nonce}]]\n${receipt}`, suffix: `\n[[/sidecar-progress:${nonce}]]` };
  }
  get hasStarted() { return this.started; }
  get isTurnActive() { return !!this.turnId && !this.endedTurns.has(this.turnId); }
  endTurn(turnId: string) { this.endedTurns.add(turnId); }
  recoverPartial(raw: string) {
    const prefix = raw.startsWith(this.prefix) ? this.prefix : raw.startsWith(this.progress.prefix) ? this.progress.prefix : undefined;
    if (prefix) this.render(raw, false, prefix, prefix === this.prefix ? this.suffix : this.progress.suffix);
  }
  fail(message: string) { if (!this.done) this.error = message; }
  accept(event: StreamEvent): ProgressReply | undefined {
    if (this.done) return;
    const key = `${event.turnId}/${event.messageId}`;
    if (this.completedProgress.has(key)) return;
    let candidate = this.messages.get(key);
    if (!candidate) {
      if (this.messages.size + this.completedProgress.size >= 64) { this.fail('Too many messages while waiting for a reply. Send a complete reply.'); return; }
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
      const isProgress = candidate.raw.startsWith(this.progress.prefix);
      const prefix = isProgress ? this.progress.prefix : this.prefix;
      if (!candidate.raw.startsWith(prefix)) {
        if ((!this.prefix.startsWith(candidate.raw) && !this.progress.prefix.startsWith(candidate.raw)) || next.final) { candidate.ignored = true; this.received -= candidate.raw.length; candidate.raw = ''; if (next.final || [...candidate.pending.values()].some(event => event.final)) this.messages.delete(key); candidate.pending.clear(); return; }
        continue;
      }
      this.progressMessageId = isProgress ? `progress:${this.route.requestId}:${key}` : undefined;
      this.started = true;
      this.turnId = event.turnId;
      const suffix = isProgress ? this.progress.suffix : this.suffix;
      const isComplete = this.render(candidate.raw, next.final, prefix, suffix);
      // A complete native retry can replace an interrupted message, using this request's exact markers.
      if (isComplete) this.error = null;
      if (isComplete && isProgress) {
        const update = { messageId: key, text: this.text };
        this.completedProgress.add(key);
        this.messages.delete(key);
        this.text = '';
        this.progressMessageId = undefined;
        this.metadata = {};
        return update;
      }
      if (isComplete) this.done = true;
      if (this.done || next.final) return;
    }
  }
  private render(raw: string, final: boolean, prefix: string, suffix: string) {
    const body = raw.slice(prefix.length);
    const end = body.indexOf(suffix);
    if (end !== -1) this.text = body.slice(0, end);
    else {
      let held = Math.min(body.length, suffix.length - 1);
      while (held > 0 && !body.endsWith(suffix.slice(0, held))) held--;
      this.text = body.slice(0, body.length - held);
    }
    const parsed = parseReply(this.text);
    this.text = parsed.text;
    this.metadata = parsed.metadata;
    if (final) {
      if (end < 0 || body.slice(end + suffix.length).trim() !== '' || !this.text.trim()) this.fail('The streamed reply ended without a complete reply boundary. Send a complete reply to recover.');
      else return true;
    }
  }
  finish(route: ReplyRoute) {
    if (route.requestId !== this.route.requestId || route.documentId !== this.route.documentId || route.threadId !== this.route.threadId) throw new DomainError('Reply routing does not match the stream', 409);
    if (!this.done || this.error) throw new DomainError(this.error ?? 'The reply is still streaming', 409);
    return this.text;
  }
  snapshot() { return { ...this.route, text: this.text, progressMessageId: this.progressMessageId, done: this.done, error: this.error }; }
}

// One native message can contain replies to several Sidecar threads. Reassemble
// it once, then feed each receipt's existing parser only its own marked block.
export class ThreadReplyRouter {
  private messages = new Map<string, { next: number; raw: string; pending: Map<number, StreamEvent>; blocks: Map<number, { index: number; sent: number; final: boolean }> }>();
  private completed = new Set<string>();
  accept(event: StreamEvent, streams: ReadonlyMap<string, ReplyStream>): Array<{ stream: ReplyStream; event: StreamEvent }> {
    const key = `${event.turnId}/${event.messageId}`, output: Array<{ stream: ReplyStream; event: StreamEvent }> = [];
    if (this.completed.has(key)) return output;
    let message = this.messages.get(key);
    if (!message) {
      if (this.messages.size >= 64) throw new DomainError('Too many unfinished native messages');
      message = { next: 0, raw: '', pending: new Map(), blocks: new Map() }; this.messages.set(key, message);
    }
    if (event.index < message.next || message.pending.has(event.index)) return output;
    if (message.pending.size >= 4096 || message.raw.length + event.delta.length + [...message.pending.values()].reduce((n, e) => n + e.delta.length, 0) > 256 * 1024) throw new DomainError('Native message exceeds the streaming limit');
    message.pending.set(event.index, event);
    while (message.pending.has(message.next)) {
      const part = message.pending.get(message.next)!; message.pending.delete(message.next++); message.raw += part.delta;
      const pattern = /(?:^|\n)(\[\[(sidecar(?:-progress)?):([0-9a-f-]{36})\]\]\n\[\[sidecar-reply:([0-9a-f-]{36})\]\]\n)/g;
      for (const match of message.raw.matchAll(pattern)) {
        const stream = streams.get(match[4]);
        if (!stream || stream.route.threadId !== match[3]) continue;
        const start = match.index + match[0].length - match[1].length;
        const suffix = match[2] === 'sidecar-progress' ? stream.progress.suffix : stream.suffix;
        const end = message.raw.indexOf(suffix, start + match[1].length);
        const raw = message.raw.slice(start, end < 0 ? undefined : end + suffix.length);
        let block = message.blocks.get(start);
        if (!block) { block = { index: 0, sent: 0, final: false }; message.blocks.set(start, block); }
        if (block.final || raw.length === block.sent && !part.final) continue;
        output.push({ stream, event: { ...event, messageId: `${event.messageId}:${start}`, index: block.index++, delta: raw.slice(block.sent), final: part.final } });
        block.sent = raw.length; block.final = part.final;
      }
      if (part.final) {
        this.messages.delete(key); this.completed.add(key);
        if (this.completed.size > 64) this.completed.delete(this.completed.values().next().value!);
        break;
      }
    }
    return output;
  }
}
