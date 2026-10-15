import test from 'node:test';
import assert from 'node:assert/strict';
import { diffGroupRateSnapshot, isKnownMultiplier, parseGroupRateChangeQuery } from '../src/group-rate-changes.mjs';
import { inferRateHistoryPlatform, normalizeRateHistorySiteUrl, resolveRateHistoryMetadata } from '../src/group-rate-metadata.mjs';
import { createGroupRateChangeRepository, recordGroupRateSnapshot } from '../src/group-rate-store.mjs';

const site = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '站点', type: 'sub2api', usdToCnyRate: 7 };
const firstTime = '2026-10-01T00:00:00.000Z';
const secondTime = '2026-10-01T00:01:00.000Z';
const group = (id, multiplier, extra = {}) => ({ id, name: `分组${id}`, multiplier, multiplierKnown: true, ...extra });
const snapshot = (groups, extra = {}) => ({ groups, balanceCurrency: 'USD', probe: { ok: true }, ...extra });
function transition(groups, { baseline = null, fetchedAt = secondTime, observedSite = site, ...extra } = {}) {
  return diffGroupRateSnapshot({ site: observedSite, snapshot: snapshot(groups, extra), fetchedAt, baseline });
}
function baseline(groups = [group('a', 1), group('b', 2)]) {
  return transition(groups, { fetchedAt: firstTime }).baseline;
}
const query = (text = '', now = new Date(secondTime)) => parseGroupRateChangeQuery(new URLSearchParams(text), { now });

test('isKnownMultiplier accepts only explicit finite nonnegative numbers and nonempty numeric strings', () => {
  for (const value of [0, -0, 1, 0.00001, Number.MIN_VALUE, '0', ' 0 ', '1.25', '1e-12']) {
    assert.equal(isKnownMultiplier(value), true, String(value));
  }
  for (const value of [null, undefined, false, true, {}, [], [0], 0n, '', ' ', '\t', 'nope', 'Infinity', NaN, Infinity, -Infinity, -1, '-0.01']) {
    assert.equal(isKnownMultiplier(value), false, String(value));
  }
});

test('first reliable observation initializes baseline without backfilling history, including zero', () => {
  const result = transition([group(0, '0'), group('b', '1.5')], { fetchedAt: firstTime });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.baseline, {
    siteType: 'sub2api', balanceCurrency: 'USD', fetchedAt: firstTime,
    groups: [{ id: '0', name: '分组0', multiplier: 0 }, { id: 'b', name: '分组b', multiplier: 1.5 }],
  });
});

test('events compare effective raw rates and convert both sides with current site exchange rate', () => {
  const previous = baseline([group('a', 0.1, { defaultMultiplier: 4 })]);
  assert.equal(transition([group('a', 0.1, { defaultMultiplier: 9 })], { baseline: previous }).changes.length, 0);
  assert.equal(transition([group('a', 0.1)], { baseline: previous, observedSite: { ...site, usdToCnyRate: 3 } }).changes.length, 0);
  const result = transition([group('a', 0.2, { defaultMultiplier: 9 })], { baseline: previous, observedSite: { ...site, name: '新站点', usdToCnyRate: 3 } });
  assert.deepEqual(result.changes, [{
    siteId: site.id, siteName: '新站点', siteType: 'sub2api', groupId: 'a', groupName: '分组a', platform: 'unknown', siteUrl: '',
    rawOldMultiplier: 0.1, rawNewMultiplier: 0.2, oldMultiplier: 0.3, newMultiplier: 0.6, changedAt: secondTime,
  }]);
  assert.deepEqual(previous, baseline([group('a', 0.1, { defaultMultiplier: 4 })]));
});

test('zero rate transitions are audited without division or fallback to a default rate', () => {
  const fromZero = transition([group('a', 0.5)], { baseline: baseline([group('a', 0)]) });
  assert.equal(fromZero.changes[0].rawOldMultiplier, 0);
  const toZero = transition([group('a', 0)], { baseline: baseline([group('a', 0.5)]) });
  assert.equal(toZero.changes[0].newMultiplier, 0);
});

test('identity is group ID, rename alone is not an event, new/deleted groups are not changes', () => {
  const previous = baseline();
  const renamed = transition([group('a', 1, { name: '改名' }), group('c', 10)], { baseline: previous });
  assert.deepEqual(renamed.changes, []);
  assert.deepEqual(renamed.baseline.groups.map((g) => g.id), ['a', 'c']);
  const changed = transition([group('a', 2, { name: '新名字' }), group('b', 8), group('c', 10)], { baseline: renamed.baseline });
  assert.equal(changed.changes.length, 1);
  assert.equal(changed.changes[0].groupName, '新名字');
  assert.equal(changed.changes[0].rawOldMultiplier, 1);
});

test('failed, absent, empty and wholly unknown snapshots never overwrite reliable baseline', () => {
  const previous = baseline();
  const cases = [
    null, {}, snapshot([]), snapshot(undefined), snapshot([group('a', 9)], { error: 'failed' }),
    snapshot([group('a', 9)], { probe: { ok: false } }), snapshot([group('a', 9)], { success: false }),
    snapshot([group('a', 1, { multiplierKnown: false })]),
    snapshot([group('a', null), group('b', NaN)]),
  ];
  for (const current of cases) {
    assert.deepEqual(diffGroupRateSnapshot({ site, snapshot: current, fetchedAt: secondTime, baseline: previous }), { baseline: null, changes: [] });
  }
  assert.equal(transition([group('a', 1)], { observedSite: { ...site, type: 'other' } }).baseline, null);
});

test('partially unknown rates retain reliable per-group values, invalid values are not zero', () => {
  const previous = baseline();
  for (const invalid of [null, undefined, '', ' ', 'oops', true, {}, [], Infinity, -1]) {
    const next = transition([group('a', invalid), group('b', 3), group('c', invalid)], { baseline: previous });
    assert.deepEqual(next.baseline.groups, [{ id: 'a', name: '分组a', multiplier: 1 }, { id: 'b', name: '分组b', multiplier: 3 }]);
    assert.deepEqual(next.changes.map((g) => g.groupId), ['b']);
  }
  const next = transition([group('a', 20, { multiplierKnown: false }), group('b', 3)], { baseline: previous });
  const recovered = transition([group('a', 2), group('b', 3)], { baseline: next.baseline });
  assert.equal(recovered.changes[0].rawOldMultiplier, 1);
});

test('type or currency changes reset baseline; unreliable transitions do not erase known context', () => {
  const previous = baseline();
  const changedType = transition([group('a', 50)], { baseline: previous, observedSite: { ...site, type: 'new-api' } });
  assert.equal(changedType.changes.length, 0);
  assert.equal(changedType.baseline.siteType, 'new-api');
  const changedCurrency = transition([group('a', 50)], { baseline: previous, balanceCurrency: 'CNY' });
  assert.equal(changedCurrency.changes.length, 0);
  const next = transition([group('a', 51)], { baseline: changedCurrency.baseline, balanceCurrency: ' cny ' });
  assert.equal(next.changes[0].oldMultiplier, 50);
  assert.equal(next.changes[0].newMultiplier, 51);
  const unknown = transition([group('a', 50, { multiplierKnown: false })], { baseline: previous, balanceCurrency: 'CNY' });
  assert.equal(unknown.baseline, null);
});

test('older observations are ignored; equal-time observations diff normally and exact retry deduplicates', () => {
  const previous = baseline();
  const older = transition([group('a', 50)], { baseline: previous, fetchedAt: '2026-09-30T23:59:59Z' });
  assert.deepEqual(older, { baseline: null, changes: [] });
  const sameTime = transition([group('a', 2)], { baseline: previous, fetchedAt: firstTime });
  assert.equal(sameTime.changes.length, 1);
  assert.equal(sameTime.baseline.fetchedAt, firstTime);
  assert.equal(transition([group('a', 2)], { baseline: sameTime.baseline, fetchedAt: firstTime }).changes.length, 0);
});

test('machine-level floating noise is suppressed without swallowing fine changes or tiny rates', () => {
  assert.equal(transition([group('a', 0.1 + 0.2)], { baseline: baseline([group('a', 0.3)]) }).changes.length, 0);
  for (const [oldRate, newRate] of [[1, 1 + 1e-12], [0.3, 0.3000000000001], [1e-12, 1e-12 + 1e-24], [0, Number.MIN_VALUE]]) {
    const result = transition([group('a', newRate)], { baseline: baseline([group('a', oldRate)]), balanceCurrency: 'USD' });
    assert.equal(result.changes.length, 1, `${oldRate} -> ${newRate}`);
  }
});

test('invalid observation date, duplicate group ID and display overflow reject unsafe transitions', () => {
  assert.throws(() => transition([group('a', 2)], { fetchedAt: 'bad' }), RangeError);
  assert.throws(() => transition([group('a', 2), group('a', 3)]), TypeError);
  assert.throws(() => transition([group('a', Number.MAX_VALUE)], { baseline: baseline([group('a', 1)]) }), RangeError);
});

test('query defaults and 24h bounds are computed from server now or stable supplied asOf', () => {
  assert.deepEqual(query(), {
    page: 1, pageSize: 50, window: null, siteId: null, direction: null, q: '', asOf: secondTime, windowStart: null, snapshot: null,
  });
  const result = query(`window=24h&page=2&pageSize=100&direction=down&siteId=${site.id.toUpperCase()}&q=%25_%5C&asOf=2026-10-02T08%3A00%3A00%2B08%3A00`);
  assert.equal(result.asOf, '2026-10-02T00:00:00.000Z');
  assert.equal(result.windowStart, firstTime);
  assert.equal(result.siteId, site.id);
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 100);
  assert.equal(result.q, '%_\\');
  assert.equal(query('asOf=2024-02-29T00:00:00Z').asOf, '2024-02-29T00:00:00.000Z');
});

test('query rejects malformed, duplicate, unsupported or out-of-range parameters', () => {
  const invalid = [
    'page=0', 'page=-1', 'page=1.5', 'page=1e2', 'page=01', 'page=+1', 'page=', 'page=NaN',
    'page=9007199254740992', 'page=9007199254740991&pageSize=100',
    'pageSize=0', 'pageSize=101', 'pageSize=Infinity', 'pageSize=true',
    'siteId=', 'siteId=not-a-uuid', 'siteId=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaag',
    'direction=', 'direction=UP', 'direction=all', 'window=', 'window=48h',
    'page=1&page=2', 'q=a&q=b', 'unknown=a', 'asOf=', 'asOf=not-a-date',
    'asOf=2026-10-02', 'asOf=2026-10-02T00:00:00', 'asOf=2026-02-30T00:00:00Z',
    'asOf=2026-02-29T00:00:00Z', 'asOf=2026-13-01T00:00:00Z', 'asOf=2026-10-02T24:00:00Z',
    'asOf=2026-10-02T00:00:00%2B24:00', 'asOf=2026-10-02T00:00:60Z',
    'asOf=0000-01-01T00:00:00Z', 'asOf=0001-01-01T00:00:00Z&window=24h',
    'asOf=9999-12-31T23:59:59-01:00', 'q=%00',
  ];
  for (const value of invalid) assert.throws(() => query(value), RangeError, value);
  assert.throws(() => parseGroupRateChangeQuery({}), TypeError);
  assert.throws(() => query('', new Date('bad')), RangeError);
});

test('repository uses a single parameterized query, literal LIKE escaping and exact response contract', async () => {
  const calls = [];
  const repository = createGroupRateChangeRepository({ async query(sql, values) {
    calls.push({ sql, values });
    return { rows: [{ total: '2', items: [{
      id: 'event', site_id: site.id, site_name: '站点', site_type: site.type, group_id: 'a', group_name: '分组',
      old_multiplier: 7, new_multiplier: 14, raw_old_multiplier: 1, raw_new_multiplier: 2, changed_at: secondTime,
    }] }] };
  } });
  const result = await repository.listChanges(query(`snapshot=42&q=${encodeURIComponent("%'_\\ OR 1=1")}&siteId=${site.id}&direction=up&window=24h&page=2&pageSize=1`));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].sql.includes('with filtered as'));
  assert.ok(calls[0].sql.includes('event_sequence <= $2::bigint'));
  assert.ok(!calls[0].sql.includes('OR 1=1'));
  assert.deepEqual(calls[0].values, [secondTime, '42', '2026-09-30T00:01:00.000Z', site.id, "%\\%'\\_\\\\ OR 1=1%", 1, 1]);
  assert.deepEqual(result, {
    items: [{ id: 'event', siteId: site.id, siteName: '站点', siteType: site.type, groupId: 'a', groupName: '分组', platform: 'unknown', siteUrl: '',
      oldMultiplier: 7, newMultiplier: 14, rawOldMultiplier: 1, rawNewMultiplier: 2, changedAt: secondTime }],
    total: 2, page: 2, pageSize: 1, pages: 2, asOf: secondTime, snapshot: '42', windowStart: '2026-09-30T00:01:00.000Z',
  });
});

test('repository validates direct options before SQL and maintains at least one empty page', async () => {
  let calls = 0;
  const repository = createGroupRateChangeRepository({ async query() {
    calls += 1;
    return { rows: [{ total: '0', items: [] }] };
  } });
  for (const options of [{ page: 0 }, { q: true }, { pageSize: {} }, { siteId: 'bad' }, { direction: 'all' }, { extra: 'bad' }, { extra: null }]) {
    await assert.rejects(repository.listChanges(options), (error) => error instanceof RangeError || error instanceof TypeError);
  }
  assert.equal(calls, 0);
  const result = await repository.listChanges({ asOf: new Date(secondTime), snapshot: '0' });
  assert.equal(result.pages, 1);
  assert.equal(result.asOf, secondTime);
  assert.equal(result.windowStart, null);
});

test('record uses caller client only, does not recheck sites or manage transactions, and propagates write errors', async () => {
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql, values });
    return { rows: [] };
  } };
  assert.deepEqual(await recordGroupRateSnapshot(client, { site, snapshot: snapshot([group('a', 1)]), fetchedAt: firstTime }), []);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ sql }) => !/\bbegin\b|\bcommit\b|\brollback\b|\bupstream_sites\b/i.test(sql)));
  const previous = baseline([group('a', 1)]);
  const failingClient = { async query(sql) {
    if (/select site_type/.test(sql)) return { rows: [{ site_type: previous.siteType, balance_currency: previous.balanceCurrency, fetched_at: new Date(firstTime), groups: previous.groups }] };
    throw new Error('audit insert failed');
  } };
  await assert.rejects(recordGroupRateSnapshot(failingClient, { site, snapshot: snapshot([group('a', 2)]), fetchedAt: secondTime }), /audit insert failed/);
});

test('pagination committed watermark retains bigint precision and rejects invalid values', () => {
  assert.equal(query('snapshot=0').snapshot, '0');
  assert.equal(query('snapshot=9223372036854775807').snapshot, '9223372036854775807');
  for (const token of ['', 'bad', '-1', '01', '1.1', '1e3', '9223372036854775808', '1'.repeat(30)]) {
    assert.throws(() => query(`snapshot=${encodeURIComponent(token)}`), RangeError, token);
  }
});

test('confirmed empty complete collection clears baseline; unknown empty and incomplete collection preserve it', () => {
  const previous = baseline();
  const cleared = diffGroupRateSnapshot({ site, baseline: previous, fetchedAt: secondTime,
    snapshot: { balanceCurrency: 'USD', groups: [], groupsComplete: true } });
  assert.deepEqual(cleared.baseline.groups, []);
  assert.deepEqual(cleared.changes, []);
  const reappeared = transition([group('a', 2)], { baseline: cleared.baseline, fetchedAt: '2026-10-02T00:01:00Z' });
  assert.deepEqual(reappeared.changes, []);
  assert.equal(transition([group('a', 3)], { baseline: reappeared.baseline, fetchedAt: '2026-10-02T00:02:00Z' }).changes.length, 1);
  for (const complete of [false, undefined]) {
    const unknown = diffGroupRateSnapshot({ site, baseline: previous, fetchedAt: secondTime, snapshot: { groups: [], groupsComplete: complete } });
    assert.equal(unknown.baseline, null);
  }
  const partial = diffGroupRateSnapshot({ site, baseline: previous, fetchedAt: secondTime,
    snapshot: { groups: [group('b', 2)], groupsComplete: false, balanceCurrency: previous.balanceCurrency } });
  assert.ok(partial.baseline.groups.some((item) => item.id === 'a'));
});


test('history metadata accepts only safe HTTP(S) origins and explicit unambiguous platforms', () => {
  assert.equal(normalizeRateHistorySiteUrl('https://fixture:secret@Relay.example:8443/keys?token=private#password'), 'https://relay.example:8443');
  assert.equal(normalizeRateHistorySiteUrl(' http://relay.example/path '), 'http://relay.example');
  for (const value of [null, {}, '', 'relay.example', '//relay.example', 'https:relay.example', 'javascript:alert(1)', 'data:text/html,unsafe', 'ftp://relay.example', 'https://', 'https://[bad]']) {
    assert.equal(normalizeRateHistorySiteUrl(value), '', String(value));
  }
  for (const [name, expected] of [['OpenAI 高级', 'openai'], ['GPT-4.1', 'openai'], ['ChatGPT', 'openai'], ['Claude3.5', 'anthropic'], ['Anthropic 专用', 'anthropic'], ['Grok-4', 'grok'], ['Gemini2', 'gemini'], ['default', 'unknown'], ['account', 'unknown'], ['kiro', 'unknown'], ['gptastic', 'unknown'], ['Grok + GPT', 'unknown']]) {
    assert.equal(inferRateHistoryPlatform(name), expected, name);
  }
  assert.deepEqual(resolveRateHistoryMetadata({ platform: 'Anthropic', snapshotPlatform: 'grok', groupName: 'OpenAI', siteUrl: 'https://user:secret@event.test/path', currentSiteUrl: 'https://current.test' }), {
    platform: 'anthropic', siteUrl: 'https://event.test',
  });
  assert.equal(resolveRateHistoryMetadata({ platform: 'unknown', snapshotPlatform: 'grok', groupName: 'OpenAI' }).platform, 'unknown');
  assert.equal(resolveRateHistoryMetadata({ platform: 'unrecognized', snapshotPlatform: 'grok', groupName: 'OpenAI' }).platform, 'unknown');
  assert.equal(resolveRateHistoryMetadata({ siteUrl: '', currentSiteUrl: 'https://current.test' }).siteUrl, '');
  assert.deepEqual(resolveRateHistoryMetadata({ snapshotPlatform: 'Grok', groupName: 'Claude', currentSiteUrl: 'javascript:alert(1)' }), { platform: 'grok', siteUrl: '' });
  assert.deepEqual(resolveRateHistoryMetadata({ groupName: 'Claude', currentSiteUrl: 'https://user:secret@current.test/query?token=secret' }), { platform: 'anthropic', siteUrl: 'https://current.test' });
});

test('new events snapshot safe platform/URL without adding metadata to reliable baselines', () => {
  const observedSite = { ...site, url: 'https://fixture:secret@rate.test/keys?token=private', rawPayload: { password: 'secret' } };
  const result = transition([group('a', 2, { name: 'OpenAI', ratePlatform: 'Anthropic', rawPayload: { password: 'secret' } })], { baseline: baseline([group('a', 1)]), observedSite });
  assert.equal(result.changes[0].platform, 'anthropic');
  assert.equal(result.changes[0].siteUrl, 'https://rate.test');
  assert.deepEqual(result.baseline.groups, [{ id: 'a', name: 'OpenAI', multiplier: 2 }]);
  assert.doesNotMatch(JSON.stringify(result), /fixture|secret|password|rawPayload|private/);
  assert.equal(transition([group('a', 2, { name: 'Gemini 高级' })], { baseline: baseline([group('a', 1)]) }).changes[0].platform, 'gemini');
});

test('repository maps only documented fields, keeping current fallbacks display-only', async () => {
  const raw = { id: 'event', site_id: site.id, site_name: '站点', site_type: site.type, group_id: 'a', group_name: 'Claude',
    old_multiplier: 7, new_multiplier: 14, raw_old_multiplier: 1, raw_new_multiplier: 2, changed_at: secondTime,
    platform: null, site_url: null, snapshot_platform: 'grok', current_site_url: 'https://user:private@rate.test/keys?token=private',
    raw_payload: { password: 'private' }, normalized_snapshot: { token: 'private' } };
  const repository = createGroupRateChangeRepository({ async query(sql) {
    assert.ok(!/raw_payload|select normalized_snapshot,/i.test(sql));
    return { rows: [{ total: '1', items: [raw] }] };
  } });
  const before = structuredClone(raw);
  const result = await repository.listChanges({ asOf: secondTime, snapshot: '1' });
  assert.equal(result.items[0].platform, 'grok');
  assert.equal(result.items[0].siteUrl, 'https://rate.test');
  assert.doesNotMatch(JSON.stringify(result), /private|password|raw_payload|normalized_snapshot|snapshot_platform|current_site_url/);
  assert.deepEqual(raw, before);
});
