import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ViewerEvents } from '../web/viewer-events.ts';

test('viewer events preserve split updates, reconnect securely, and stop retrying after disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor(readonly url: URL) { sockets.push(this); }
    close() { this.onclose?.(); }
    send(data: string) { this.onmessage?.({ data }); }
  }
  const bootstraps: string[] = [];
  const fetchPage = async (url: string) => { bootstraps.push(url); return new Response(''); };
  const settled = () => new Promise(resolve => setImmediate(resolve));
  for (const [name, value] of Object.entries({ WebSocket: FakeSocket, fetch: fetchPage, location: { href: 'https://sidecar.example/a/o4/' } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  const events = new ViewerEvents('/a/o4/api/events?updates=1'), received: string[] = [];
  let opens = 0, errors = 0;
  events.onopen = () => { opens++; }; events.onerror = () => { errors++; };
  events.addEventListener('runtime', event => received.push(event.data));
  events.addEventListener('change', event => received.push(event.data));
  assert.equal(sockets[0].url.href, 'wss://sidecar.example/a/o4/api/events?updates=1');
  sockets[0].onopen?.();
  sockets[0].send(': keepalive\n\nevent: runt');
  sockets[0].send('ime\ndata: {"text":"café 🐈"}');
  assert.deepEqual(received, []);
  sockets[0].send('\n\nevent: change\ndata: {}\n\nevent: runtime\ndata: unfinished');
  assert.deepEqual(received, ['{"text":"café 🐈"}', '{}']);
  sockets[0].close(); assert.equal(errors, 1);
  t.mock.timers.tick(250); await settled(); assert.equal(sockets.length, 2);
  // A failed handshake retries with backoff, without another HTTP event stream.
  sockets[1].close(); t.mock.timers.tick(499); assert.equal(sockets.length, 2);
  t.mock.timers.tick(1); await settled(); assert.equal(sockets.length, 3);
  sockets[2].onopen?.(); sockets[2].send('event: runtime\ndata: fresh\n\n');
  assert.equal(opens, 2); assert.deepEqual(received, ['{"text":"café 🐈"}', '{}', 'fresh']);
  sockets[2].close(); events.close(); t.mock.timers.tick(10000);
  assert.equal(sockets.length, 3);
  assert.deepEqual(bootstraps, ['https://sidecar.example/a/o4/', 'https://sidecar.example/a/o4/']);
});
