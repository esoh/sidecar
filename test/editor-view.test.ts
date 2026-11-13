import assert from 'node:assert/strict';
import { test } from 'node:test';
import { minimalChange } from '../web/editor-view.ts';

test('minimal change trims shared prefix and suffix', () => {
  assert.deepEqual(minimalChange('abcXdef', 'abcYYdef'), { from: 3, to: 4, insert: 'YY' });
});
test('equal text yields null', () => {
  assert.equal(minimalChange('same', 'same'), null);
});
test('pure insert and pure delete', () => {
  assert.deepEqual(minimalChange('abcd', 'abXXcd'), { from: 2, to: 2, insert: 'XX' });
  assert.deepEqual(minimalChange('abXXcd', 'abcd'), { from: 2, to: 4, insert: '' });
  assert.deepEqual(minimalChange('aa', 'aaa'), { from: 2, to: 2, insert: 'a' });
});
