import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryInfo } from '../src/cli.ts';
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
