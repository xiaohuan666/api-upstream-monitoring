import test from 'node:test';
import assert from 'node:assert/strict';

import { matchesSearchText } from '../src/searchable-select.mjs';

test('matchesSearchText matches everything on empty query', () => {
  assert.equal(matchesSearchText('YeClaw', ''), true);
  assert.equal(matchesSearchText('YeClaw', '   '), true);
  assert.equal(matchesSearchText('YeClaw', null), true);
});

test('matchesSearchText is a case-insensitive contains match', () => {
  assert.equal(matchesSearchText('YeClaw', 'claw'), true);
  assert.equal(matchesSearchText('YeClaw', 'YE'), true);
  assert.equal(matchesSearchText('Gemini-反重力【稳定】', '反重力'), true);
  assert.equal(matchesSearchText('YeClaw', 'gemini'), false);
});

test('matchesSearchText ORs space-separated terms', () => {
  assert.equal(matchesSearchText('YeClaw', 'a b'), true);
  assert.equal(matchesSearchText('box', 'a b'), true);
  assert.equal(matchesSearchText('kun', 'a b'), false);
  assert.equal(matchesSearchText('Gemini 反重力', 'gemini  claude'), true);
  assert.equal(matchesSearchText('gpt-4o', 'gemini  claude'), false);
});

test('matchesSearchText tolerates non-string labels', () => {
  assert.equal(matchesSearchText(null, 'a'), false);
  assert.equal(matchesSearchText(undefined, 'a b'), false);
  assert.equal(matchesSearchText(42, '4'), true);
});
