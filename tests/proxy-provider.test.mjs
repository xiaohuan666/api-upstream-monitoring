import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateProxyProviderNames, normalizeProxyProvider } from '../src/proxy-provider.mjs';

test('provider names fill the smallest gaps in ascending order and remain independent', () => {
  const rows = [1, 2, 4].map((n) => ({ provider: '服务商', name: `服务商-00${n}` }));
  rows.push({ provider: '其他', name: '其他-003' });
  assert.deepEqual(allocateProxyProviderNames(' 服务商 ', rows, 2), ['服务商-003', '服务商-005']);
  assert.deepEqual(allocateProxyProviderNames('其他', rows, 2), ['其他-001', '其他-002']);
  assert.deepEqual(allocateProxyProviderNames('', rows, 2), []);
  assert.deepEqual(allocateProxyProviderNames('服务商', rows, 0), []);
});

test('legacy matching names reserve names without guessing providers; non-number names are ignored', () => {
  const rows = [
    { name: 'A-001' }, { name: 'A-003', provider: '' },
    { name: 'A-2', provider: 'A' }, { name: 'A-backup', provider: 'A' },
    { name: 'A-004-extra', provider: 'A' }, { name: 'AA-004', provider: 'AA' },
    { name: 'a-004', provider: 'a' },
  ];
  assert.deepEqual(allocateProxyProviderNames('A', rows, 2), ['A-004', 'A-005']);
});

test('provider names support special characters and more than 999 proxies', () => {
  const provider = '甲-乙.+(US)';
  const rows = Array.from({ length: 999 }, (_, i) => ({ provider, name: `${provider}-${String(i + 1).padStart(3, '0')}` }));
  assert.deepEqual(allocateProxyProviderNames(provider, rows, 2), [`${provider}-1000`, `${provider}-1001`]);
  rows.splice(8, 1);
  assert.deepEqual(allocateProxyProviderNames(provider, rows, 2), [`${provider}-009`, `${provider}-1000`]);
});

test('provider normalization trims boundaries, allows empty, and rejects invalid values', () => {
  assert.equal(normalizeProxyProvider(' 星河 US '), '星河 US');
  assert.equal(normalizeProxyProvider(undefined), '');
  for (const input of [123, {}, [], 'x'.repeat(101), 'a\nb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u009fb']) {
    assert.throws(() => normalizeProxyProvider(input));
  }
  assert.throws(() => allocateProxyProviderNames('A', [], Infinity));
});
