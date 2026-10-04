import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryInfo, workspaceMetadata } from '../src/cli.ts';
import { fixture } from './support.ts';

test('opening workspace metadata survives linked worktrees, detach and legacy state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-repository-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'example'), linked = join(root, 'task');
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: root });
  assert.equal(await repositoryInfo(root), undefined);
  await git('init', '-b', 'main', repo);
  await git('-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  assert.deepEqual(await repositoryInfo(repo), { display: 'example', branch: 'main' });
  await git('-C', repo, 'worktree', 'add', '-b', 'feature/sidebar', linked);
  const repoInfo = await repositoryInfo(linked);
  assert.deepEqual(repoInfo, { display: 'example', branch: 'feature/sidebar' });
  await git('-C', linked, 'checkout', '--detach');
  assert.deepEqual(await repositoryInfo(linked), { display: 'example' });
  const f = await fixture(t), doc = await f.register();
  assert.equal(doc.repoInfo, undefined);
  assert.equal((await f.agent('/agent/documents', { path: doc.path, repoInfo: { display: 42 } })).status, 400);
  const opened = await (await f.agent('/agent/documents', { path: doc.path, repoInfo })).json();
  assert.equal(opened.id, doc.id);
  assert.deepEqual(opened.repoInfo, repoInfo);
  await f.reopen();
  assert.deepEqual((await (await f.view('/api/state')).json()).documents[doc.id].repoInfo, repoInfo);
  // Reopening an existing document without workspace information preserves its known origin.
  assert.deepEqual((await (await f.agent('/agent/documents', { path: doc.path })).json()).repoInfo, repoInfo);
});

test('documents record the declared or Git workspace and badge it', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-workspace-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'example'), linked = join(root, 'task');
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: root });
  await git('init', '-b', 'main', repo);
  await git('-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  await git('-C', repo, 'worktree', 'add', '-b', 'feature/files', linked);
  await mkdir(join(linked, 'docs'));
  const task = { workspace: linked, repoInfo: { display: 'example', branch: 'feature/files' } };
  assert.deepEqual(await workspaceMetadata(undefined, join(linked, 'docs')), task);
  // An agent sitting in the main checkout declares the worktree it is working in.
  assert.deepEqual(await workspaceMetadata(linked, repo), task);
  assert.deepEqual(await workspaceMetadata('../task', repo), task);
  assert.deepEqual(await workspaceMetadata(undefined, root), {});
  await assert.rejects(workspaceMetadata(join(root, 'missing'), repo));

  const f = await fixture(t), doc = await f.register();
  assert.equal(doc.workspace, undefined);
  assert.equal((await f.agent('/agent/documents', { path: doc.path, workspace: 'relative/dir' })).status, 400);
  assert.equal((await f.agent('/agent/documents', { path: doc.path, workspace: doc.path })).status, 400);
  assert.equal((await f.agent('/agent/documents', { path: doc.path, workspace: join(root, 'missing') })).status, 400);
  assert.equal((await (await f.agent('/agent/documents', { path: doc.path, ...task })).json()).workspace, linked);
  await f.reopen();
  assert.equal((await (await f.view('/api/state')).json()).documents[doc.id].workspace, linked);
  // Reopening without workspace information keeps the known root; a new declaration replaces it.
  assert.equal((await (await f.agent('/agent/documents', { path: doc.path })).json()).workspace, linked);
  assert.equal((await (await f.agent('/agent/documents', { path: doc.path, workspace: repo })).json()).workspace, repo);
});

test('a declared workspace without repository metadata clears the previous badge', async t => {
  const plain = await realpath(await mkdtemp(join(tmpdir(), 'sidecar-plain-')));
  t.after(() => rm(plain, { recursive: true, force: true }));
  const f = await fixture(t), doc = await f.register();
  await f.agent('/agent/documents', { path: doc.path, workspace: plain, repoInfo: { display: 'example', branch: 'main' } });
  const moved = await (await f.agent('/agent/documents', { path: doc.path, workspace: plain })).json();
  assert.equal(moved.workspace, plain);
  assert.equal(moved.repoInfo, undefined);
});
