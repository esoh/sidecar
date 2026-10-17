import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWorkspaceLink, splitLineSuffix, fileLineRange } from '../web/links.ts';

test('workspace links resolve absolute, file URL and relative targets', () => {
  const root = '/repo/wt';
  assert.deepEqual(resolveWorkspaceLink('/repo/wt/docs/a.md', root), { path: 'docs/a.md' });
  assert.deepEqual(resolveWorkspaceLink('file:///repo/wt/docs/a%20b.md', root), { path: 'docs/a b.md' });
  assert.deepEqual(resolveWorkspaceLink('b.md', root, '/repo/wt/docs'), { path: 'docs/b.md' });
  assert.deepEqual(resolveWorkspaceLink('../README.md', root, '/repo/wt/docs'), { path: 'README.md' });
  assert.deepEqual(resolveWorkspaceLink('./src/x.ts', root), { path: 'src/x.ts' });
  assert.deepEqual(resolveWorkspaceLink('/repo/other/a.md', root), { outside: '/repo/other/a.md' });
  assert.deepEqual(resolveWorkspaceLink('/repo/wt-sibling/a.md', root), { outside: '/repo/wt-sibling/a.md' });
  assert.deepEqual(resolveWorkspaceLink('../../etc/passwd', root, '/repo/wt/docs'), { outside: '/repo/etc/passwd' });
  assert.deepEqual(resolveWorkspaceLink('/repo/wt', root), { outside: '/repo/wt' });
});

test('code links keep their line suffix apart from the path', () => {
  assert.deepEqual(splitLineSuffix('src/x.ts:42'), ['src/x.ts', ':42']);
  assert.deepEqual(splitLineSuffix('src/x.ts:4-9'), ['src/x.ts', ':4-9']);
  assert.deepEqual(splitLineSuffix('src/x.ts'), ['src/x.ts', '']);
});

test('line references retain numeric ranges without consuming ordinary fragments', () => {
  for (const [target, expected] of [
    ['src/x.ts:42', { start: 42, end: 42 }],
    ['src/x.ts:4-9', { start: 4, end: 9 }],
    ['src/x.ts#L4-L9', { start: 4, end: 9 }],
    ['src/x.ts#L4', { start: 4, end: 4 }],
    ['src/x.ts:9-4#heading', { start: 4, end: 9 }],
  ] as const) {
    const [file, suffix] = splitLineSuffix(target);
    assert.equal(file, 'src/x.ts');
    assert.deepEqual(fileLineRange(suffix), expected);
  }
  assert.deepEqual(splitLineSuffix('diagram.html#chained'), ['diagram.html#chained', '']);
  for (const suffix of ['', ':0', ':1-0', '#L0', ':99999999999999999999', ':1.5', ':1-extra']) assert.equal(fileLineRange(suffix), undefined);
});
