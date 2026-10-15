import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteRefreshScheduler } from '../src/site-refresh-scheduler.mjs';

const minute = 60000;
const config = { enabled: true, intervalValue: 5, intervalUnit: 'minutes', rules: [
  { siteIds: ['special'], intervalValue: 10, intervalUnit: 'minutes' },
] };
const initialSites = [
  { id: 'special', name: '专属站点', type: 'sub2api' },
  { id: 'default', name: '默认站点', type: 'new-api' },
  { id: 'other', name: '其他站点', type: 'other' },
];

function setup({ refresh, list } = {}) {
  let time = 0;
  let nextId = 0;
  let sites = structuredClone(initialSites);
  const pending = new Map();
  const calls = [];
  const logs = [];
  const scheduler = createSiteRefreshScheduler({
    now: () => time,
    listSites: async () => list ? list(sites) : sites,
    refreshSite: async (site) => { calls.push({ id: site.id, name: site.name, at: time }); await refresh?.(site); },
    logger: { log: (text) => logs.push(text), error: (text) => logs.push(text) },
    timers: {
      setTimeout(fn, delay) { const id = ++nextId; pending.set(id, { fn, at: time + delay }); return id; },
      clearTimeout(id) { pending.delete(id); },
    },
  });
  function startNext() {
    const [id, timer] = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    pending.delete(id);
    time = timer.at;
    return timer.fn();
  }
  return {
    scheduler, calls, logs, pending,
    setSites(next) { sites = next; },
    startNext,
    async advance(target) {
      while ([...pending.values()].some((timer) => timer.at <= target)) await startNext();
      time = target;
    },
  };
}

test('5/10 minute schedules run independently; renamed sites retain their ID rule', async () => {
  const h = setup();
  h.scheduler.update(config);
  await h.advance(5 * minute);
  assert.deepEqual(h.calls.map((call) => call.id), ['default']);
  h.setSites(initialSites.map((site) => ({ ...site, name: `改名 ${site.name}` })));
  await h.advance(10 * minute);
  assert.deepEqual(h.calls.map((call) => [call.id, call.at]), [['default', 5 * minute], ['special', 10 * minute], ['default', 10 * minute]]);
  assert.equal(h.calls[1].name, '改名 专属站点');
  await h.advance(20 * minute);
  assert.equal(h.calls.filter((call) => call.id === 'special').length, 2);
  assert.equal(h.calls.filter((call) => call.id === 'default').length, 4);
});

test('failed refresh waits for its interval and does not block other sites', async () => {
  const h = setup({ refresh: async () => { throw new Error('credential must never appear'); } });
  h.scheduler.update(config);
  await h.advance(10 * minute);
  assert.deepEqual(h.calls.map((call) => call.id), ['default', 'special', 'default']);
  assert.ok(h.logs.every((line) => !line.includes('credential must never appear')));
});

test('list failures retry after discovery interval instead of spinning on overdue sites', async () => {
  let fail = false;
  const h = setup({ list: (sites) => { if (fail) throw new Error('db unavailable'); return sites; } });
  h.scheduler.update(config);
  await h.advance(4.5 * minute);
  fail = true;
  await h.advance(5 * minute);
  assert.equal(h.calls.length, 0);
  assert.deepEqual([...h.pending.values()].map((timer) => timer.at), [5.5 * minute]);
  fail = false;
  await h.advance(5.5 * minute);
  assert.equal(h.calls[0].id, 'default');
});

test('new sites inherit default; deleted sites are not refreshed; long intervals use bounded timers', async () => {
  const h = setup();
  h.scheduler.update({ ...config, rules: [{ siteIds: ['special'], intervalValue: 3650, intervalUnit: 'days' }] });
  await h.advance(minute);
  h.setSites([{ ...initialSites[0] }, { id: 'new', name: '新站点', type: 'sub2api' }]);
  await h.advance(6.5 * minute);
  assert.deepEqual(h.calls.map((call) => [call.id, call.at]), [['new', 6.5 * minute]]);
  assert.ok([...h.pending.values()].every((timer) => timer.at <= 7 * minute));
});

test('update during refresh stops old queue, never overlaps, and restarts from saved time', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const h = setup({ refresh: () => blocked });
  h.scheduler.update({ ...config, rules: [] });
  await h.advance(4.5 * minute);
  const oldRun = h.startNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  h.scheduler.update(config);
  assert.equal(h.pending.size, 0);
  release();
  await oldRun;
  assert.equal(h.calls.length, 1);
  await h.advance(10 * minute);
  assert.deepEqual(h.calls.map((call) => [call.id, call.at]), [['special', 5 * minute], ['default', 10 * minute]]);
});

test('stop and disable invalidate pending and in-flight callbacks', async () => {
  for (const stop of [(h) => h.scheduler.stop(), (h) => h.scheduler.update({ enabled: false })]) {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const h = setup({ refresh: () => blocked });
    h.scheduler.update({ ...config, rules: [] });
    const stale = [...h.pending.values()][0].fn;
    await h.advance(4.5 * minute);
    const oldRun = h.startNext();
    await new Promise((resolve) => setImmediate(resolve));
    stop(h);
    release();
    await oldRun;
    await stale();
    assert.equal(h.calls.length, 1);
    assert.equal(h.pending.size, 0);
  }
});

test('startup delays first refresh and legacy config uses its existing default', async () => {
  const h = setup();
  h.scheduler.update({ enabled: true, intervalValue: 7, intervalUnit: 'minutes' });
  await h.advance(6 * minute);
  assert.equal(h.calls.length, 0);
  await h.advance(7 * minute);
  assert.deepEqual(h.calls.map((call) => call.id), ['special', 'default']);
  h.scheduler.stop();
  h.scheduler.update(config);
  await h.advance(11 * minute);
  assert.equal(h.calls.length, 2);
  await h.advance(12 * minute);
  assert.equal(h.calls.at(-1).id, 'default');
});
