import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  RATE_HISTORY_PREFERENCE_KEY, RATE_HISTORY_COLUMNS, DEFAULT_RATE_HISTORY_COLUMN_ORDER, normalizeRateHistoryPreferences,
} from '../src/rate-history-preferences.mjs';
import { DEFAULT_GROUP_VIEW_PREFERENCES, normalizeGroupViewPreferences } from '../src/group-view-preferences.mjs';
import { createUiPreferencesRepository, normalizeUiPreferenceRecord } from '../src/db.mjs';

const defaultOrder = ['platform', 'group', 'site', 'change', 'old', 'new'];
const savedOrder = ['new', 'old', 'platform', 'group', 'site', 'change'];

test('rate history preference exports the six-column key/label contract and fresh defaults', () => {
  assert.equal(RATE_HISTORY_PREFERENCE_KEY, 'rate-change-history');
  assert.deepEqual(DEFAULT_RATE_HISTORY_COLUMN_ORDER, defaultOrder);
  assert.deepEqual(RATE_HISTORY_COLUMNS, [
    { key: 'platform', label: '模型平台' }, { key: 'group', label: '分组名' },
    { key: 'site', label: '站点' }, { key: 'change', label: '涨跌幅' },
    { key: 'old', label: '原倍率' }, { key: 'new', label: '现倍率' },
  ]);
  for (const input of [undefined, null, true, 7, 'site', [], {}, { columnOrder: null }, { columnOrder: 'site,new' }]) {
    assert.deepEqual(normalizeRateHistoryPreferences(input), { columnOrder: defaultOrder });
  }
  const first = normalizeRateHistoryPreferences();
  first.columnOrder.reverse();
  assert.deepEqual(normalizeRateHistoryPreferences(), { columnOrder: defaultOrder });
  assert.ok(Object.isFrozen(RATE_HISTORY_COLUMNS));
  assert.ok(RATE_HISTORY_COLUMNS.every(Object.isFrozen));
  assert.ok(Object.isFrozen(DEFAULT_RATE_HISTORY_COLUMN_ORDER));
});

test('column normalization preserves valid order, de-duplicates, filters unknowns and appends missing columns', () => {
  const input = { columnOrder: ['new', 'old', 'new', '__proto__', null, {}, 0, 'NEW', ' site ', 'group'], groupSortKey: 'site' };
  const before = structuredClone(input);
  const result = normalizeRateHistoryPreferences(input);
  assert.deepEqual(result, { columnOrder: ['new', 'old', 'group', 'platform', 'site', 'change'] });
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeRateHistoryPreferences(result), result);
  assert.deepEqual(normalizeRateHistoryPreferences({ columnOrder: savedOrder }), { columnOrder: savedOrder });
  assert.deepEqual(normalizeRateHistoryPreferences({ columnOrder: [] }), { columnOrder: defaultOrder });
});

test('DB row normalization only routes the exact history key to column preferences', () => {
  const preferences = { columnOrder: ['new', 'old'], groupSortKey: 'multiplier', groupSortDirection: 'desc', groupPlatformFilter: 'grok' };
  assert.deepEqual(normalizeUiPreferenceRecord({ preference_key: RATE_HISTORY_PREFERENCE_KEY, preferences, updated_at: new Date('2026-10-03T00:00:00Z') }), {
    preferenceKey: RATE_HISTORY_PREFERENCE_KEY, preferences: { columnOrder: savedOrder }, updatedAt: '2026-10-03T00:00:00.000Z',
  });
  for (const key of ['group-management', 'custom-preference', 'rate-change-history-extra']) {
    assert.deepEqual(normalizeUiPreferenceRecord({ preference_key: key, preferences }), {
      preferenceKey: key, preferences: normalizeGroupViewPreferences(preferences), updatedAt: null,
    });
  }
  assert.deepEqual(normalizeUiPreferenceRecord({ preference_key: RATE_HISTORY_PREFERENCE_KEY, preferences: { columnOrder: ['removed'] } }).preferences, { columnOrder: defaultOrder });
});

test('DB get/upsert returns independent history defaults and does not change other keys', async () => {
  const rows = new Map();
  const calls = [];
  const repository = createUiPreferencesRepository({ async query(sql, values) {
    calls.push({ sql, values });
    const [key, json] = values;
    if (/insert into ui_preferences/.test(sql)) {
      rows.set(key, { preference_key: key, preferences: JSON.parse(json), updated_at: new Date('2026-10-03T00:00:00Z') });
    }
    return { rows: rows.has(key) ? [rows.get(key)] : [] };
  } });
  const initial = await repository.getPreference(RATE_HISTORY_PREFERENCE_KEY);
  assert.deepEqual(initial, { preferenceKey: RATE_HISTORY_PREFERENCE_KEY, preferences: { columnOrder: defaultOrder }, updatedAt: null });
  initial.preferences.columnOrder.reverse();
  assert.deepEqual((await repository.getPreference(RATE_HISTORY_PREFERENCE_KEY)).preferences, { columnOrder: defaultOrder });
  const groupInitial = await repository.getPreference('group-management');
  assert.deepEqual(groupInitial.preferences, DEFAULT_GROUP_VIEW_PREFERENCES);
  await repository.upsertPreference('group-management', { groupSortKey: 'multiplier', groupSortDirection: 'desc', columnOrder: ['old'] });
  const groups = await repository.getPreference('group-management');
  const saved = await repository.upsertPreference(RATE_HISTORY_PREFERENCE_KEY, { columnOrder: ['new', 'old', 'old', 'unsafe'], groupSortKey: 'site' });
  assert.deepEqual(saved.preferences, { columnOrder: savedOrder });
  assert.deepEqual((await repository.getPreference(RATE_HISTORY_PREFERENCE_KEY)), saved);
  assert.deepEqual(await repository.getPreference('group-management'), groups);
  assert.deepEqual(rows.get(RATE_HISTORY_PREFERENCE_KEY).preferences, { columnOrder: savedOrder });
  assert.ok(calls.every(({ sql }) => /\$1/.test(sql)));
  for (const key of ['', '   ']) {
    await assert.rejects(repository.getPreference(key), /Preference key is required/);
    await assert.rejects(repository.upsertPreference(key, {}), /Preference key is required/);
  }
});

const connectionString = process.env.GROUP_RATE_TEST_DATABASE_URL;
test('PostgreSQL: history preferences persist, normalize legacy column data and remain isolated from group preferences', { skip: !connectionString, timeout: 30_000 }, async () => {
  const schema = `rate_preferences_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 1 });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  let created = false;
  try {
    await admin.query(`create schema ${schema}`);
    created = true;
    await pool.query(`create table ui_preferences (
      preference_key text primary key, preferences jsonb not null,
      updated_at timestamptz not null default now()
    )`);
    const repository = createUiPreferencesRepository(pool);
    assert.deepEqual((await repository.getPreference(RATE_HISTORY_PREFERENCE_KEY)).preferences, { columnOrder: defaultOrder });
    await repository.upsertPreference('group-management', { groupSortKey: 'multiplier', groupPlatformFilter: 'anthropic' });
    const groups = await repository.getPreference('group-management');
    const saved = await repository.upsertPreference(RATE_HISTORY_PREFERENCE_KEY, { columnOrder: ['new', 'old', 'unknown', 'new'] });
    assert.deepEqual(saved.preferences, { columnOrder: savedOrder });
    assert.ok(saved.updatedAt);
    assert.deepEqual(await createUiPreferencesRepository(pool).getPreference(RATE_HISTORY_PREFERENCE_KEY), saved);
    assert.deepEqual(await repository.getPreference('group-management'), groups);
    const persisted = (await pool.query('select * from ui_preferences where preference_key=$1', [RATE_HISTORY_PREFERENCE_KEY])).rows[0];
    assert.deepEqual(persisted.preferences, { columnOrder: savedOrder });
    await pool.query('update ui_preferences set preferences=$1 where preference_key=$2', [{ columnOrder: ['site', 'removed', 'site'] }, RATE_HISTORY_PREFERENCE_KEY]);
    assert.deepEqual((await repository.getPreference(RATE_HISTORY_PREFERENCE_KEY)).preferences, { columnOrder: ['site', 'platform', 'group', 'change', 'old', 'new'] });
    assert.deepEqual((await pool.query('select preferences from ui_preferences where preference_key=$1', [RATE_HISTORY_PREFERENCE_KEY])).rows[0].preferences, { columnOrder: ['site', 'removed', 'site'] });
    await repository.upsertPreference(RATE_HISTORY_PREFERENCE_KEY, null);
    assert.deepEqual((await repository.getPreference(RATE_HISTORY_PREFERENCE_KEY)).preferences, { columnOrder: defaultOrder });
    assert.deepEqual(await repository.getPreference('group-management'), groups);
  } finally {
    await pool.end();
    try {
      if (created) await admin.query(`drop schema ${schema} cascade`);
    } finally {
      await admin.end();
    }
  }
});
