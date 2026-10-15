import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_GROUP_KEY_FILTER, normalizeGroupKeyFilter } from '../src/group-filter.mjs';

test('group key filter defaults to groups with keys', () => {
  assert.equal(DEFAULT_GROUP_KEY_FILTER, '1');
});

test('normalizeGroupKeyFilter only accepts all or keyed filters', () => {
  assert.equal(normalizeGroupKeyFilter('1'), '1');
  assert.equal(normalizeGroupKeyFilter('all'), 'all');
  assert.equal(normalizeGroupKeyFilter(''), DEFAULT_GROUP_KEY_FILTER);
  assert.equal(normalizeGroupKeyFilter('unexpected'), DEFAULT_GROUP_KEY_FILTER);
});
