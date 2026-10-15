export const AUTO_REFRESH_PREFERENCE_KEY = 'auto-refresh';

export const DEFAULT_AUTO_REFRESH_SETTINGS = {
  enabled: false,
  intervalValue: 10,
  intervalUnit: 'minutes',
  rules: [],
};

const INTERVAL_UNITS = new Set(['minutes', 'hours', 'days']);
const UNIT_MS = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

export function normalizeAutoRefreshSettings(input = {}) {
  return {
    ...normalizeRefreshIntervalSettings(input),
    rules: (Array.isArray(input?.rules) ? input.rules : []).map((rule) => {
      const { intervalValue, intervalUnit } = normalizeRefreshIntervalSettings(rule);
      return {
        siteIds: [...new Set((Array.isArray(rule?.siteIds) ? rule.siteIds : [])
          .filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))],
        intervalValue,
        intervalUnit,
      };
    }),
  };
}

export function normalizeRefreshIntervalSettings(input = {}) {
  const rawUnit = String(input?.intervalUnit ?? input?.interval_unit ?? '').trim();
  const intervalUnit = INTERVAL_UNITS.has(rawUnit) ? rawUnit : DEFAULT_AUTO_REFRESH_SETTINGS.intervalUnit;
  const rawValue = Number(input?.intervalValue ?? input?.interval_value ?? DEFAULT_AUTO_REFRESH_SETTINGS.intervalValue);
  const fallbackValue = intervalUnit === DEFAULT_AUTO_REFRESH_SETTINGS.intervalUnit
    ? DEFAULT_AUTO_REFRESH_SETTINGS.intervalValue
    : 1;
  const integerValue = Number.isFinite(rawValue) ? Math.floor(rawValue) : fallbackValue;
  const minValue = intervalUnit === 'minutes' ? 5 : 1;

  return {
    enabled: normalizeEnabled(input?.enabled),
    intervalValue: Math.max(minValue, integerValue),
    intervalUnit,
  };
}

export function autoRefreshIntervalMs(settings = {}) {
  const normalized = normalizeRefreshIntervalSettings(settings);
  return normalized.intervalValue * UNIT_MS[normalized.intervalUnit];
}

export function refreshSettingsForSite(settings, siteId) {
  return settings.rules?.find((rule) => rule.siteIds.includes(siteId)) ?? settings;
}

export function validateAutoRefreshRules(input, sites) {
  if (input?.rules === undefined) return;
  if (!Array.isArray(input.rules)) throw new Error('专属规则必须是列表');
  const available = new Map(sites.filter((site) => ['sub2api', 'new-api'].includes(site.type))
    .map((site) => [site.id, site.name]));
  const assigned = new Set();
  for (const rule of input.rules) {
    if (!Array.isArray(rule?.siteIds) || !rule.siteIds.length) throw new Error('每条专属规则至少选择一个站点');
    if (!INTERVAL_UNITS.has(rule.intervalUnit)
      || !Number.isSafeInteger(rule.intervalValue)
      || rule.intervalValue < (rule.intervalUnit === 'minutes' ? 5 : 1)
      || !Number.isSafeInteger(rule.intervalValue * UNIT_MS[rule.intervalUnit])) {
      throw new Error('专属规则间隔无效，最短为 5 分钟');
    }
    for (const id of rule.siteIds) {
      if (!available.has(id)) throw new Error('专属规则包含已删除或不支持同步的站点，请重新选择');
      if (assigned.has(id)) throw new Error(`站点“${available.get(id)}”重复分配，请只保留一条规则`);
      assigned.add(id);
    }
  }
}

function normalizeEnabled(value) {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}
