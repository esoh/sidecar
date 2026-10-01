import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { notifyCodex, selectOwner } from '../src/agent.ts';
import { fixture } from './support.ts';
import { ownerKey } from '../src/store.ts';
const exec = promisify(execFile);
const cliPath = new URL('../src/cli.ts', import.meta.url).pathname;
const tsx = import.meta.resolve('tsx');

test('short Codex notification targets the native UUID and leaves full context in the inbox', async t => {
  const f = await fixture(t);
  const doc = await f.register();
  const comment = '$(touch should-not-exist); `false` '.padEnd(10000, 'x');
  assert.equal(comment.length, 10000);
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: comment, clientMessageId: 'long' })).json();
  const executable = join(f.directory, 'codex');
  const output = join(f.directory, 'args.json');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(executable, 0o700);
  const previous = process.env.PATH;
  process.env.PATH = `${f.directory}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  const owner = { agent: 'codex' as const, sessionId: randomUUID() };
  await notifyCodex(owner, request.id);
  const args = JSON.parse(await readFile(output, 'utf8'));
  const notification = args[4];
  assert.ok(Buffer.byteLength(notification) < 300);
  assert.deepEqual(args, ['queue', '--thread', owner.sessionId, '--message', notification]);
  assert.equal(JSON.parse(notification).requestId, request.id);
  assert.doesNotMatch(notification, /touch|false|x{20}/);
  const full = await (await f.agent(`/agent/requests/${request.id}/claim`, {})).json();
  assert.equal(full.request.text.length, 10000);
  assert.equal((await (await f.agent(`/agent/requests/${request.id}/claim`, {})).json()).claimStatus, 'already-claimed');
});

test('a reconnect re-announces a queued request and never creates duplicate messages', async t => {
  const f = await fixture(t), doc = await f.register();
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Question', clientMessageId: 'q' })).json();
  for (let i = 0; i < 2; i++) {
    const abort = new AbortController();
    const response = await fetch(f.url + '/agent/events', { signal: abort.signal, headers: { 'X-Sidecar-Token': f.token } });
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    assert.equal(JSON.parse(new TextDecoder().decode(chunk.value).trim()).requestId, request.id);
    abort.abort();
    await reader.cancel().catch(() => {});
  }
  const state = await (await f.view('/api/state')).json();
  assert.equal(state.threads[request.threadId].messages.length, 1);
  assert.equal(state.requests[request.id].status, 'queued');
});

test('owner selection uses only the selected native environment and rejects conflicts', () => {
  const codex = randomUUID(), claude = randomUUID();
  const env = { CODEX_THREAD_ID: codex, CLAUDE_SESSION_ID: claude };
  assert.deepEqual(selectOwner('codex', undefined, env), { agent: 'codex', sessionId: codex });
  assert.deepEqual(selectOwner('claude', undefined, env), { agent: 'claude', sessionId: claude });
  assert.throws(() => selectOwner('codex', claude, env), /conflict/i);
  assert.throws(() => selectOwner('claude', undefined, { CODEX_THREAD_ID: codex }), /session/i);
  assert.throws(() => selectOwner('codex', '../../bad', {}));
  assert.deepEqual(selectOwner('claude', undefined, { CLAUDE_CODE_SESSION_ID: claude }), { agent: 'claude', sessionId: claude });
  assert.throws(() => selectOwner('claude', codex, { CLAUDE_CODE_SESSION_ID: claude }), /conflict/i);
  assert.throws(() => selectOwner('claude', undefined, { CLAUDE_CODE_SESSION_ID: claude, CLAUDE_SESSION_ID: codex }), /conflict/i);
});

test('simultaneous CLI opens reuse one app; stop and reopen retain pending work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-cli-'));
  const owner = { agent: 'claude' as const, sessionId: randomUUID() }, key = ownerKey(owner);
  const env = { ...process.env, SIDECAR_STATE_DIR: root, CLAUDE_SESSION_ID: owner.sessionId, PATH: `${root}:${process.env.PATH}` };
  await mkdir(join(root, key));
  await writeFile(join(root, key, 'owner.lock'), '999999999');
  const opener = join(root, process.platform === 'darwin' ? 'open' : 'xdg-open');
  await writeFile(opener, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(root, 'opener.json'))}, JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(opener, 0o700);
  const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, ['--import', tsx, cliPath, ...args], { env })).stdout);
  t.after(async () => { await cli('stop', '--owner', key).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const file = join(root, 'review.md');
  await writeFile(file, '# Review\n');
  const launch = () => cli('open', '--agent', 'claude', '--session', owner.sessionId, '--file', file, '--no-browser');
  const [a, b] = await Promise.all([launch(), launch()]);
  assert.equal(a.url, b.url); assert.equal(a.documentId, b.documentId);
  const first = await cli('status', '--owner', key);
  const base = new URL(a.url).origin;
  const cookie = (await fetch(base)).headers.get('set-cookie')!.split(';')[0]!;
  const request = await (await fetch(base + '/api/questions', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: a.documentId, text: 'Keep me', clientMessageId: 'keep' }) })).json();
  const watcher = spawn(process.execPath, ['--import', tsx, cliPath, 'watch', '--owner', key], { env });
  t.after(() => watcher.kill());
  const event = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Watcher did not receive request')), 3000);
    watcher.stdout.once('data', chunk => { clearTimeout(timer); resolve(String(chunk).trim()); });
  });
  assert.equal(JSON.parse(event).requestId, request.id);
  const ended = new Promise(resolve => watcher.once('exit', resolve));
  await cli('stop', '--owner', key);
  await ended;
  assert.equal((await cli('status', '--owner', key)).state, 'stopped');
  const c = await launch();
  assert.equal(c.documentId, a.documentId);
  assert.notEqual((await cli('status', '--owner', key)).instanceId, first.instanceId);
  const full = await cli('request', request.id, '--owner', key);
  assert.equal(full.request.text, 'Keep me');
  const runtime = await readFile(join(root, key, 'runtime.json'), 'utf8');
  const token = await readFile(join(root, key, 'agent-token'), 'utf8');
  assert.ok(!runtime.includes(token));
  assert.ok(!a.url.includes(token));
  const opened = await cli('open', '--agent', 'claude', '--session', owner.sessionId, '--file', file);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'opener.json'), 'utf8')), [opened.url]);
});

test('unavailable native queue reports a connection error while preserving the request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-queue-'));
  const owner = { agent: 'codex' as const, sessionId: randomUUID() };
  const { startServer } = await import('../src/server.ts');
  const previous = process.env.PATH;
  process.env.PATH = root;
  const server = await startServer({ owner, directory: root });
  t.after(async () => { process.env.PATH = previous; await server.close(); await rm(root, { recursive: true, force: true }); });
  const token = await readFile(join(root, 'agent-token'), 'utf8');
  const file = join(root, 'a.md'); await writeFile(file, '# A\n');
  const doc = await (await fetch(server.url + '/agent/documents', { method: 'POST', headers: { 'X-Sidecar-Token': token }, body: JSON.stringify({ path: file }) })).json();
  const cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0]!;
  await fetch(server.url + '/api/questions', { method: 'POST', headers: { Cookie: cookie, Origin: server.url }, body: JSON.stringify({ documentId: doc.id, text: 'Queued', clientMessageId: 'q' }) });
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(server.url + '/api/state', { headers: { Cookie: cookie } })).json();
    if (state.connectionError) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match(state.connectionError, /Codex notification failed/);
  assert.equal(Object.values<any>(state.requests)[0].status, 'queued');
});


for (const agent of ['claude', 'codex'] as const) test(`request --stream returns ${agent} context and preserves claim safety`, async t => {
  const root = await mkdtemp(join(tmpdir(), 's'));
  const owner = { agent, sessionId: randomUUID() }, key = ownerKey(owner);
  const { startServer } = await import('../src/server.ts');
  const previousHome = process.env.CODEX_HOME, previousPath = process.env.PATH;
  await writeFile(join(root, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  process.env.PATH = `${root}:${previousPath}`;
  process.env.CODEX_HOME = root; // No native daemon: exercise Codex stream setup failure.
  const directory = join(root, key);
  const server = await startServer({ owner, directory });
  t.after(async () => {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    process.env.PATH = previousPath;
    await server.close(); await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ url: server.url, instanceId: server.instanceId, ownerKey: key }));
  const token = await readFile(join(directory, 'agent-token'), 'utf8');
  const file = join(root, 'a.md'); await writeFile(file, '# Context\nBody to preserve.');
  const post = (path: string, body: unknown) => fetch(server.url + path, { method: 'POST', headers: { 'X-Sidecar-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const doc = await (await post('/agent/documents', { path: file })).json();
  const cookie = (await fetch(server.url)).headers.get('set-cookie')!.split(';')[0]!;
  const request = await (await fetch(server.url + '/api/questions', { method: 'POST', headers: { Cookie: cookie, Origin: server.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: doc.id, text: 'Explain the context', clientMessageId: 'combined' }) })).json();
  const run = async () => JSON.parse((await exec(process.execPath, ['--import', tsx, cliPath, 'request', request.id, '--owner', key, '--stream'], { env: { ...process.env, SIDECAR_STATE_DIR: root } })).stdout);
  const claimed = await run();
  assert.equal(claimed.claimStatus, 'claimed');
  assert.equal(claimed.request.text, 'Explain the context');
  assert.equal(claimed.document.markdown, '# Context\nBody to preserve.');
  assert.equal(claimed.thread.id, request.threadId);
  assert.ok(claimed.stream, 'one command must include the streaming result');
  if (agent === 'claude') {
    assert.equal(typeof claimed.stream.prefix, 'string');
    assert.equal(typeof claimed.stream.suffix, 'string');
  } else assert.equal(typeof claimed.stream.error, 'string');
  await exec(process.execPath, ['--import', tsx, cliPath, 'name-thread', request.threadId, '--owner', key, '--title', 'Understanding the context'], { env: { ...process.env, SIDECAR_STATE_DIR: root } });
  const duplicate = await run();
  assert.equal(duplicate.claimStatus, 'already-claimed');
  assert.equal(duplicate.thread.title, 'Understanding the context');
  assert.equal(duplicate.stream, undefined);
  const route = { requestId: request.id, documentId: doc.id, threadId: request.threadId };
  if (agent === 'claude') await post('/agent/stream-events', { ownerKey: key, messageId: 'answer', turnId: 'turn', index: 0, delta: claimed.stream.prefix + 'Answer' + claimed.stream.suffix, final: true });
  else await post('/agent/replies', { ...route, text: 'Answer' });
  const completed = await run();
  assert.equal(completed.claimStatus, 'completed');
  assert.equal(completed.stream, undefined);
  assert.equal(completed.thread.messages.length, 2);
});
