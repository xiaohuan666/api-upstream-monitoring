import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_AUTO_REFRESH_SETTINGS,
  autoRefreshIntervalMs,
  normalizeAutoRefreshSettings,
  refreshSettingsForSite,
  validateAutoRefreshRules,
} from '../src/auto-refresh-settings.mjs';

test('normalizeAutoRefreshSettings defaults to disabled 10 minute interval', () => {
  assert.deepEqual(normalizeAutoRefreshSettings({}), DEFAULT_AUTO_REFRESH_SETTINGS);
});

test('normalizeAutoRefreshSettings enforces at least 5 minutes', () => {
  assert.deepEqual(
    normalizeAutoRefreshSettings({ enabled: true, intervalValue: 3, intervalUnit: 'minutes' }),
    { enabled: true, intervalValue: 5, intervalUnit: 'minutes', rules: [] },
  );
});

test('normalizeAutoRefreshSettings accepts hours and days without an upper bound', () => {
  assert.deepEqual(
    normalizeAutoRefreshSettings({ enabled: true, intervalValue: 9999, intervalUnit: 'hours' }),
    { enabled: true, intervalValue: 9999, intervalUnit: 'hours', rules: [] },
  );
  assert.deepEqual(
    normalizeAutoRefreshSettings({ enabled: true, intervalValue: 3650, intervalUnit: 'days' }),
    { enabled: true, intervalValue: 3650, intervalUnit: 'days', rules: [] },
  );
});

test('autoRefreshIntervalMs converts normalized settings to milliseconds', () => {
  assert.equal(
    autoRefreshIntervalMs({ enabled: true, intervalValue: 5, intervalUnit: 'minutes' }),
    5 * 60 * 1000,
  );
  assert.equal(
    autoRefreshIntervalMs({ enabled: true, intervalValue: 2, intervalUnit: 'hours' }),
    2 * 60 * 60 * 1000,
  );
  assert.equal(
    autoRefreshIntervalMs({ enabled: true, intervalValue: 1, intervalUnit: 'days' }),
    24 * 60 * 60 * 1000,
  );
});

test('rules associate IDs only and preserve the default interval for unmatched sites', () => {
  const settings = normalizeAutoRefreshSettings({ intervalValue: 5, rules: [
    { siteIds: ['stable-id'], intervalValue: 10, intervalUnit: 'minutes', siteName: 'old name' },
  ] });
  assert.deepEqual(settings.rules, [{ siteIds: ['stable-id'], intervalValue: 10, intervalUnit: 'minutes' }]);
  assert.equal(autoRefreshIntervalMs(refreshSettingsForSite(settings, 'stable-id')), 600000);
  assert.equal(autoRefreshIntervalMs(refreshSettingsForSite(settings, 'another-id')), 300000);
});

test('rule validation rejects duplicate, deleted, unsupported sites and invalid intervals', () => {
  const sites = [{ id: 'a', name: '站点甲', type: 'sub2api' }, { id: 'b', name: '站点乙', type: 'other' }];
  const rule = { siteIds: ['a'], intervalValue: 10, intervalUnit: 'minutes' };
  assert.doesNotThrow(() => validateAutoRefreshRules({ rules: [rule] }, sites));
  for (const rules of [null, {}, [null], [{ ...rule, siteIds: [] }], [rule, rule],
    [{ ...rule, siteIds: ['a', 'a'] }], [{ ...rule, siteIds: ['b'] }], [{ ...rule, siteIds: ['deleted'] }],
    [{ ...rule, intervalValue: 4 }], [{ ...rule, intervalValue: 5.5 }], [{ ...rule, intervalUnit: 'seconds' }],
    [{ ...rule, intervalValue: Number.MAX_SAFE_INTEGER }]]) {
    assert.throws(() => validateAutoRefreshRules({ rules }, sites));
  }
});
