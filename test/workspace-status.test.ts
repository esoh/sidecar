import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkspaceStatusForDirectory, listBranches, readComparisonOldText } from '../src/workspace-status.ts';
import { readDiff } from '../src/files.ts';

const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd }).then(r => r.stdout.trim());
async function repo(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-status-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'init', '-b', 'main');
  return root;
}
async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
}
const commit = async (root: string, files: Record<string, string>, message = 'c') => { await write(root, files); await git(root, 'add', '-A'); await git(root, 'commit', '-m', message); };

test('uncommitted counts are net against HEAD, so staged plus unstaged edits count once', async t => {
  const root = await repo(t);
  await commit(root, { 'a.md': '1\n2\n3\n' });
  await write(root, { 'a.md': '1\nX\n3\n' });
  await git(root, 'add', 'a.md');
  await write(root, { 'a.md': '1\nY\n3\n', 'new.md': 'n1\nn2\n' });
  const status = await getWorkspaceStatusForDirectory(root);
  assert.equal(status.comparison.mode, 'uncommitted');
  assert.equal(status.comparison.commit, await git(root, 'rev-parse', 'HEAD'));
  const a = status.files[join(root, 'a.md')];
  assert.deepEqual([a.additions, a.deletions, a.staged, a.unstaged], [1, 1, true, true]);
  assert.equal(status.files[join(root, 'new.md')].additions, 2);
  assert.deepEqual(status.totals, { files: 2, additions: 3, deletions: 1 });
});

test('base mode compares with the merge-base, ignores base-only commits and includes untracked files', async t => {
  const root = await repo(t);
  await commit(root, { 'a.md': '1\n2\n', 'gone.md': 'x\n' });
  await git(root, 'checkout', '-b', 'feature');
  await commit(root, { 'c.md': 'c1\nc2\nc3\n' });
  await git(root, 'checkout', 'main');
  await commit(root, { 'b.md': 'b\n', 'a.md': '1\n2\nbase-only\n' });
  await git(root, 'rm', '-q', 'gone.md'); await git(root, 'commit', '-m', 'rm');
  await git(root, 'checkout', 'feature');
  await write(root, { 'a.md': '1\n2\nmine\n', 'u.md': 'u\n' });
  const status = await getWorkspaceStatusForDirectory(root, { mode: 'base', base: 'main' });
  assert.deepEqual(Object.keys(status.files).map(p => p.slice(root.length + 1)).sort(), ['a.md', 'c.md', 'u.md']);
  assert.equal(status.files[join(root, 'a.md')].additions, 1);
  assert.equal(status.files[join(root, 'a.md')].deletions, 0);
  assert.equal(status.files[join(root, 'c.md')].status, 'added');
  assert.equal(status.files[join(root, 'u.md')].status, 'untracked');
  assert.equal(status.files[join(root, 'u.md')].additions, 1);
  assert.equal(status.comparison.ref, 'main');
  assert.equal(status.comparison.behind, 2);
  assert.equal(status.comparison.commit, await git(root, 'merge-base', 'HEAD', 'main'));
  assert.equal(status.comparison.remoteError, undefined);
  assert.equal((await getWorkspaceStatusForDirectory(root, { mode: 'base', base: 'missing' })).comparison.error, 'base-not-found');
  assert.equal((await getWorkspaceStatusForDirectory(root, { mode: 'base', base: '--upload-pack=x' })).comparison.error, 'invalid-base-branch');
});

test('a fetch request really fetches, reports failure, and still returns the local result', async t => {
  const root = await repo(t), remote = await repo(t);
  await commit(root, { 'a.md': '1\n' });
  await commit(remote, { 'a.md': '1\n' });
  const request = { mode: 'base' as const, base: 'main' };
  // Concurrent flights for the same directory must not satisfy the fetch request.
  const [plain, fetched] = await Promise.all([getWorkspaceStatusForDirectory(root, request), getWorkspaceStatusForDirectory(root, { ...request, fetch: true })]);
  assert.equal(plain.comparison.remoteError, undefined);
  assert.match(fetched.comparison.remoteError ?? '', /origin/);
  assert.equal(fetched.available, true);
  await git(root, 'remote', 'add', 'origin', remote);
  await commit(remote, { 'b.md': 'b\n' });
  const ok = await getWorkspaceStatusForDirectory(root, { ...request, fetch: true });
  assert.equal(ok.comparison.remoteError, undefined);
  assert.ok(ok.comparison.remoteCheckedAt);
  assert.equal(ok.comparison.ref, 'origin/main');
  assert.equal(ok.comparison.behind, 1);
});

test('old text follows renames and branches list heads plus origin without duplicates', async t => {
  const root = await repo(t);
  await commit(root, { 'old.md': 'line one\nline two\nline three\n', 'keep.md': 'k\n' });
  await git(root, 'branch', 'topic');
  await git(root, 'mv', 'old.md', 'new.md');
  await write(root, { 'new.md': 'line one\nline two\nline three\nfour\n' });
  assert.equal(await readComparisonOldText(join(root, 'keep.md'), { mode: 'uncommitted' }), 'k\n');
  assert.equal(await readComparisonOldText(join(root, 'new.md'), { mode: 'uncommitted' }), 'line one\nline two\nline three\n');
  assert.equal(await readComparisonOldText(join(root, 'nope.md'), { mode: 'uncommitted' }), null);
  assert.equal(await readComparisonOldText(join(root, 'sub/deleted/x.md'), { mode: 'uncommitted' }), null);
  const diff = await readDiff(root, join(root, 'new.md'), { mode: 'uncommitted' });
  assert.equal(diff.status, 'modified');
  assert.equal(diff.current, 'line one\nline two\nline three\nfour\n');
  await git(root, 'update-ref', 'refs/remotes/origin/topic', 'HEAD');
  await git(root, 'update-ref', 'refs/remotes/origin/only-remote', 'HEAD');
  await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/topic');
  assert.deepEqual(await listBranches(root), ['main', 'only-remote', 'topic']);
});
