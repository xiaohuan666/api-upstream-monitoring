import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGroupRows } from '../src/group-rows.mjs';

const site = {
  id: 'site-1',
  name: '测试站点',
  url: 'https://relay.example.com',
};

test('groups with multiple keys expand to one row per api key', () => {
  const rows = buildGroupRows(
    [site],
    {
      'site-1': {
        groups: [
          { id: 'group-a', name: '同组', keyCount: 2 },
        ],
        tokens: [
          { id: 11, groupId: 'group-a', key: 'sk-first' },
          { id: 12, groupId: 'group-a', key: 'sk-second' },
        ],
      },
    },
  );

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.group.name), ['同组', '同组']);
  assert.deepEqual(rows.map((row) => row.token.key), ['sk-first', 'sk-second']);
  assert.deepEqual(rows.map((row) => row.keyCount), [1, 1]);
  assert.ok(new Set(rows.map((row) => row.rowId)).size === 2);
});

test('groups without keys keep one group-level row', () => {
  const rows = buildGroupRows(
    [site],
    {
      'site-1': {
        groups: [
          { id: 'group-a', name: '无 Key 分组', keyCount: 0 },
        ],
        tokens: [],
      },
    },
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].group.name, '无 Key 分组');
  assert.equal(rows[0].token, null);
  assert.equal(rows[0].keyCount, 0);
  assert.equal(rows[0].hasApiKey, false);
});

test('token rows only attach to their own group', () => {
  const rows = buildGroupRows(
    [site],
    {
      'site-1': {
        groups: [
          { id: 'group-a', name: 'A' },
          { id: 'group-b', name: 'B' },
        ],
        tokens: [
          { id: 22, groupId: 'group-b', key: 'sk-b' },
        ],
      },
    },
  );

  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.group.id === 'group-a').token, null);
  assert.equal(rows.find((row) => row.group.id === 'group-b').token.key, 'sk-b');
});

test('group rows expose the site-adjusted multiplier without mutating the stored snapshot', () => {
  const storedGroup = { id: 'group-a', name: 'Lucis', multiplier: 0.039 };
  const rows = buildGroupRows(
    [{ ...site, usdToCnyRate: 7 }],
    {
      'site-1': {
        balanceCurrency: 'USD',
        groups: [storedGroup],
        tokens: [],
      },
    },
  );

  assert.equal(rows[0].group.multiplier, 0.273);
  assert.equal(storedGroup.multiplier, 0.039);
});
