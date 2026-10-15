import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateHistoryColumnState, reorderRateHistoryColumns } from '../src/rate-history-column-state.mjs';
import { DEFAULT_RATE_HISTORY_COLUMN_ORDER as DEFAULT } from '../src/rate-history-preferences.mjs';

const response = (columnOrder = DEFAULT) => ({ ok: true, async json() { return { preference: { preferences: { columnOrder } } }; } });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('column moves preserve all keys, support both directions and ignore invalid targets', () => {
  assert.deepEqual(reorderRateHistoryColumns(DEFAULT, 'site', 0), ['site', 'platform', 'group', 'change', 'old', 'new']);
  assert.deepEqual(reorderRateHistoryColumns(DEFAULT, 'platform', 5), ['group', 'site', 'change', 'old', 'new', 'platform']);
  assert.deepEqual(reorderRateHistoryColumns(DEFAULT, 'missing', 3), DEFAULT);
  assert.deepEqual(reorderRateHistoryColumns(DEFAULT, 'site', -1), DEFAULT);
  assert.deepEqual(reorderRateHistoryColumns(DEFAULT, 'site', 1.5), DEFAULT);
  assert.deepEqual(reorderRateHistoryColumns(DEFAULT, 'site', 6), DEFAULT);
});

test('loading failure blocks writes, retry loads database order without overwriting defaults', async () => {
  let failed = true; const calls = [];
  const store = createRateHistoryColumnState({ fetch: async (url, opts) => {
    calls.push({ url, opts }); if (failed) throw new Error('offline');
    return response(['site', 'group', 'platform', 'change', 'old', 'new']);
  } });
  store.move('site', 0);
  assert.equal(calls.length, 0);
  await store.load();
  assert.equal(store.state.loaded, false);
  assert.match(store.state.error, /读取失败/);
  store.move('site', 0); assert.equal(calls.length, 1);
  failed = false; await store.retry();
  assert.equal(store.state.loaded, true);
  assert.equal(store.state.columnOrder[0], 'site');
  assert.ok(calls.every((x) => !x.opts.method));
});

test('rapid moves serialize writes and coalesce the latest order without older response rollback', async () => {
  const first = deferred(); const puts = []; let active = 0; let maximum = 0;
  const store = createRateHistoryColumnState({ fetch: async (url, opts) => {
    if (opts.method !== 'PUT') return response();
    active++; maximum = Math.max(active, maximum);
    const order = JSON.parse(opts.body).columnOrder; puts.push(order);
    if (puts.length === 1) await first.promise;
    active--; return response(order);
  } });
  await store.load(); store.move('site', 0); store.move('new', 1); store.move('change', 0);
  assert.equal(puts.length, 1);
  const latest = [...store.state.columnOrder];
  first.resolve(); await tick();
  assert.equal(maximum, 1); assert.equal(puts.length, 2);
  assert.deepEqual(puts[1], latest); assert.deepEqual(store.state.columnOrder, latest);
  assert.equal(store.state.status, 'saved');
});

test('failed or mismatched saves are visible and retry the latest unsaved order', async () => {
  let result = 'fail'; let saved;
  const store = createRateHistoryColumnState({ fetch: async (url, opts) => {
    if (opts.method !== 'PUT') return response();
    if (result === 'fail') return { ok: false };
    saved = JSON.parse(opts.body).columnOrder;
    return response(result === 'mismatch' ? DEFAULT : saved);
  } });
  await store.load(); store.move('site', 0); await tick();
  assert.equal(store.state.columnOrder[0], 'site'); assert.match(store.state.error, /未保存/);
  result = 'mismatch'; await store.retry(); assert.match(store.state.error, /未保存/);
  result = 'ok'; await store.retry();
  assert.deepEqual(saved, store.state.columnOrder); assert.equal(store.state.status, 'saved');
});

test('malformed GET does not enable adjustments and destroy ignores late loads and queued saves', async () => {
  const invalid = createRateHistoryColumnState({ fetch: async () => ({ ok: true, async json() { return {}; } }) });
  await invalid.load(); assert.equal(invalid.state.loaded, false);
  const pending = deferred(); let renders = 0;
  const store = createRateHistoryColumnState({ fetch: () => pending.promise, onChange: () => { renders++; } });
  const loading = store.load(); store.destroy(); pending.resolve(response()); await loading;
  assert.equal(store.state.loaded, false); assert.equal(renders, 1);
  const write = deferred(); let writes = 0;
  const writing = createRateHistoryColumnState({ fetch: async (url, opts) => {
    if (opts.method !== 'PUT') return response(); writes++;
    await write.promise; return response(JSON.parse(opts.body).columnOrder);
  } });
  await writing.load(); writing.move('site', 0); writing.move('new', 0); writing.destroy(); write.resolve(); await tick();
  assert.equal(writes, 1);
});

test('explicit reload reads outside changes and disables editing until the read completes', async () => {
  const pending = deferred(); let gets = 0;
  const updated = ['site', 'group', 'platform', 'change', 'new', 'old'];
  const store = createRateHistoryColumnState({ fetch: async () => ++gets === 1 ? response() : pending.promise });
  await store.load(); await store.load(); assert.equal(gets, 1);
  const reloading = store.load({ reload: true });
  assert.equal(store.state.loaded, false);
  store.move('site', 0); assert.deepEqual(store.state.columnOrder, DEFAULT);
  pending.resolve(response(updated)); await reloading;
  assert.equal(gets, 2); assert.deepEqual(store.state.columnOrder, updated); assert.equal(store.state.loaded, true);
});

test('reload waits for pending serial saves and preserves failed unsaved edits instead of reading them away', async () => {
  const pending = deferred(); let saved = [...DEFAULT]; const methods = []; let failing = false;
  const store = createRateHistoryColumnState({ fetch: async (url, opts) => {
    methods.push(opts.method || 'GET');
    if (opts.method !== 'PUT') return response(saved);
    if (failing) return { ok: false };
    await pending.promise; saved = JSON.parse(opts.body).columnOrder;
    return response(saved);
  } });
  await store.load(); store.move('site', 0); const reloading = store.load({ reload: true });
  store.move('new', 0); const desired = [...store.state.columnOrder];
  assert.deepEqual(methods, ['GET', 'PUT']);
  pending.resolve(); await reloading;
  assert.deepEqual(methods, ['GET', 'PUT', 'PUT', 'GET']);
  assert.deepEqual(store.state.columnOrder, desired);
  failing = true; store.move('group', 0); await tick();
  const unsaved = [...store.state.columnOrder]; const calls = methods.length;
  await store.load({ reload: true });
  assert.equal(methods.length, calls); assert.deepEqual(store.state.columnOrder, unsaved); assert.match(store.state.error, /未保存/);
});
