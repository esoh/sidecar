import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, chmod, stat, readdir, rename, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as documents from '../src/documents.ts';

test('guarded publication preserves untouched BOM, CRLF, Unicode and file permissions', async t => {
  const { prepareFileWrite, publishFileWrite, discardFileWrite } = await import('../src/proposal-writes.ts');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-write-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'document.md'); await writeFile(file, '\uFEFF# Heading\r\nKeep 😀\r\nBefore\r\n', { mode: 0o640 });
  const source = await documents.readSourceFile(file), next = source.markdown.replace('Before', '**After**');
  const prepared = await prepareFileWrite(source, next);
  assert.equal(await readFile(file, 'utf8'), source.markdown);
  publishFileWrite(prepared); await discardFileWrite(prepared);
  assert.deepEqual(await readFile(file), Buffer.from('\uFEFF# Heading\r\nKeep 😀\r\n**After**\r\n'));
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.equal(prepared.afterVersion, createHash('sha256').update(await readFile(file)).digest('hex'));
  assert.deepEqual(await readdir(directory), ['document.md']);
  assert.deepEqual(Object.keys(await documents.readDocument(file)).sort(), ['heading', 'html', 'markdown', 'version']);
});

test('invalid UTF-8 cannot be silently re-encoded by a proposed write', async t => {
  const { prepareFileWrite } = await import('../src/proposal-writes.ts');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-write-invalid-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'document.md'), bytes = Buffer.from([0x41, 0xff, 0x42]); await writeFile(file, bytes);
  const source = await documents.readSourceFile(file);
  await assert.rejects(prepareFileWrite(source, 'replacement'), /UTF-8/);
  assert.deepEqual(await readFile(file), bytes); assert.deepEqual(await readdir(directory), ['document.md']);
});

test('guarded writes refuse external edits, inode replacements, symlinks, changed permissions and missing files', async t => {
  const { prepareFileWrite, publishFileWrite, discardFileWrite } = await import('../src/proposal-writes.ts');
  for (const mutation of ['edit', 'inode', 'symlink', 'mode', 'missing']) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-write-conflict-'))); t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'document.md'); await writeFile(file, 'before');
    const source = await documents.readSourceFile(file), prepared = await prepareFileWrite(source, 'after');
    if (mutation === 'edit') await writeFile(file, 'external');
    if (mutation === 'inode') { await writeFile(join(directory, 'new.md'), 'before'); await rename(join(directory, 'new.md'), file); }
    if (mutation === 'symlink') { await rename(file, join(directory, 'other.md')); await symlink(join(directory, 'other.md'), file); }
    if (mutation === 'mode') await chmod(file, 0o400);
    if (mutation === 'missing') await rm(file);
    assert.throws(() => publishFileWrite(prepared));
    await discardFileWrite(prepared);
    if (mutation !== 'missing') assert.equal(await readFile(file, 'utf8'), mutation === 'edit' ? 'external' : 'before');
    assert.ok((await readdir(directory)).every(name => !name.endsWith('.tmp')));
  }
});

test('source reader rejects symlinks and directories; failed publication leaves the source intact', async t => {
  const { prepareFileWrite, publishFileWrite, discardFileWrite } = await import('../src/proposal-writes.ts');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-write-path-'))); t.after(async () => { await chmod(directory, 0o700); await rm(directory, { recursive: true, force: true }); });
  const file = join(directory, 'document.md'); await writeFile(file, 'before'); await symlink(file, join(directory, 'alias.md'));
  await assert.rejects(documents.readSourceFile(join(directory, 'alias.md')), /symlink/);
  await assert.rejects(documents.readSourceFile(directory), /regular/);
  const prepared = await prepareFileWrite(await documents.readSourceFile(file), 'after');
  await chmod(directory, 0o500);
  assert.throws(() => publishFileWrite(prepared));
  await chmod(directory, 0o700); await discardFileWrite(prepared);
  assert.equal(await readFile(file, 'utf8'), 'before'); assert.ok((await readdir(directory)).every(name => !name.endsWith('.tmp')));
});
