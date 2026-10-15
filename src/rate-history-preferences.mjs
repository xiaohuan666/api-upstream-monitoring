export const RATE_HISTORY_PREFERENCE_KEY = 'rate-change-history';

export const RATE_HISTORY_COLUMNS = Object.freeze([
  { key: 'platform', label: '模型平台' },
  { key: 'group', label: '分组名' },
  { key: 'site', label: '站点' },
  { key: 'change', label: '涨跌幅' },
  { key: 'old', label: '原倍率' },
  { key: 'new', label: '现倍率' },
].map(Object.freeze));

export const DEFAULT_RATE_HISTORY_COLUMN_ORDER = Object.freeze(RATE_HISTORY_COLUMNS.map(({ key }) => key));
const COLUMN_KEYS = new Set(DEFAULT_RATE_HISTORY_COLUMN_ORDER);

/** Preserve valid order, dropping duplicates/unknown columns and appending missing columns. */
export function normalizeRateHistoryPreferences(input = {}) {
  const requested = Array.isArray(input?.columnOrder) ? input.columnOrder : [];
  const columnOrder = [...new Set(requested.filter((key) => COLUMN_KEYS.has(key)))];
  for (const key of DEFAULT_RATE_HISTORY_COLUMN_ORDER) {
    if (!columnOrder.includes(key)) columnOrder.push(key);
  }
  return { columnOrder };
}
