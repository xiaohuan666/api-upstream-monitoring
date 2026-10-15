import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GROUP_FILTERS,
  DEFAULT_GROUP_VIEW_PREFERENCES,
  GROUP_FILTER_FIELDS,
  GROUP_VIEW_PREFERENCE_KEY,
  normalizeGroupFilterPreset,
  normalizeGroupViewPreferences,
} from '../src/group-view-preferences.mjs';

test('normalizeGroupViewPreferences keeps valid filters and sorting', () => {
  const preferences = normalizeGroupViewPreferences({
    groupSortKey: 'multiplier',
    groupSortDirection: 'desc',
    groupModelFilter: 'gpt-5.5',
    groupSiteFilter: 'site-1',
    groupPlatformFilter: 'anthropic',
    groupKeyFilter: 'all',
  });

  assert.equal(GROUP_VIEW_PREFERENCE_KEY, 'group-management');
  assert.deepEqual(preferences, {
    groupSortKey: 'multiplier',
    groupSortDirection: 'desc',
    groupModelFilter: 'gpt-5.5',
    groupSiteFilter: 'site-1',
    groupPlatformFilter: 'anthropic',
    groupKeyFilter: 'all',
    groupMyGroupFilter: [],
    groupSchedulableFilter: 'all',
    groupMultiplierMin: 0,
    groupMultiplierMax: 100,
    filterPresets: [],
  });
});

test('normalizeGroupViewPreferences falls back for invalid values', () => {
  assert.deepEqual(
    normalizeGroupViewPreferences({
      groupSortKey: 'balance',
      groupSortDirection: 'sideways',
      groupModelFilter: '',
      groupSiteFilter: '',
      groupPlatformFilter: 'vertex',
      groupKeyFilter: 'keyed',
    }),
    DEFAULT_GROUP_VIEW_PREFERENCES,
  );
});

test('normalizeGroupViewPreferences keeps named filter presets', () => {
  const preferences = normalizeGroupViewPreferences({
    filterPresets: [
      {
        name: ' 低价 OpenAI ',
        groupModelFilter: 'gpt-5.6-sol',
        groupSiteFilter: 'site-1',
        groupPlatformFilter: 'openai',
        groupKeyFilter: 'all',
      },
      { name: '', groupPlatformFilter: 'openai' },
      'not-a-preset',
      { name: '低价 OpenAI', groupModelFilter: 'gpt-5.5', groupPlatformFilter: 'vertex' },
    ],
  });

  assert.deepEqual(preferences.filterPresets, [
    {
      name: '低价 OpenAI',
      groupModelFilter: 'gpt-5.5',
      groupSiteFilter: 'all',
      groupPlatformFilter: 'all',
      groupKeyFilter: '1',
      groupMyGroupFilter: [],
      groupSchedulableFilter: 'all',
      groupMultiplierMin: 0,
      groupMultiplierMax: 100,
    },
  ]);
});

test('normalizeGroupFilterPreset validates and falls back per field', () => {
  assert.deepEqual(normalizeGroupFilterPreset({
    name: ' 有 Key 的站点 ',
    groupModelFilter: '',
    groupSiteFilter: '',
    groupPlatformFilter: 'vertex',
    groupKeyFilter: 'keyed',
    groupMyGroupFilter: ['site-1:7', 'site-1:7', '', 'site-1:9'],
    groupSchedulableFilter: 'yes',
    groupMultiplierMin: '0.05',
    groupMultiplierMax: '-3',
  }), {
    name: '有 Key 的站点',
    groupModelFilter: 'all',
    groupSiteFilter: 'all',
    groupPlatformFilter: 'all',
    groupKeyFilter: '1',
    groupMyGroupFilter: ['site-1:7', 'site-1:9'],
    groupSchedulableFilter: 'all',
    groupMultiplierMin: 0.05,
    groupMultiplierMax: 100,
  });
});

test('multiselect filter normalizes comma strings and non-arrays', () => {
  const preset = normalizeGroupFilterPreset({
    name: 'multi',
    groupMyGroupFilter: 'site-1:7, __ungrouped__ ,',
    groupSchedulableFilter: '0',
  });
  assert.deepEqual(preset.groupMyGroupFilter, ['site-1:7', '__ungrouped__']);
  assert.equal(preset.groupSchedulableFilter, '0');
  assert.deepEqual(normalizeGroupFilterPreset({ name: 'x', groupMyGroupFilter: 42 }).groupMyGroupFilter, ['42']);
});

test('presets saved before a new filter existed pick up its default value', () => {
  // 架构保证：后续新增筛选字段时，旧预设归一化后自动带上默认值，无需迁移
  const preset = normalizeGroupFilterPreset({
    name: 'claude',
    groupPlatformFilter: 'anthropic',
  });

  for (const field of GROUP_FILTER_FIELDS) {
    assert.ok(field.key in preset, `preset missing ${field.key}`);
  }
  assert.equal(preset.groupMultiplierMin, 0);
  assert.equal(preset.groupMultiplierMax, 100);
  assert.deepEqual(
    Object.keys(DEFAULT_GROUP_FILTERS).sort(),
    GROUP_FILTER_FIELDS.map((field) => field.key).sort(),
  );
});
