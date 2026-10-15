export const GROUP_VIEW_PREFERENCE_KEY = 'group-management';

const SORT_KEYS = new Set(['site', 'multiplier']);
const SORT_DIRECTIONS = new Set(['asc', 'desc']);
const PLATFORM_FILTERS = new Set(['all', 'openai', 'anthropic', 'grok', 'gemini']);
const KEY_FILTERS = new Set(['1', 'all']);
const SCHEDULABLE_FILTERS = new Set(['all', '1', '0']);

const textOrAll = (value) => String(value ?? '').trim() || 'all';

// 多选筛选值：字符串数组（也兼容逗号分隔字符串），去空去重；空数组 = 不筛选
const stringList = (value) => {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(items.map((item) => String(item ?? '').trim()).filter(Boolean))];
};

const oneOf = (allowed, fallback) => (value) => {
  const normalized = String(value ?? '').trim();
  return allowed.has(normalized) ? normalized : fallback;
};

const multiplierBound = (fallback) => (value) => {
  const raw = String(value ?? '').trim();
  if (raw === '') return fallback;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return num;
};

// 分组筛选的唯一注册表：新增筛选只需要在这里加一条（再在筛选栏放一个控件），
// 状态默认值、偏好归一化、预设保存/应用、预设弹窗字段全部由此驱动。
export const GROUP_FILTER_FIELDS = Object.freeze([
  {
    key: 'groupMultiplierMin',
    label: '倍率下限',
    control: 'number',
    defaultValue: 0,
    normalize: multiplierBound(0),
  },
  {
    key: 'groupMultiplierMax',
    label: '倍率上限',
    control: 'number',
    defaultValue: 100,
    normalize: multiplierBound(100),
  },
  {
    key: 'groupModelFilter',
    label: '模型',
    control: 'select',
    source: 'models',
    defaultValue: 'all',
    normalize: textOrAll,
  },
  {
    key: 'groupPlatformFilter',
    label: '平台',
    control: 'select',
    options: [
      ['all', '全部平台'],
      ['openai', 'OpenAI'],
      ['anthropic', 'Anthropic'],
      ['grok', 'Grok'],
      ['gemini', 'Gemini'],
    ],
    defaultValue: 'all',
    normalize: oneOf(PLATFORM_FILTERS, 'all'),
  },
  {
    key: 'groupSiteFilter',
    label: '站点',
    control: 'select',
    source: 'sites',
    defaultValue: 'all',
    normalize: textOrAll,
  },
  {
    key: 'groupKeyFilter',
    label: 'Key',
    control: 'select',
    options: [
      ['1', '有 Key'],
      ['all', '全部'],
    ],
    defaultValue: '1',
    normalize: oneOf(KEY_FILTERS, '1'),
  },
  {
    key: 'groupMyGroupFilter',
    label: '分组',
    control: 'multiselect',
    defaultValue: [],
    normalize: stringList,
  },
  {
    key: 'groupSchedulableFilter',
    label: '可调度',
    control: 'select',
    options: [
      ['all', '全部'],
      ['1', '可调度'],
      ['0', '不可调度'],
    ],
    defaultValue: 'all',
    normalize: oneOf(SCHEDULABLE_FILTERS, 'all'),
  },
]);

export const DEFAULT_GROUP_FILTERS = Object.freeze(
  Object.fromEntries(GROUP_FILTER_FIELDS.map((field) => [field.key, field.defaultValue])),
);

export function normalizeGroupFilters(input = {}) {
  return Object.fromEntries(
    GROUP_FILTER_FIELDS.map((field) => [field.key, field.normalize(input?.[field.key])]),
  );
}

export const DEFAULT_GROUP_VIEW_PREFERENCES = {
  groupSortKey: null,
  groupSortDirection: 'asc',
  ...DEFAULT_GROUP_FILTERS,
  filterPresets: [],
};

export function normalizeGroupFilterPreset(input = {}) {
  const name = String(input?.name ?? '').trim();
  return {
    name,
    ...normalizeGroupFilters(input),
  };
}

function normalizeFilterPresets(input) {
  if (!Array.isArray(input)) return [];
  const byName = new Map();
  for (const item of input) {
    const preset = normalizeGroupFilterPreset(item);
    if (preset.name) byName.set(preset.name, preset);
  }
  return [...byName.values()];
}

export function normalizeGroupViewPreferences(input = {}) {
  const groupSortKey = String(input?.groupSortKey ?? '').trim();
  const groupSortDirection = String(input?.groupSortDirection ?? '').trim();

  return {
    groupSortKey: SORT_KEYS.has(groupSortKey) ? groupSortKey : null,
    groupSortDirection: SORT_DIRECTIONS.has(groupSortDirection) ? groupSortDirection : 'asc',
    ...normalizeGroupFilters(input),
    filterPresets: normalizeFilterPresets(input?.filterPresets),
  };
}
