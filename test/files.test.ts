import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { listFiles, readPreview, type VaultNode } from '../src/files.ts';
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

test('viewer file routes read only the stored document workspace', async t => {
  const root = await workspace(t);
  await write(root, { 'notes.md': '# Notes' });
  const f = await fixture(t), doc = await f.register();
  assert.equal((await f.view(`/api/files?document=${doc.id}`)).status, 404);
  await f.agent('/agent/documents', { path: doc.path, workspace: root });
  const listing = await (await f.view(`/api/files?document=${doc.id}&dirPath=${encodeURIComponent('/etc')}`)).json();
  assert.equal(listing.root, root);
  assert.deepEqual(names(listing.tree), ['notes.md']);
  assert.deepEqual(await (await f.view(`/api/files/content?document=${doc.id}&path=notes.md`)).json(), { path: 'notes.md', text: '# Notes', renderAs: 'markdown' });
  assert.equal((await f.view(`/api/files/content?document=${doc.id}&path=${encodeURIComponent('../notes.md')}`)).status, 403);
  assert.equal((await fetch(`${f.url}/api/files?document=${doc.id}`)).status, 403);
  assert.equal((await f.view('/api/files?document=missing')).status, 404);
  await rm(root, { recursive: true, force: true });
  const gone = await f.view(`/api/files?document=${doc.id}`);
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /workspace directory is unavailable/);
});
