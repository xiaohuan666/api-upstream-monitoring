import { displayMultiplier } from './currency-display.mjs';
import { resolveRateHistoryMetadata } from './group-rate-metadata.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUERY_KEYS = new Set(['window', 'page', 'pageSize', 'siteId', 'direction', 'q', 'asOf', 'snapshot']);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Accept explicit finite nonnegative values without coercing missing/boolean data to zero. */
export function isKnownMultiplier(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  if (typeof value === 'string' && !value.trim()) return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0;
}

/**
 * Pure transition of the last reliable effective rates. A null baseline means
 * no write; the caller owns transaction/locking and supplies the observed site.
 * Baseline groups contain only normalized numeric rates, never upstream payloads.
 */
export function diffGroupRateSnapshot({ site, snapshot, fetchedAt = snapshot?.refreshedAt ?? new Date(), baseline = null }) {
  const observedAt = observationTime(fetchedAt);
  if (baseline && observedAt.getTime() < observationTime(baseline.fetchedAt).getTime()) {
    return { baseline: null, changes: [] };
  }
  if (!['sub2api', 'new-api'].includes(site?.type)
      || !snapshot || snapshot.error || snapshot.probe?.ok === false
      || snapshot.ok === false || snapshot.success === false
      || !Array.isArray(snapshot.groups)) {
    return { baseline: null, changes: [] };
  }

  const balanceCurrency = normalizeCurrency(snapshot.balanceCurrency);
  if (snapshot.groups.length === 0) {
    // 只有适配器证实完整采集的空集合才能表示删除，未知结果仍保留基线。
    return snapshot.groupsComplete === true
      ? { baseline: { siteType: site.type, balanceCurrency, fetchedAt: observedAt.toISOString(), groups: [] }, changes: [] }
      : { baseline: null, changes: [] };
  }

  const observedGroups = new Map();
  const validGroups = new Map();
  for (const group of snapshot.groups) {
    if (!group || !['string', 'number'].includes(typeof group.id)) continue;
    const id = String(group.id);
    if (!id.trim()) continue;
    if (observedGroups.has(id)) throw new TypeError('Duplicate group ID in rate snapshot');
    observedGroups.set(id, group);
    if (group.multiplierKnown === false || !isKnownMultiplier(group.multiplier)) continue;
    validGroups.set(id, { id, name: String(group.name ?? id), multiplier: Number(group.multiplier) });
  }
  // An empty/unknown result cannot prove that all previously known groups disappeared.
  if (validGroups.size === 0) return { baseline: null, changes: [] };

  const sameContext = baseline?.siteType === site.type && baseline?.balanceCurrency === balanceCurrency;
  const previousGroups = new Map(sameContext ? baseline.groups.map((group) => [group.id, group]) : []);
  const changes = [];
  const nextGroups = snapshot.groupsComplete === false
    ? [...previousGroups.values()].filter((group) => !observedGroups.has(group.id))
    : [];
  for (const [id] of observedGroups) {
    const current = validGroups.get(id);
    const previous = previousGroups.get(id);
    if (!current) {
      // A temporarily unknown group retains its last reliable value, but a truly
      // absent group is removed so its later reappearance is a new observation.
      if (previous) nextGroups.push(previous);
      continue;
    }
    nextGroups.push(current);
    if (!previous || ratesEqual(previous.multiplier, current.multiplier)) continue;
    const oldMultiplier = displayMultiplier({ site, snapshot, multiplier: previous.multiplier });
    const newMultiplier = displayMultiplier({ site, snapshot, multiplier: current.multiplier });
    if (!Number.isFinite(oldMultiplier) || !Number.isFinite(newMultiplier)) {
      throw new RangeError('Displayed group multiplier must be finite');
    }
    changes.push({
      siteId: site.id,
      siteName: String(site.name ?? ''),
      siteType: site.type,
      groupId: id,
      groupName: current.name,
      ...resolveRateHistoryMetadata({
        platform: observedGroups.get(id).ratePlatform, siteUrl: site.url, groupName: current.name,
      }),
      rawOldMultiplier: previous.multiplier,
      rawNewMultiplier: current.multiplier,
      oldMultiplier,
      newMultiplier,
      changedAt: observedAt.toISOString(),
    });
  }
  return {
    baseline: { siteType: site.type, balanceCurrency, fetchedAt: observedAt.toISOString(), groups: nextGroups },
    changes,
  };
}

function ratesEqual(left, right) {
  if (left === right) return true;
  // Relative machine precision only: no fixed decimal rounding or absolute floor
  // that would erase small rates or genuine small changes near zero.
  const tolerance = Number.EPSILON * Math.max(Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= tolerance;
}

function normalizeCurrency(value) {
  return String(value ?? 'USD').trim().toUpperCase() || 'USD';
}

function observationTime(value) {
  if (!(value instanceof Date) && typeof value !== 'string') throw new TypeError('fetchedAt must be a date');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid observation time');
  return date;
}

/** Parse the public query contract. Duplicate/unknown keys and coercive numbers are rejected. */
export function parseGroupRateChangeQuery(searchParams, { now = new Date() } = {}) {
  if (!(searchParams instanceof URLSearchParams)) throw new TypeError('Expected URLSearchParams');
  for (const key of searchParams.keys()) {
    if (!QUERY_KEYS.has(key)) throw new RangeError(`Unknown group rate query parameter: ${key}`);
    if (searchParams.getAll(key).length !== 1) throw new RangeError(`Repeated group rate query parameter: ${key}`);
  }
  const page = positiveInteger(searchParams, 'page', 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInteger(searchParams, 'pageSize', 50, 100);
  if (!Number.isSafeInteger((page - 1) * pageSize)) throw new RangeError('Pagination offset is too large');
  const window = searchParams.get('window');
  if (window !== null && window !== '24h') throw new RangeError('window must be 24h');
  const siteId = searchParams.get('siteId');
  if (siteId !== null && !UUID_PATTERN.test(siteId)) throw new RangeError('siteId must be a UUID');
  const direction = searchParams.get('direction');
  if (direction !== null && direction !== 'up' && direction !== 'down') throw new RangeError('direction must be up or down');
  const q = searchParams.get('q');
  if (q?.includes('\0')) throw new RangeError('q must not contain NUL');
  const visibilitySnapshot = searchParams.has('snapshot') ? parseVisibilitySnapshot(searchParams.get('snapshot')) : null;
  const asOf = searchParams.has('asOf') ? parseAsOf(searchParams.get('asOf')) : parseAsOf(observationTime(now).toISOString());
  const start = new Date(asOf.getTime() - DAY_MS);
  if (window && (!Number.isFinite(start.getTime()) || start.getUTCFullYear() < 1)) {
    throw new RangeError('Invalid window start');
  }
  return {
    page,
    pageSize,
    window,
    siteId: siteId?.toLowerCase() ?? null,
    direction,
    q: q ?? '',
    snapshot: visibilitySnapshot,
    asOf: asOf.toISOString(),
    windowStart: window ? start.toISOString() : null,
  };
}

function positiveInteger(params, name, defaultValue, max) {
  if (!params.has(name)) return defaultValue;
  const text = params.get(name);
  if (!/^[1-9]\d*$/.test(text)) throw new RangeError(`${name} must be a positive integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > max) throw new RangeError(`${name} is out of range`);
  return value;
}

function parseAsOf(value) {
  // Require a timezone and a real calendar date; Date.parse alone silently rolls
  // February 30 into March and accepts locale-dependent date strings.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new RangeError('asOf must be an ISO timestamp with timezone');
  const [, y, m, d, h, min, s, , zone] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
      || Number(h) > 23 || Number(min) > 59 || Number(s) > 59
      || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    throw new RangeError('Invalid asOf timestamp');
  }
  const date = observationTime(value);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw new RangeError('asOf is out of range');
  return date;
}

// 已提交事件的单调水位，不把大整数转为 JS Number，避免精度丢失。
function parseVisibilitySnapshot(value) {
  if (!/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new RangeError('Invalid pagination snapshot');
  }
  return value;
}
