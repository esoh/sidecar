import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWorkspaceLink, splitLineSuffix, fileLineRange, pageLinkTarget } from '../web/links.ts';

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

test('HTML page links open only local files inside the workspace', () => {
  const root = '/repo/wt', dir = '/repo/wt/review', target = (href: string) => pageLinkTarget(href, root, dir);
  assert.deepEqual(target('callflow/api/schema.prisma:1741'), { path: 'callflow/api/schema.prisma', lineRange: { start: 1741, end: 1741 } });
  assert.deepEqual(target('src/a.ts#L3-L5'), { path: 'src/a.ts', lineRange: { start: 3, end: 5 } });
  assert.deepEqual(target('./notes.md'), { path: 'review/notes.md' });
  assert.deepEqual(target('../README.md:2-4'), { path: 'README.md', lineRange: { start: 2, end: 4 } });
  assert.deepEqual(target('other.html#step-2'), { path: 'other.html', fragment: '#step-2' });
  assert.deepEqual(target('docs/a.md#heading'), { path: 'docs/a.md' });
  // Root-level file names with line suffixes are files, not URI schemes.
  assert.deepEqual(target('schema.prisma:1741'), { path: 'schema.prisma', lineRange: { start: 1741, end: 1741 } });
  assert.deepEqual(target('README.md:2-4'), { path: 'README.md', lineRange: { start: 2, end: 4 } });
  assert.deepEqual(target('.env.example:3'), { path: '.env.example', lineRange: { start: 3, end: 3 } });
  assert.deepEqual(target('/repo/wt/src/x.ts:9'), { path: 'src/x.ts', lineRange: { start: 9, end: 9 } });
  assert.deepEqual(target('file:///repo/wt/src/x.ts'), { path: 'src/x.ts' });
  for (const outside of ['/tmp/example.md', 'file:///tmp/x.ts', '../../etc/passwd', '%2e%2e/secret', '/repo/wt-sibling/a.md'])
    assert.ok(target(outside) && 'outside' in target(outside)!, outside);
  for (const page of ['#section', '', '   ', 'https://example.com/a.ts', 'HTTP://x', '//evil.example/a.md', 'javascript:alert(1)', 'data:text/html,x',
    'mailto:a@b.c', 'tel:5551234', 'javascript:1', 'https://example.com:8080', 'http://a.b:80', 'file://host/etc/passwd', 'blob:x', 'a\nb.md', 'x'.repeat(4097), '?q=1'])
    assert.equal(target(page), null, JSON.stringify(page.slice(0, 40)));
});
