import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './support.ts';
import { readSourceFile } from '../src/documents.ts';
import { prepareFileWrite, publishFileWrite, discardFileWrite } from '../src/proposal-writes.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const save = (f: Awaited<ReturnType<typeof fixture>>, id: string, markdown: string, baseVersion: string) => f.view(`/api/documents/${id}/source`, { markdown, baseVersion });
const versionOf = async (f: Awaited<ReturnType<typeof fixture>>, id: string) => (await (await f.view(`/api/documents/${id}`)).json()).version as string;

test('save writes the file, records before and after versions, and returns the new version', async t => {
  const f = await fixture(t), doc = await f.register('a.md', '# A\n'), before = await versionOf(f, doc.id);
  const response = await save(f, doc.id, '# B\n', before);
  assert.equal(response.status, 200);
  const { version } = await response.json();
  assert.equal(version, sha('# B\n'));
  assert.equal(await readFile(doc.path, 'utf8'), '# B\n');
  for (const v of [before, version]) await access(join(f.directory, 'versions', doc.id, `${v}.md`));
});

test('save with a stale baseVersion is a 409 and leaves the agent text', async t => {
  const f = await fixture(t), doc = await f.register('a.md', '# A\n'), before = await versionOf(f, doc.id);
  await writeFile(doc.path, '# Agent\n');
  assert.equal((await save(f, doc.id, '# B\n', before)).status, 409);
  assert.equal(await readFile(doc.path, 'utf8'), '# Agent\n');
});

test('unchanged save writes nothing', async t => {
  const f = await fixture(t), doc = await f.register('a.md', '# A\n'), before = await versionOf(f, doc.id), mtime = (await stat(doc.path)).mtimeMs;
  await delay(20);
  const response = await save(f, doc.id, '# A\n', before);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).version, before);
  assert.equal((await stat(doc.path)).mtimeMs, mtime);
});

test('save refuses HTML documents and text with carriage returns', async t => {
  const f = await fixture(t), html = await f.register('p.html', '<p>x</p>'), crlf = await f.register('c.md', 'a\r\nb\r\n'), plain = await f.register('d.md', 'a\n');
  assert.equal((await save(f, html.id, 'y', sha('<p>x</p>'))).status, 400);
  assert.equal((await save(f, crlf.id, 'a\nb\n', sha('a\r\nb\r\n'))).status, 400);
  assert.equal((await save(f, plain.id, 'a\r\n', sha('a\n'))).status, 400);
  assert.equal(await readFile(html.path, 'utf8'), '<p>x</p>');
  assert.equal(await readFile(crlf.path, 'utf8'), 'a\r\nb\r\n');
  assert.equal(await readFile(plain.path, 'utf8'), 'a\n');
});

test('save accepts a large multi-byte document byte-exactly', async t => {
  const f = await fixture(t), doc = await f.register('a.md', '# A\n'), text = 'é漢\n'.repeat(300 * 1024 / 6 | 0);
  assert.ok(Buffer.byteLength(text) >= 250 * 1024);
  assert.equal((await save(f, doc.id, text, sha('# A\n'))).status, 200);
  assert.equal(await readFile(doc.path, 'utf8'), text);
});

test("save after a pending proposal's target is edited away marks it outdated", async t => {
  const f = await fixture(t), doc = await f.register('a.md', '# Original\n');
  const request = await (await f.view('/api/questions', { documentId: doc.id, text: 'Propose', clientMessageId: 'p' })).json();
  await f.agent(`/agent/requests/${request.id}/claim`, {});
  await f.agent('/agent/replies', { requestId: request.id, documentId: doc.id, threadId: request.threadId, text: `[[sidecar-meta ${JSON.stringify({ highlights: [{ exact: '# Original', proposal: { before: '# Original', after: '# Accepted' } }] })}]]\nReview this.` });
  const proposal = Object.values<any>((await (await f.view('/api/state')).json()).proposals)[0];
  assert.equal(proposal.status, 'pending');
  assert.equal((await save(f, doc.id, '# Different\n', sha('# Original\n'))).status, 200);
  for (let i = 0; i < 100; i++) {
    if ((await (await f.view('/api/state')).json()).proposals[proposal.id].status === 'outdated') return;
    await delay(20);
  }
  assert.fail('proposal never became outdated');
});

test('publish re-check refuses when the file changes between prepare and publish', async t => {
  const f = await fixture(t), doc = await f.register('a.md', '# A\n');
  const write = await prepareFileWrite(await readSourceFile(doc.path), '# B\n');
  await writeFile(doc.path, '# External\n');
  try { assert.throws(() => publishFileWrite(write, 'custom conflict'), { message: 'custom conflict' }); }
  finally { await discardFileWrite(write); }
  assert.equal(await readFile(doc.path, 'utf8'), '# External\n');
});

test('a stale-version 409 carries code and the current disk version', async t => {
  const f = await fixture(t), doc = await f.register('a.md', '# A\n'), before = await versionOf(f, doc.id);
  await writeFile(doc.path, '# Agent\n');
  const response = await save(f, doc.id, '# B\n', before);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'The document changed on disk. Review it again.', code: 'changed', version: sha('# Agent\n') });
});
