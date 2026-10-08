import assert from 'node:assert/strict';
import { test } from 'node:test';
import { viewerPath } from '../web/viewer-path.ts';

test('viewer routes prefix owner paths exactly once while legacy direct URLs remain intact', () => {
  for (const path of ['/api/state', '/api/events?updates=1', '/api/image?path=one%20two.png', '/?document=uuid#selection-1']) {
    assert.equal(viewerPath(path, '/a/o4/'), '/a/o4' + path);
    assert.equal(viewerPath(path, '/'), path);
  }
  assert.equal(viewerPath('/a/o4/api/state', '/a/o4/'), '/a/o4/api/state');
  assert.equal(viewerPath('/api/state', '/a/not-owner/'), '/api/state');
});
