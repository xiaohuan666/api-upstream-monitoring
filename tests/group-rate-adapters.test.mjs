import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSub2ApiSnapshot } from '../src/upstreams/sub2api.mjs';
import { normalizeNewApiSnapshot } from '../src/upstreams/newapi.mjs';

for (const value of [undefined, null, '', '   ', false, {}, 'not-a-rate', -1]) {
  test(`sub2api does not present ${JSON.stringify(value)} as a known audit multiplier`, () => {
    const snapshot = normalizeSub2ApiSnapshot({ site: { id: 's1' }, groups: [{ id: 1, rate_multiplier: value }] });
    assert.equal(snapshot.groups[0].multiplierKnown, false);
  });
}

test('sub2api known rates prioritize exclusive values, retain zero and reject token-only placeholders', () => {
  const snapshot = normalizeSub2ApiSnapshot({
    site: { id: 's1' },
    groups: [{ id: 1, rate_multiplier: 4 }, { id: 2, rate_multiplier: '0' }],
    rates: { 1: 0.039, 4: 0.5 },
    keys: [
      { id: 3, group_id: 3, key: 'test-only' },
      { id: 4, group_id: 4, key: 'test-only' },
      { id: 5, group_id: 5, key: 'test-only', group: { id: 5, name: 'embedded', rate_multiplier: 0.2 } },
    ],
  });
  assert.deepEqual(snapshot.groups.map(({ id, multiplier, multiplierKnown }) => ({ id, multiplier, multiplierKnown })), [
    { id: '1', multiplier: 0.039, multiplierKnown: true },
    { id: '2', multiplier: 0, multiplierKnown: true },
    { id: '3', multiplier: 1, multiplierKnown: false },
    { id: '4', multiplier: 0.5, multiplierKnown: true },
    { id: '5', multiplier: 0.2, multiplierKnown: true },
  ]);
});

test('new-api distinguishes declared/embedded rates from display-only fallbacks without rounding', () => {
  const snapshot = normalizeNewApiSnapshot({
    site: { id: 's1' },
    profile: { quota: 100 }, status: { quota_per_unit: 1 },
    groups: { declared: { ratio: 0.039 }, free: { ratio: 0 }, unknown: { ratio: '自动' }, invalid: { ratio: false } },
    tokens: [
      { id: 1, group: 'token-unknown' },
      { id: 2, group: 'token-effective', effective_group_ratio: 0.06, base_group_ratio: 2 },
      { id: 3, group: 'token-invalid', group_ratio: '   ' },
    ],
  });
  const group = (id) => snapshot.groups.find((item) => item.id === id);
  assert.equal(group('declared').multiplier, 0.039);
  assert.equal(group('declared').multiplierKnown, true);
  assert.equal(group('free').multiplierKnown, true);
  for (const id of ['unknown', 'invalid', 'token-unknown', 'token-invalid']) assert.equal(group(id).multiplierKnown, false, id);
  assert.equal(group('token-effective').multiplier, 0.06);
  assert.equal(group('token-effective').multiplierKnown, true);
});

test('adapters distinguish confirmed empty membership from absent or malformed responses', () => {
  const sub = (groups, keys) => normalizeSub2ApiSnapshot({ site: { id: 's1' }, groups, keys });
  assert.equal(sub([], []).groupsComplete, true);
  assert.equal(sub({ data: { items: [] } }, { data: { items: [] } }).groupsComplete, true);
  for (const [groups, keys] of [[undefined, []], [null, []], [{}, []], [[], undefined], [[], {}]]) {
    assert.equal(sub(groups, keys).groupsComplete, false);
  }
  const newApi = (groups, tokens) => normalizeNewApiSnapshot({ site: { id: 's1' }, groups, tokens });
  assert.equal(newApi({}, []).groupsComplete, true);
  assert.equal(newApi({}, { tokens: [] }).groupsComplete, true);
  assert.equal(newApi({}, { data: [] }).groupsComplete, true);
  assert.equal(newApi({}, { list: [] }).groupsComplete, false);
  assert.equal(newApi({ data: {} }, { data: { items: [] } }).groupsComplete, true);
  for (const [groups, tokens] of [[undefined, []], [null, []], [[], []], [{}, undefined], [{}, {}]]) {
    assert.equal(newApi(groups, tokens).groupsComplete, false);
  }
});

test('rate audit platform follows real adapter provenance, never the display fallback', async () => {
  const { diffGroupRateSnapshot } = await import('../src/group-rate-changes.mjs');
  const cases = [
    { type: 'sub2api', name: 'default', expected: 'unknown', display: 'openai' },
    { type: 'sub2api', name: 'Claude 专用', expected: 'anthropic', display: 'openai' },
    { type: 'sub2api', name: 'default', platform: 'google', expected: 'gemini', display: 'openai' },
    { type: 'sub2api', name: 'OpenAI 名称', platform: 'anthropic', expected: 'anthropic', display: 'anthropic' },
    { type: 'new-api', name: 'account', expected: 'unknown', display: 'anthropic' },
    { type: 'new-api', name: 'Codex | 福利组', expected: 'openai', display: 'openai' },
    { type: 'new-api', name: 'CCMAX2', expected: 'unknown', display: 'anthropic' },
    { type: 'new-api', name: 'Grok Heavy', expected: 'grok', display: 'grok' },
    { type: 'new-api', name: 'Gemini 高速', expected: 'gemini', display: 'gemini' },
    { type: 'new-api', name: 'Claude + GPT 通用', expected: 'unknown', display: 'anthropic' },
  ];
  for (const entry of cases) {
    const site = { id: 'site', type: entry.type, name: '测试', url: 'https://fixture.test', usdToCnyRate: 1 };
    const normalize = (rate) => entry.type === 'sub2api'
      ? normalizeSub2ApiSnapshot({ site, groups: [{ id: 1, name: entry.name, platform: entry.platform, rate_multiplier: rate }], keys: [] })
      : normalizeNewApiSnapshot({ site, groups: { [entry.name]: { ratio: rate } }, tokens: [] });
    const initial = normalize(1); const changed = normalize(2);
    assert.equal(changed.groups[0].platform, entry.display, 'existing general UI platform behavior remains unchanged');
    assert.equal(changed.groups[0].ratePlatform, entry.expected, entry.name);
    const baseline = diffGroupRateSnapshot({ site, snapshot: initial }).baseline;
    const event = diffGroupRateSnapshot({ site, snapshot: changed, baseline }).changes[0];
    assert.equal(event.platform, entry.expected, entry.name);
  }
});

test('token-only embedded sub2api groups also retain trustworthy rate-platform evidence', () => {
  const snapshot = normalizeSub2ApiSnapshot({ site: { id: 's1' }, groups: [], keys: [
    { id: 1, group_id: 1, group: { id: 1, name: 'Claude 专用', rate_multiplier: 1 } },
    { id: 2, group_id: 2, group: { id: 2, name: 'default', platform: 'grok', rate_multiplier: 1 } },
    { id: 3, group_id: 3 },
  ] });
  assert.deepEqual(snapshot.groups.map((g) => g.ratePlatform), ['anthropic', 'grok', 'unknown']);
});
