import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { authorizePath, listDirectory, readCode, readPreview, type DirectoryEntry } from '../src/files.ts';
import { fixture } from './support.ts';

const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd });
async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
}
const names = (nodes: DirectoryEntry[]) => nodes.map(node => node.type === 'folder' ? `${node.name}/` : node.name).sort();

test('listing is one directory deep, follows Plannotator file types and exclusions, folders first', async t => {
  const root = await workspace(t);
  await write(root, {
    'README.md': '# Hi', 'docs/plan.md': '# Plan', 'docs/flow.mmd': 'graph TD; A-->B', 'page.html': '<p>x</p>',
    'config.yaml': 'a: 1', 'src.ts': 'export {}', '.env': 'SECRET=1', '.env.example': 'SECRET=',
    'node_modules/pkg/README.md': '# dep', '.claude/worktrees/x/notes.md': '# nested worktree',
  });
  const listing = await listDirectory(root);
  assert.equal(listing.dir, root);
  assert.equal(listing.entries[0].type, 'folder');
  assert.deepEqual(names(listing.entries), ['.env.example', 'README.md', 'config.yaml', 'docs/', 'page.html', 'src.ts']);
  assert.deepEqual(listing.entries.find(entry => entry.name === 'docs'), { name: 'docs', path: join(root, 'docs'), type: 'folder' });
  assert.deepEqual(names((await listDirectory(join(root, 'docs'))).entries), ['flow.mmd', 'plan.md']);
  await assert.rejects(listDirectory(join(root, 'missing')), { status: 404 });
});

test('previews stay inside the workspace and say how to render', async t => {
  const root = await workspace(t), outside = await workspace(t);
  await write(outside, { 'secret.md': '# secret' });
  await write(root, {
    'docs/plan.md': '# Plan', 'flow.mmd': 'graph TD; A-->B', 'graph.gv': 'digraph { a -> b }', 'page.html': '<p>x</p>',
    'notes.txt': 'plain', 'src.ts': 'export {}', '.env': 'SECRET=1', 'node_modules/pkg/README.md': '# dep',
    'big.md': 'x'.repeat(2 * 1024 * 1024 + 1),
  });
  await symlink(join(outside, 'secret.md'), join(root, 'escape.md'));
  assert.deepEqual(await readPreview(root, 'docs/plan.md'), { path: 'docs/plan.md', text: '# Plan', renderAs: 'markdown' });
  assert.equal((await readPreview(root, 'notes.txt')).renderAs, 'markdown');
  assert.equal((await readPreview(root, 'flow.mmd')).renderAs, 'mermaid');
  assert.equal((await readPreview(root, 'graph.gv')).renderAs, 'graphviz');
  assert.equal((await readPreview(root, 'page.html')).renderAs, 'html');
  const status = (path: string) => readPreview(root, path).then(() => 200, (error: { status?: number }) => error.status);
  assert.equal(await status(`../${basename(outside)}/secret.md`), 403);
  assert.equal(await status(join(outside, 'secret.md')), 400);
  assert.equal(await status('escape.md'), 403);
  assert.equal(await status('src.ts'), 415);
  assert.equal(await status('.env'), 415);
  assert.equal(await status('node_modules/pkg/README.md'), 415);
  assert.equal(await status('big.md'), 413);
  assert.equal(await status('missing.md'), 404);
  assert.equal(await status(''), 400);
});

test('viewer file routes default to the workspace and allow an explicit browsing directory', async t => {
  const root = await workspace(t);
  await write(root, { 'notes.md': '# Notes', 'sub/inner.md': '# Inner' });
  const f = await fixture(t), doc = await f.register();
  assert.equal((await f.view(`/api/files?document=${doc.id}`)).status, 404);
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  const listing = await (await f.view(`/api/files?document=${doc.id}`)).json();
  assert.equal(listing.dir, root);
  assert.deepEqual(names(listing.entries), ['notes.md', 'sub/']);
  assert.deepEqual(names((await (await f.view(`/api/files?document=${doc.id}&dir=${encodeURIComponent(join(root, 'sub'))}`)).json()).entries), ['inner.md']);
  const outside = await workspace(t);
  await write(outside, { 'nested/app.ts': 'export const outside = true;', 'note.md': '# Outside' });
  const directory = encodeURIComponent(outside);
  assert.equal((await f.view(`/api/files?document=${doc.id}&dir=${directory}`)).status, 403);
  assert.equal((await f.view('/api/files/root', { documentId: doc.id, directory: outside })).status, 200);
  const browsed = await (await f.view(`/api/files?document=${doc.id}&dir=${directory}`)).json();
  assert.equal(browsed.dir, outside);
  assert.deepEqual(names(browsed.entries), ['nested/', 'note.md']);
  assert.equal((await (await f.view(`/api/files/code?document=${doc.id}&directory=${directory}&path=nested/app.ts`)).json()).contents, 'export const outside = true;');
  assert.equal((await f.view(`/api/files?document=${doc.id}&dir=relative`)).status, 400);
  assert.equal((await fetch(`${f.url}/api/files?document=${doc.id}&dir=${directory}`)).status, 403);
  assert.equal((await (await f.view('/api/state')).json()).documents[doc.id].workspace, root);
  assert.deepEqual(await (await f.view(`/api/files/content?document=${doc.id}&path=notes.md`)).json(), { path: 'notes.md', text: '# Notes', renderAs: 'markdown' });
  assert.equal((await f.view(`/api/files/content?document=${doc.id}&path=${encodeURIComponent('../notes.md')}`)).status, 403);
  assert.equal((await fetch(`${f.url}/api/files?document=${doc.id}`)).status, 403);
  assert.equal((await f.view('/api/files?document=missing')).status, 404);
  await rm(root, { recursive: true, force: true });
  const gone = await f.view(`/api/files?document=${doc.id}`);
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /workspace directory is unavailable/);
});

test('authorization is realpath containment in the workspace or a granted root', async t => {
  const root = await workspace(t), grant = await workspace(t), outside = await workspace(t), sibling = `${root}-sibling`;
  await write(root, { 'a/b.md': '# B' });
  await write(outside, { 'secret.md': '# secret' });
  await mkdir(sibling); t.after(() => rm(sibling, { recursive: true, force: true }));
  await symlink(outside, join(root, 'link'));
  await symlink(join(outside, 'secret.md'), join(root, 'escape.md'));
  const status = (path: string, grants: string[] = []) => authorizePath(root, grants, path).then(() => 200, (error: { status?: number }) => error.status);
  assert.equal(await status(root), 200);
  assert.equal(await status(join(root, 'a/b.md')), 200);
  assert.equal(await status(join(root, 'a/deleted.md')), 200);
  assert.equal(await status(sibling), 403);
  assert.equal(await status(outside), 403);
  assert.equal(await status(join(root, 'link')), 403);
  assert.equal(await status(join(root, 'link/secret.md')), 403);
  assert.equal(await status(join(root, 'link/gone.md')), 403);
  assert.equal(await status(join(root, 'escape.md')), 403);
  assert.equal(await status(join(root, '..', basename(outside), 'secret.md')), 403);
  assert.equal(await status(join(grant, 'x.md'), [grant]), 200);
  assert.equal(await status(join(grant, 'x.md')), 403);
  assert.equal(await status('relative'), 400);
});

test('code reads stay inside the workspace and accept line suffixes', async t => {
  const root = await workspace(t), outside = await workspace(t);
  await write(outside, { 'secret.ts': 'export const secret = 1;' });
  await write(root, { 'src/app.ts': 'export const answer = 42;\n', 'notes.md': '# Notes', 'node_modules/pkg/index.js': 'x', '.env': 'A=1' });
  await symlink(join(outside, 'secret.ts'), join(root, 'escape.ts'));
  const app = { codeFile: true, filepath: 'src/app.ts', contents: 'export const answer = 42;\n' };
  assert.deepEqual(await readCode(root, 'src/app.ts'), app);
  assert.deepEqual(await readCode(root, 'src/app.ts:1'), app);
  assert.deepEqual(await readCode(root, 'src/app.ts:1-3'), app);
  const status = (path: string) => readCode(root, path).then(() => 200, (error: { status?: number }) => error.status);
  assert.equal(await status('escape.ts'), 403);
  assert.equal(await status('../x.ts'), 403);
  assert.equal(await status('notes.md'), 415);
  assert.equal(await status('node_modules/pkg/index.js'), 415);
  assert.equal(await status('.env'), 415);
  assert.equal(await status('src/missing.ts'), 404);
});

test('odd preview paths fail cleanly instead of with server errors', async t => {
  const root = await workspace(t);
  await write(root, { '..dots.md': '# Dots', 'notes.md': '# Notes' });
  assert.equal((await readPreview(root, '..dots.md')).text, '# Dots');
  const status = (path: string) => readPreview(root, path).then(() => 200, (error: { status?: number }) => error.status);
  assert.equal(await status('notes.md/x.md'), 404);
  assert.equal(await status('a\0.md'), 400);
});

test('viewer code route reads the stored workspace', async t => {
  const root = await workspace(t);
  await write(root, { 'src/app.ts': 'export {};\n' });
  const f = await fixture(t), doc = await f.register();
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  assert.deepEqual(await (await f.view(`/api/files/code?document=${doc.id}&path=${encodeURIComponent('src/app.ts:1')}`)).json(), { codeFile: true, filepath: 'src/app.ts', contents: 'export {};\n' });
  assert.equal((await f.view(`/api/files/code?document=${doc.id}&path=${encodeURIComponent('../x.ts')}`)).status, 403);
});

test('status, diff, branches and base endpoints use the document workspace and base branch', async t => {
  const root = await workspace(t), outside = await workspace(t);
  await git(root, 'init', '-b', 'main');
  await write(root, { 'a.md': '1\n2\n' });
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'i');
  await git(root, 'checkout', '-b', 'feature');
  await write(root, { 'a.md': '1\n2\n3\n', 'new.md': 'n\n' });
  await write(outside, { 'x.md': 'x' });
  const f = await fixture(t), doc = await f.register();
  const open = await (await f.agent('/agent/documents', { path: doc.path, workspace: root, baseBranch: 'main' })).json();
  assert.equal(open.baseBranch, 'main');
  assert.equal((await (await f.view('/api/state')).json()).documents[doc.id].baseBranch, 'main');
  const query = (route: string, extra = '') => f.view(`/api/files/${route}?document=${doc.id}${extra}`);
  const uncommitted = await (await query('status', '&mode=uncommitted')).json();
  assert.equal(uncommitted.comparison.mode, 'uncommitted');
  assert.deepEqual(Object.keys(uncommitted.files).map(p => p.slice(root.length + 1)).sort(), ['a.md', 'new.md']);
  const base = await (await query('status', '&mode=base')).json();
  assert.equal(base.comparison.base, 'main');
  assert.equal(base.totals.files, 2);
  assert.equal((await query('status', '&mode=base&base=--bad')).status, 400);
  assert.equal((await query('status', '&mode=nope')).status, 400);
  assert.equal((await query('status', `&directory=${encodeURIComponent(outside)}`)).status, 403);
  assert.deepEqual((await (await query('branches')).json()).branches, ['feature', 'main']);
  const diff = await (await query('diff', `&mode=base&path=${encodeURIComponent(join(root, 'a.md'))}`)).json();
  assert.deepEqual(diff, { path: join(root, 'a.md'), old: '1\n2\n', current: '1\n2\n3\n', status: 'modified' });
  assert.equal((await (await query('diff', `&path=${encodeURIComponent(join(root, 'new.md'))}`)).json()).status, 'added');
  assert.equal((await query('diff', `&path=${encodeURIComponent(join(outside, 'x.md'))}`)).status, 403);
  assert.equal((await query('diff', `&path=${encodeURIComponent(join(root, 'missing.md'))}`)).status, 404);
  assert.equal((await f.view(`/api/documents/${doc.id}/base`, { baseBranch: 'release/2' })).status, 200);
  assert.equal((await (await f.view('/api/state')).json()).documents[doc.id].baseBranch, 'release/2');
  assert.equal((await f.view(`/api/documents/${doc.id}/base`, { baseBranch: '-x' })).status, 400);
  assert.equal((await f.view(`/api/documents/${doc.id}/base`, { baseBranch: null })).status, 200);
  assert.equal((await (await f.view('/api/state')).json()).documents[doc.id].baseBranch, undefined);
  assert.equal((await f.agent('/agent/documents', { path: doc.path, workspace: root, baseBranch: '--x' })).status, 400);
});
