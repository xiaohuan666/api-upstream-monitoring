export const DEFAULT_GROUP_KEY_FILTER = '1';

export function normalizeGroupKeyFilter(value) {
  if (value === '1' || value === 'all') return value;
  return DEFAULT_GROUP_KEY_FILTER;
}
