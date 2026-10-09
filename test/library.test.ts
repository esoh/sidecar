import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listLibrary, readLibrarySession } from '../src/library.ts';
import { startServer } from '../src/server.ts';
import { createState, registerDocument, ownerKey, submit, claim, recordProgress, reply } from '../src/store.ts';
import { fixture, gatewayConfig } from './support.ts';
const exec = promisify(execFile), cliPath = new URL('../src/cli.ts', import.meta.url).pathname, tsx = import.meta.resolve('tsx');

test('library activity uses inputs and agent messages, not empty-thread creation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-library-message-time-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = createState({ agent: 'codex', sessionId: randomUUID() });
  const directory = join(root, ownerKey(state.owner)); await mkdir(directory);
  const doc = registerDocument(state, { path: join(directory, 'review.md'), title: 'Review', generated: false });
  const updated = async () => {
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
    return (await listLibrary(root)).sessions[0].documents[0].updatedAt;
  };
  assert.equal(await updated(), 0);
  const request = submit(state, { documentId: doc.id, clientMessageId: randomUUID(), text: 'Question' });
  const thread = state.threads[request.threadId];
  thread.messages.at(-1)!.createdAt = 1000;
  assert.equal(await updated(), 1000);
  claim(state, request.id, {});
  const route = { requestId: request.id, documentId: doc.id, threadId: request.threadId };
  recordProgress(state, { ...route, messageId: 'progress', text: 'Checking' });
  thread.messages.at(-1)!.createdAt = 2000;
  assert.equal(await updated(), 2000);
  reply(state, { ...route, text: 'Answer' });
  thread.messages.at(-1)!.createdAt = 3000;
  assert.equal(await updated(), 3000);
});

test('library exposes saved workspaces and branches, abbreviating only the actual home directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-library-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = createState({ agent: 'codex', sessionId: randomUUID() });
  const directory = join(root, ownerKey(state.owner)); await mkdir(directory);
  const cases = [
    { workspace: homedir(), displayPath: '~' },
    { workspace: join(homedir(), 'work', 'linked-tree'), displayPath: join('~', 'work', 'linked-tree') },
    { workspace: homedir() + '-other', displayPath: homedir() + '-other' },
    { workspace: root, displayPath: root },
    { workspace: undefined, displayPath: undefined },
  ];
  const docs = cases.map(({ workspace }, index) => registerDocument(state, { path: join(directory, `${index}.md`), title: String(index), generated: false,
    ...(workspace ? { workspace, repoInfo: { display: 'example', branch: 'feat/review' } } : {}) }));
  const saved = JSON.stringify(state); await writeFile(join(directory, 'state.json'), saved);
  const library = await listLibrary(root);
  for (const [index, expected] of cases.entries()) {
    const doc = library.sessions[0].documents.find(document => document.id === docs[index].id)!;
    assert.deepEqual(doc.workspace, expected.workspace ? { path: expected.workspace, displayPath: expected.displayPath, branch: 'feat/review' } : undefined);
  }
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), saved);
});

test('all-agent library verifies original viewers and previews stopped sessions without altering saved state', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-library-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = createState({ agent: 'codex', sessionId: randomUUID() }), key = ownerKey(original.owner);
  const directory = join(root, key); await mkdir(directory);
  const file = join(directory, 'review.md'); await writeFile(file, '# Original review\n\n![local](image.svg)');
  await writeFile(join(directory, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(root, 'outside.svg'), '<svg/>');
  const doc = registerDocument(original, { path: file, generated: false });
  const saved = JSON.stringify(original); await writeFile(join(directory, 'state.json'), saved);
  const owner = { agent: 'claude' as const, sessionId: randomUUID() }, hostKey = ownerKey(owner);
  const host = await startServer({ owner, directory: join(root, hostKey), stateRoot: root });
  t.after(() => host.close());
  await writeFile(join(root, hostKey, 'runtime.json'), JSON.stringify({ url: host.url, instanceId: host.instanceId, ownerKey: hostKey }));
  const token = await readFile(join(root, hostKey, 'agent-token'), 'utf8');
  await fetch(host.url + '/agent/documents', { method: 'POST', headers: { 'X-Sidecar-Token': token }, body: JSON.stringify({ path: file, title: 'Current review' }) });
  const cookie = (await fetch(host.url)).headers.get('set-cookie')!.split(';')[0]!;
  const get = (path: string) => fetch(host.url + path, { headers: { Cookie: cookie } });
  assert.equal((await fetch(host.url + '/api/library')).status, 403);
  const result = await (await get('/api/library')).json();
  assert.equal(result.sessions.length, 2);
  assert.equal(result.unavailable, 0);
  assert.equal(result.sessions.find((session: any) => session.ownerKey === hostKey).url, host.url);
  const offline = result.sessions.find((session: any) => session.ownerKey === key);
  assert.equal(offline.url, null); assert.equal(offline.owner.sessionId, original.owner.sessionId);
  assert.equal(offline.documents[0].title, 'Original review');
  const preview = await (await get(`/api/library/${key}/documents/${doc.id}`)).json();
  assert.equal(preview.markdown, await readFile(file, 'utf8'));
  assert.equal((await get(`/api/image?owner=${key}&document=${doc.id}&path=image.svg`)).status, 200);
  assert.equal((await get(`/api/image?owner=${key}&document=${doc.id}&path=../outside.svg`)).status, 403);
  assert.equal((await get(`/api/library/${key}/documents/__proto__`)).status, 404);
  assert.equal((await get(`/api/library/not-an-owner/documents/${doc.id}`)).status, 400);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), saved);
  await assert.rejects(readFile(join(directory, 'runtime.json')), { code: 'ENOENT' });
});

for (const agent of ['codex', 'claude'] as const) test(`library closes a stopped ${agent} document without touching its file or other requests`, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-library-close-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await fixture(t, 20, root);
  const state = createState({ agent, sessionId: randomUUID() }), key = ownerKey(state.owner), directory = join(root, key);
  await mkdir(directory);
  const path = join(directory, 'close.md'); await writeFile(path, '# Keep the file\n');
  const doc = registerDocument(state, { path, generated: true });
  const other = registerDocument(state, { path: join(directory, 'other.md'), generated: false });
  await writeFile(other.path, '# Other');
  const otherRequest = submit(state, { clientMessageId: randomUUID(), documentId: other.id, threadId: Object.values(state.threads).find(thread => thread.documentId === other.id)!.id, text: 'Still working elsewhere' });
  claim(state, otherRequest.id, {});
  const retainedThread = structuredClone(state.threads[otherRequest.threadId]);
  const retainedRequest = structuredClone(state.requests[otherRequest.id]);
  await mkdir(join(directory, 'versions', doc.id), { recursive: true });
  await writeFile(join(directory, 'versions', doc.id, 'snapshot.md'), '# Old');
  await mkdir(join(directory, 'opened')); await writeFile(join(directory, 'opened', doc.id), '');
  await writeFile(join(directory, 'state.json'), JSON.stringify(state));
  const response = await host.view(`/api/library/${key}/documents/${doc.id}`, undefined, 'DELETE');
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).documentId, doc.id);
  const saved = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.documents), [other.id]);
  assert.deepEqual(saved.threads, { [otherRequest.threadId]: retainedThread });
  assert.deepEqual(saved.requests, { [otherRequest.id]: retainedRequest });
  assert.equal(await readFile(path, 'utf8'), '# Keep the file\n');
  await assert.rejects(readFile(join(directory, 'versions', doc.id, 'snapshot.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'opened', doc.id)), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'owner.lock')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'runtime.json')), { code: 'ENOENT' });
});

test('library closes through the original live viewer so its in-memory state cannot resurrect a document', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-library-live-close-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await fixture(t, 20, root), original = await fixture(t, 20, root);
  const doc = await original.register(), other = await original.register('other.md', '# Keep me');
  const key = ownerKey(original.owner), route = `/api/library/${key}/documents/${doc.id}`;
  await writeFile(join(original.directory, 'owner.lock'), String(process.pid));
  const queued = await (await original.view('/api/questions', { clientMessageId: randomUUID(), documentId: doc.id, text: 'Pending work' })).json();
  const before = await readFile(join(original.directory, 'state.json'), 'utf8');
  assert.equal((await host.view(route, undefined, 'DELETE')).status, 409);
  assert.equal(await readFile(join(original.directory, 'state.json'), 'utf8'), before);
  await original.agent(`/agent/requests/${queued.id}/claim`, {});
  await original.agent('/agent/replies', { requestId: queued.id, documentId: doc.id, threadId: queued.threadId, text: 'Done' });
  assert.equal((await host.view(route, undefined, 'DELETE')).status, 200);
  const state = await (await original.view('/api/state')).json();
  assert.deepEqual(Object.keys(state.documents), [other.id]);
  assert.equal(state.requests[queued.id], undefined);
  assert.ok(await readFile(doc.path, 'utf8'));
  await original.register('third.md', '# Third');
  assert.equal(JSON.parse(await readFile(join(original.directory, 'state.json'), 'utf8')).documents[doc.id], undefined);
  // The same library action works for its own owner without trying to take its own lock.
  const own = await host.register();
  assert.equal((await host.view(`/api/library/${ownerKey(host.owner)}/documents/${own.id}`, undefined, 'DELETE')).status, 200);
  assert.deepEqual((await (await host.view('/api/state')).json()).documents, {});
});

test('library close refuses pending, locked, malformed and unauthenticated targets without modifying their state', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-library-refuse-close-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await fixture(t, 20, root), state = createState({ agent: 'codex', sessionId: randomUUID() });
  const key = ownerKey(state.owner), directory = join(root, key); await mkdir(directory);
  const doc = registerDocument(state, { path: join(directory, 'review.md'), generated: false });
  const route = `/api/library/${key}/documents/${doc.id}`, file = join(directory, 'state.json');
  const bytes = JSON.stringify(state); await writeFile(file, bytes);
  for (const headers of [new Headers(), new Headers({ Cookie: host.cookie, Origin: 'http://evil.example' })])
    assert.equal((await fetch(host.url + route, { method: 'DELETE', headers })).status, 403);
  await writeFile(join(directory, 'owner.lock'), String(process.pid));
  assert.equal((await host.view(route, undefined, 'DELETE')).status, 409);
  assert.equal(await readFile(file, 'utf8'), bytes);
  await rm(join(directory, 'owner.lock'));
  submit(state, { clientMessageId: randomUUID(), documentId: doc.id, text: 'Pending' });
  const pending = JSON.stringify(state); await writeFile(file, pending);
  assert.equal((await host.view(route, undefined, 'DELETE')).status, 409);
  assert.equal(await readFile(file, 'utf8'), pending);
  await writeFile(file, '{broken');
  assert.equal((await host.view(route, undefined, 'DELETE')).ok, false);
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await assert.rejects(readFile(join(directory, 'owner.lock')), { code: 'ENOENT' });
  assert.equal((await host.view(`/api/library/not-an-owner/documents/${doc.id}`, undefined, 'DELETE')).status, 400);
});

for (const agent of ['codex', 'claude'] as const) test(`confirmed cleanup discards unfinished documents for a stopped ${agent} without requiring the native agent`, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-library-discard-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await fixture(t, 20, root), state = createState({ agent, sessionId: randomUUID() });
  const key = ownerKey(state.owner), directory = join(root, key); await mkdir(directory);
  const doc = registerDocument(state, { path: join(directory, 'review.md'), generated: true });
  await writeFile(doc.path, '# Preserve the source');
  for (const status of ['queued', 'claimed', 'uncertain'] as const) {
    const request = submit(state, { clientMessageId: randomUUID(), documentId: doc.id, text: status });
    request.status = status;
  }
  await writeFile(join(directory, 'state.json'), JSON.stringify(state));
  const route = `/api/library/${key}/documents/${doc.id}`;
  assert.equal((await host.view(route, undefined, 'DELETE')).status, 409);
  const result = await host.view(route + '?discardPending=true', undefined, 'DELETE');
  assert.equal(result.status, 200, await result.clone().text());
  const saved = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  for (const field of ['documents', 'threads', 'requests', 'proposals', 'proposalWrites']) assert.deepEqual(saved[field], {});
  assert.equal(await readFile(doc.path, 'utf8'), '# Preserve the source');
  await assert.rejects(readFile(join(directory, 'runtime.json')), { code: 'ENOENT' });
});

test('confirmed live cleanup retires capture and ignores late replies without disturbing other documents', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-library-live-discard-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await fixture(t, 20, root), original = await fixture(t, 20, root);
  const doc = await original.register(), other = await original.register('other.md', '# Keep');
  const request = await (await original.view('/api/questions', { clientMessageId: randomUUID(), documentId: doc.id, text: 'In progress' })).json();
  const route = { requestId: request.id, documentId: doc.id, threadId: request.threadId };
  await original.agent(`/agent/requests/${request.id}/claim`, {});
  const markers = await (await original.agent('/agent/streams', route)).json();
  const event = { ownerKey: ownerKey(original.owner), messageId: 'partial', turnId: 'active', index: 0 };
  await original.agent('/agent/stream-events', { ...event, delta: markers.prefix + 'Partial answer', final: false });
  assert.equal((await (await original.view('/api/state')).json()).stream.text, 'Partial answer');
  await original.view(`/api/documents/${doc.id}`);
  const response = await host.view(`/api/library/${ownerKey(original.owner)}/documents/${doc.id}?discardPending=true`, undefined, 'DELETE');
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await original.agent('/agent/stream-events', { ...event, index: 1, delta: ' finishes' + markers.suffix, final: true })).status, 200);
  assert.equal((await original.agent('/agent/replies', { ...route, text: 'Late reply' })).status, 404);
  const saved = await (await original.view('/api/state')).json();
  assert.deepEqual(Object.keys(saved.documents), [other.id]);
  assert.deepEqual(saved.requests, {}); assert.equal(saved.stream, null); assert.deepEqual(saved.streams, []);
  assert.equal(saved.connectionError, null);
  assert.ok(await readFile(doc.path, 'utf8'));
  await assert.rejects(readFile(join(original.directory, 'versions', doc.id)), { code: 'ENOENT' });
  await original.register('third.md');
  assert.equal((await (await original.view('/api/state')).json()).documents[doc.id], undefined);
});

for (const agent of ['codex', 'claude'] as const) test(`browse from ${agent} opens the gateway without registering an owner`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-browse-'));
  const sessionId = randomUUID(), key = ownerKey({ agent, sessionId });
  const env: NodeJS.ProcessEnv = { ...process.env, SIDECAR_STATE_DIR: root, SIDECAR_CONFIG: await gatewayConfig(root), PATH: `${root}:${process.env.PATH}` };
  delete env.CODEX_THREAD_ID; delete env.CLAUDE_SESSION_ID; delete env.CLAUDE_CODE_SESSION_ID;
  if (agent === 'codex') env.CODEX_THREAD_ID = sessionId; else env.CLAUDE_CODE_SESSION_ID = sessionId;
  const opener = join(root, process.platform === 'darwin' ? 'open' : 'xdg-open');
  await writeFile(opener, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(root, 'opened.json'))}, JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(opener, 0o700);
  const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, ['--import', tsx, cliPath, ...args], { env })).stdout);
  t.after(async () => { await cli('gateway', 'stop').catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const opened = await cli('browse');
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/$/); assert.equal(opened.ownerKey, undefined);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'opened.json'), 'utf8')), [opened.url]);
  assert.equal((await cli('browse', '--agent', agent, '--no-browser')).url, opened.url);
  await assert.rejects(readFile(join(root, key, 'state.json')), { code: 'ENOENT' });
});

test('document opens persist across servers and sort each agent by its most recently opened document', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-opened-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owners = [{ agent: 'claude' as const, sessionId: randomUUID() }, { agent: 'codex' as const, sessionId: randomUUID() }];
  const docs: any[] = [];
  for (const owner of owners) {
    const state = createState(owner), directory = join(root, ownerKey(owner)); await mkdir(directory);
    for (const name of ['one', 'two']) {
      const path = join(directory, `${name}.md`); await writeFile(path, `# ${name}`);
      docs.push(registerDocument(state, { path, generated: false }));
    }
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
  }
  const host = await startServer({ owner: owners[0], directory: join(root, ownerKey(owners[0])), stateRoot: root }); t.after(() => host.close());
  const cookie = (await fetch(host.url)).headers.get('set-cookie')!.split(';')[0]!;
  const request = (path: string, method = 'GET') => fetch(host.url + path, { method, headers: { Cookie: cookie, Origin: host.url } });
  const list = async () => (await request('/api/library')).json();
  assert.equal((await list()).sessions[0].documents[0].lastOpenedAt, null);
  assert.equal((await request(`/api/library/${ownerKey(owners[1])}/documents/${docs[3].id}/opened`, 'POST')).status, 200);
  let result = await list();
  assert.equal(result.sessions[0].ownerKey, ownerKey(owners[1]));
  assert.equal(result.sessions[0].documents[0].id, docs[3].id);
  const firstOpened = result.sessions[0].documents[0].lastOpenedAt;
  assert.ok(firstOpened > Date.now() - 10000);
  assert.equal((await request(`/api/documents/${docs[0].id}/opened`, 'POST')).status, 200);
  result = await list();
  assert.equal(result.sessions[0].ownerKey, ownerKey(owners[0]));
  assert.equal(result.sessions[0].documents[0].id, docs[0].id);
  assert.ok(result.sessions[0].documents[0].lastOpenedAt >= firstOpened);
  assert.equal((await request(`/api/documents/${randomUUID()}/opened`, 'POST')).status, 404);
  await host.close();
  const { listLibrary } = await import('../src/library.ts');
  assert.equal((await listLibrary(root)).sessions[0].documents[0].id, docs[0].id);
});

for (const version of [1, 2, 3]) test(`library normalizes saved v${version} without writing state or backup`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-library-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = { agent: 'codex' as const, sessionId: randomUUID() }, key = ownerKey(owner);
  const directory = join(root, key); await mkdir(directory);
  const saved = { version, owner, documents: {}, threads: {}, requests: {} };
  const bytes = JSON.stringify(saved, null, 2) + '\n';
  await writeFile(join(directory, 'state.json'), bytes);
  const normalized = await readLibrarySession(root, key);
  assert.equal(normalized.version, 5);
  assert.deepEqual(normalized.proposals, {});
  assert.deepEqual(normalized.proposalWrites, {});
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), bytes);
  await assert.rejects(readFile(join(directory, `state.v${version}.backup.json`)), { code: 'ENOENT' });
});
