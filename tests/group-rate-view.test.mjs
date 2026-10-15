import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRateChangeFeed, rateChangeDisplay, rateChangeTime, rateChangeQuery, readRateChangeFilters,
  RATE_CHANGE_PAGE_SIZE, RATE_CHANGE_POLL_MS,
} from '../src/group-rate-view.mjs';

const asOf = '2026-10-02T12:00:00.000Z';
const page = (items, overrides = {}) => ({ items, total: items.length, page: 1, pageSize: 50, pages: 1, asOf, windowStart: null, snapshot: '42', ...overrides });
const response = (payload, ok = true) => ({ ok, json: async () => payload });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('display retains full decimal precision and distinguishes zero base from new groups', () => {
  assert.deepEqual(rateChangeDisplay({ oldMultiplier: 0.273, newMultiplier: 0.273000000001, rawOldMultiplier: 0.039, rawNewMultiplier: 0.039000000001 }), {
    old: '0.273', new: '0.273000000001', direction: 'up', percent: '上涨 <0.01%',
  });
  const zero = rateChangeDisplay({ oldMultiplier: 0, newMultiplier: 0.003 });
  assert.equal(zero.percent, '零基数 · 涨幅不适用');
  assert.doesNotMatch(zero.percent, /Infinity|新增/);
  assert.equal(rateChangeDisplay({ oldMultiplier: 0.5, newMultiplier: 0 }).percent, '下跌 100.00%');
  assert.equal(rateChangeDisplay({ oldMultiplier: 1, newMultiplier: 1 }).direction, 'same');
  assert.doesNotMatch(rateChangeDisplay({ oldMultiplier: Number.MIN_VALUE, newMultiplier: 10 }).percent, /Infinity/);
});

test('relative and exact timestamps coexist including future/invalid timestamps', () => {
  const now = Date.parse(asOf);
  assert.equal(rateChangeTime(asOf, now).relative, '刚刚');
  assert.equal(rateChangeTime('2026-10-02T11:58:00Z', now).relative, '2分钟前');
  assert.equal(rateChangeTime('2026-10-02T10:00:00Z', now).relative, '2小时前');
  assert.equal(rateChangeTime('2026-09-29T12:00:00Z', now).relative, '3天前');
  assert.match(rateChangeTime(asOf, now).exact, /2026/);
  assert.equal(rateChangeTime('invalid', now).relative, '时间未知');
  assert.equal(rateChangeTime('2026-10-03T12:00:00Z', now).relative, '刚刚');
});

test('read-only queries use 50-item pages, omit all window, and encode keywords/asOf', () => {
  assert.equal(RATE_CHANGE_PAGE_SIZE, 50);
  assert.ok(RATE_CHANGE_POLL_MS >= 30_000 && RATE_CHANGE_POLL_MS <= 60_000);
  assert.deepEqual(readRateChangeFilters('?q=%20A%26B%20&direction=down&window=24h&siteId=site'), {
    siteId: 'site', q: 'A&B', direction: 'down', window: '24h',
  });
  const params = new URLSearchParams(rateChangeQuery({ filters: { q: '<分组>', window: 'all' }, page: 3, asOf }));
  assert.equal(params.has('window'), false);
  assert.equal(params.get('q'), '<分组>');
  assert.equal(params.get('pageSize'), '50');
  assert.equal(params.get('asOf'), asOf);
  assert.equal(readRateChangeFilters('?direction=other&window=bad').direction, '');
  assert.equal(new URLSearchParams(rateChangeQuery({ filters: { window: '24h' } })).get('window'), '24h');
});

test('request generations prevent an old response from overwriting newer filters even if abort is ignored', async () => {
  const requests = [];
  const feed = createRateChangeFeed({ fetch: (url, options) => {
    const pending = deferred(); requests.push({ url, options, pending }); return pending.promise;
  } });
  const older = feed.load({ filters: { q: 'old' } });
  const newer = feed.load({ filters: { q: 'new' } });
  assert.equal(requests[0].options.signal.aborted, true);
  requests[1].pending.resolve(response(page([{ id: 'new' }])));
  assert.equal(await newer, true);
  requests[0].pending.resolve(response(page([{ id: 'old' }])));
  assert.equal(await older, false);
  assert.equal(feed.state.items[0].id, 'new');
  assert.equal(feed.state.loading, false);
});

test('scroll pagination locks asOf, does not truncate at 50, and refresh clears the bound', async () => {
  const urls = [];
  const first = Array.from({ length: 50 }, (_, i) => ({ id: `event-${i}` }));
  const feed = createRateChangeFeed({ fetch: async (url, options) => {
    urls.push(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.cache, 'no-store');
    const n = Number(new URL(url, 'http://local').searchParams.get('page'));
    return response(page(n === 1 ? first : [{ id: 'event-50' }, { id: 'event-49' }], { page: n, pages: 2, total: 51 }));
  } });
  await feed.load({ filters: { window: '24h' } });
  await feed.load({ filters: { window: '24h' }, page: 2, append: true });
  assert.equal(feed.state.items.length, 51);
  assert.equal(new URL(urls[1], 'http://local').searchParams.get('asOf'), asOf);
  assert.equal(new URL(urls[1], 'http://local').searchParams.get('snapshot'), '42');
  await feed.load({ filters: { window: '24h' } });
  assert.equal(new URL(urls[2], 'http://local').searchParams.has('asOf'), false);
  assert.equal(new URL(urls[2], 'http://local').searchParams.has('snapshot'), false);
  assert.equal(feed.state.items.length, 50);
});

test('load/append failures are local and retryable; full refresh removes stale data on failure', async () => {
  let fail = false;
  const states = [];
  const feed = createRateChangeFeed({ fetch: async () => response(fail ? { error: '<failed>' } : page([{ id: 'one' }], { pages: 2 }), !fail), onChange: (s) => states.push({ loading: s.loading, error: s.error }) });
  await feed.load();
  fail = true;
  assert.equal(await feed.load({ page: 2, append: true }), false);
  assert.equal(feed.state.items.length, 1);
  assert.match(feed.state.error, /<failed>/);
  assert.equal(await feed.load(), false);
  assert.equal(feed.state.items.length, 0);
  fail = false;
  assert.equal(await feed.load(), true);
  assert.equal(feed.state.error, '');
  assert.ok(states.some((s) => s.loading));
});

test('cancelled errors and malformed responses cannot mutate the current feed', async () => {
  const pending = deferred();
  const feed = createRateChangeFeed({ fetch: () => pending.promise });
  const load = feed.load();
  feed.cancel();
  pending.resolve(response({ error: 'old failure' }, false));
  assert.equal(await load, false);
  assert.equal(feed.state.error, '');
  const malformed = createRateChangeFeed({ fetch: async () => response({ items: [] }) });
  assert.equal(await malformed.load(), false);
  assert.match(malformed.state.error, /返回格式错误/);
});


test('stalled reads time out to a retryable local error', async () => {
  const feed = createRateChangeFeed({ requestTimeoutMs: 5, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  assert.equal(await feed.load(), false);
  assert.equal(feed.state.loading, false);
  assert.match(feed.state.error, /请求超时，请重试/);
});
