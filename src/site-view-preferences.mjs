export const SITE_VIEW_PREFERENCE_KEY = 'site-management';

const WATCH_FILTERS = new Set(['all', '1', '0']);

// 站点多选筛选值：字符串数组（也兼容逗号分隔字符串），去空去重；空数组 = 不筛选
const stringList = (value) => {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(items.map((item) => String(item ?? '').trim()).filter(Boolean))];
};

export const DEFAULT_SITE_VIEW_PREFERENCES = Object.freeze({
  sitesSiteFilter: [],
  sitesWatchFilter: 'all',
});

export function normalizeSiteViewPreferences(input = {}) {
  const watchFilter = String(input?.sitesWatchFilter ?? '').trim();
  return {
    sitesSiteFilter: stringList(input?.sitesSiteFilter),
    sitesWatchFilter: WATCH_FILTERS.has(watchFilter) ? watchFilter : 'all',
  };
}
