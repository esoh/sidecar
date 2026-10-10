import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './support.ts';

test('HTML frame endpoint requires viewer auth and an authorized HTML file', async t => {
  const f = await fixture(t);
  const doc = await f.register();
  await f.agent('/agent/documents', { path: doc.path, workspace: f.directory });
  await writeFile(join(f.directory, 'diagram.html'), '<p>Diagram</p><script>document.body.dataset.ran="yes"</script>');
  const route = `/api/files/html?document=${doc.id}&path=diagram.html`;
  assert.equal((await fetch(f.url + route)).status, 403);
  const staticFrame = await f.view(route);
  assert.equal(staticFrame.status, 200);
  assert.match(staticFrame.headers.get('content-security-policy')!, /script-src 'none'/);
  const scripted = await f.view(route + '&scripts=1');
  assert.equal(scripted.status, 200);
  assert.match(scripted.headers.get('content-type')!, /text\/html/);
  assert.match(scripted.headers.get('content-security-policy')!, /sandbox allow-scripts;/);
  assert.doesNotMatch(scripted.headers.get('content-security-policy')!, /allow-same-origin/);
  assert.match(await scripted.text(), /<script>/);
  assert.equal((await f.view(`/api/files/html?document=${doc.id}&path=a.md&scripts=1`)).status, 415);
  assert.equal((await f.view(`/api/files/html?document=${doc.id}&path=../outside.html&scripts=1`)).status, 403);
  assert.equal((await f.view('/api/files/html?document=missing&path=diagram.html&scripts=1')).status, 404);
});
