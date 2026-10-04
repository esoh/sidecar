import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { listFiles, readCode, readPreview, type VaultNode } from '../src/files.ts';
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
const names = (nodes: VaultNode[]) => nodes.map(node => node.type === 'folder' ? `${node.name}/` : node.name).sort();

test('listing follows Plannotator file types, exclusions and folder-first order', async t => {
  const root = await workspace(t);
  await write(root, {
    'README.md': '# Hi', 'docs/plan.md': '# Plan', 'docs/flow.mmd': 'graph TD; A-->B', 'page.html': '<p>x</p>',
    'config.yaml': 'a: 1', 'src.ts': 'export {}', '.env': 'SECRET=1', '.env.example': 'SECRET=',
    'node_modules/pkg/README.md': '# dep', '.claude/worktrees/x/notes.md': '# nested worktree',
  });
  const listing = await listFiles(root);
  assert.equal(listing.root, root);
  assert.equal(listing.truncated, false);
  assert.equal(listing.fileLimit, 5000);
  assert.equal(listing.tree[0].type, 'folder');
  assert.deepEqual(names(listing.tree), names([
    { name: 'docs', path: 'docs', type: 'folder' }, { name: '.env.example', path: '.env.example', type: 'file' },
    { name: 'config.yaml', path: 'config.yaml', type: 'file' }, { name: 'page.html', path: 'page.html', type: 'file' },
    { name: 'README.md', path: 'README.md', type: 'file' },
    { name: 'src.ts', path: 'src.ts', type: 'file' },
  ]));
  assert.deepEqual(names(listing.tree.find(node => node.name === 'docs')!.children!), ['flow.mmd', 'plan.md']);
  assert.equal(listing.tree.find(node => node.name === 'docs')!.children!.find(node => node.name === 'plan.md')!.path, 'docs/plan.md');
});

test('changed files survive the cap and report Git status', async t => {
  const root = await workspace(t);
  await git(root, 'init', '-b', 'main');
  await write(root, { 'a0.md': '# 0', 'a1.md': '# 1', 'a2.md': '# 2', 'a3.md': '# 3' });
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');
  await write(root, { 'z-untracked.md': '# new', 'a0.md': '# 0 changed\n\nmore\n' });
  const listing = await listFiles(root, 3);
  assert.equal(listing.truncated, true);
  assert.equal(listing.fileLimit, 3);
  assert.ok(names(listing.tree).includes('z-untracked.md'));
  assert.ok(names(listing.tree).includes('a0.md'));
  assert.equal(listing.workspaceStatus.available, true);
  assert.ok(Object.keys(listing.workspaceStatus.files).some(path => path.endsWith('z-untracked.md')));
});

test('a workspace outside Git still lists files', async t => {
  const root = await workspace(t);
  await write(root, { 'notes.md': '# Notes' });
  const listing = await listFiles(root);
  assert.deepEqual(names(listing.tree), ['notes.md']);
  assert.equal(listing.workspaceStatus.available, false);
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
  await write(root, { 'notes.md': '# Notes' });
  const f = await fixture(t), doc = await f.register();
  assert.equal((await f.view(`/api/files?document=${doc.id}`)).status, 404);
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  const listing = await (await f.view(`/api/files?document=${doc.id}&dirPath=${encodeURIComponent('/etc')}`)).json();
  assert.equal(listing.root, root);
  assert.deepEqual(names(listing.tree), ['notes.md']);
  const outside = await workspace(t);
  await write(outside, { 'nested/app.ts': 'export const outside = true;', 'note.md': '# Outside' });
  const directory = encodeURIComponent(outside);
  assert.equal((await f.view(`/api/files?document=${doc.id}&directory=${directory}`)).status, 403);
  assert.equal((await f.view('/api/files/root', { documentId: doc.id, directory: outside })).status, 200);
  const browsed = await (await f.view(`/api/files?document=${doc.id}&directory=${directory}`)).json();
  assert.equal(browsed.root, outside);
  assert.deepEqual(names(browsed.tree), ['nested/', 'note.md']);
  assert.equal((await (await f.view(`/api/files/code?document=${doc.id}&directory=${directory}&path=nested/app.ts`)).json()).contents, 'export const outside = true;');
  assert.equal((await f.view(`/api/files?document=${doc.id}&directory=relative`)).status, 400);
  assert.equal((await fetch(`${f.url}/api/files?document=${doc.id}&directory=${directory}`)).status, 403);
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
