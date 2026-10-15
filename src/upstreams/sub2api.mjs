import { randomUUID } from 'node:crypto';
import { observeRateHistoryPlatform } from '../group-rate-metadata.mjs';
import { isKnownMultiplier } from '../group-rate-changes.mjs';
import { chromium } from 'playwright';
import { runBrowserTask } from './browser-task.mjs';

import { classifyProbe, normalizeProviderPlatform } from '../domain.mjs';
import { nonJsonResponseMessage, settleSnapshotRequests, withUpstreamApi } from './api-transport.mjs';
import { fetchSnapshotWithFallback } from './sync-strategy.mjs';

const DEFAULT_ACCESS_TOKEN_REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_REFRESH_TOKEN_ROTATION_MS = 24 * 60 * 60 * 1000;

export function unwrapSub2ApiPayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const code = payload.code;
    if (code !== undefined && Number(code) >= 400) {
      throw new Error(payload.message || `Sub2API request failed with code ${code}`);
    }
    if (Object.hasOwn(payload, 'data')) return payload.data;
  }
  return payload;
}

export function normalizeSub2ApiSnapshot({
  site,
  profile,
  groups,
  rates = [],
  keys,
  latencyMs,
  checkedAt = new Date(),
}) {
  const profileData = unwrapSub2ApiPayload(profile) ?? {};
  const groupPayload = unwrapSub2ApiPayload(groups);
  const keyPayload = unwrapSub2ApiPayload(keys);
  const groupList = asArray(groupPayload);
  const keyList = normalizeKeyList(keyPayload);
  const groupsComplete = hasListPayload(groupPayload, ['items', 'groups', 'list'])
    && hasListPayload(keyPayload, ['items', 'keys', 'list', 'data'])
    && groupList.every((group) => group && typeof group === 'object' && (group.id ?? group.group_id ?? group.name) != null)
    && keyList.every((key) => key && typeof key === 'object');
  const rateByGroupId = buildRateIndex(unwrapSub2ApiPayload(rates));
  const checkedAtIso = toIso(checkedAt);
  const keyCountByGroupId = countKeysByGroupId(keyList);
  const embeddedGroupById = collectEmbeddedGroups(keyList);
  const balance = Number(profileData.balance ?? profileData.quota ?? 0);
  const normalizedGroups = groupList.map((group) => {
    const id = String(group.id ?? group.group_id ?? group.name);
    const defaultMultiplier = toNumber(group.rate_multiplier ?? group.rateMultiplier ?? 1);
    const effectiveMultiplier = rateByGroupId.get(id) ?? group.rate_multiplier ?? group.rateMultiplier;
    const multiplier = toNumber(effectiveMultiplier ?? defaultMultiplier);

    return {
      id,
      name: String(group.name ?? id),
      platform: normalizeProviderPlatform(group.platform),
      ratePlatform: observeRateHistoryPlatform(group.platform, String(group.name ?? id)),
      subscriptionType: String(group.subscription_type ?? group.subscriptionType ?? '-'),
      multiplier,
      multiplierKnown: isKnownMultiplier(effectiveMultiplier),
      defaultMultiplier,
      quotaCny: 0,
      enabled: normalizeEnabled(group),
      status: normalizeEnabled(group) ? 'enabled' : 'disabled',
      keyCount: keyCountByGroupId.get(id) ?? 0,
      isExclusive: Boolean(group.is_exclusive ?? group.isExclusive ?? false),
      isPeak: Boolean(group.is_peak ?? group.isPeak ?? false),
    };
  });
  const normalizedKeys = keyList.map((key) => ({
    id: String(key.id ?? key.key ?? key.name),
    name: String(key.name ?? '-'),
    key: String(key.key ?? key.token ?? ''),
    groupId: String(key.group_id ?? key.groupId ?? ''),
    quota: toNumber(key.quota ?? 0),
    createdAt: key.created_at ?? key.createdAt ?? null,
  }));
  mergeTokenOnlyGroups(normalizedGroups, normalizedKeys, rateByGroupId, keyCountByGroupId, embeddedGroupById);
  const status = classifyProbe({ ok: true, latencyMs });

  return {
    siteId: site.id,
    balanceAmount: balance,
    balanceCurrency: 'USD',
    balanceCny: balance,
    balanceUsd: balance,
    profile: {
      id: profileData.id ?? profileData.user_id ?? null,
      email: profileData.email ?? '',
      concurrency: profileData.concurrency ?? null,
    },
    token: normalizedKeys[0]?.key ?? '',
    tokens: normalizedKeys,
    groups: normalizedGroups,
    groupsComplete,
    probe: {
      ok: true,
      latencyMs,
      status,
      checkedAt: checkedAtIso,
    },
    refreshedAt: checkedAtIso,
  };
}

export function shouldRefreshSub2ApiAuth({
  site,
  now = new Date(),
  accessTokenRefreshWindowMs = DEFAULT_ACCESS_TOKEN_REFRESH_WINDOW_MS,
  refreshTokenRotationMs = DEFAULT_REFRESH_TOKEN_ROTATION_MS,
} = {}) {
  const nowMs = Number(new Date(now));
  if (!Number.isFinite(nowMs)) return false;

  const authToken = String(site?.authToken ?? site?.auth_token ?? '').trim();
  const refreshToken = String(site?.refreshToken ?? site?.refresh_token ?? '').trim();
  const canRenew = Boolean(refreshToken || (site?.username && site?.password));
  if (!canRenew) return false;

  const accessTokenExpiresAtMs = getJwtExpiresAtMs(authToken);
  if (
    Number.isFinite(accessTokenExpiresAtMs)
    && accessTokenExpiresAtMs - nowMs <= accessTokenRefreshWindowMs
  ) {
    return true;
  }

  const refreshTokenRotatedAt = site?.refreshTokenRotatedAt ?? site?.refresh_token_rotated_at;
  const refreshTokenRotatedAtMs = Number(new Date(refreshTokenRotatedAt));
  return Boolean(
    refreshToken
      && Number.isFinite(refreshTokenRotatedAtMs)
      && nowMs - refreshTokenRotatedAtMs >= refreshTokenRotationMs,
  );
}

export async function fetchSub2ApiSnapshot(site, options = {}) {
  const authToken = String(site.authToken ?? site.auth_token ?? '').trim();
  if (!authToken && !(site.username && site.password) && !(site.refreshToken ?? site.refresh_token)) {
    throw new Error('Sub2API auth token is required');
  }

  return await fetchSnapshotWithFallback(site, options, {
    api: () => fetchSub2ApiSnapshotViaApi(site, options),
    browser: () => fetchSub2ApiSnapshotWithBrowser(site, options),
    shouldFallback: isSub2ApiTransportError,
  });
}

/** HTTP-only entry shared by regular and credential-flow sites; never launches Chromium. */
export async function fetchSub2ApiSnapshotViaApi(site, options = {}) {
  return await withUpstreamApi(site, options, (fetch) => fetchSub2ApiSnapshotDirect(site, { ...options, fetch }));
}

async function fetchSub2ApiSnapshotWithBrowser(site, options = {}) {
  const authToken = String(site.authToken ?? site.auth_token ?? '').trim();
  const refreshToken = String(site.refreshToken ?? site.refresh_token ?? '').trim();

  const browserType = options.browserType ?? chromium;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const now = options.now ?? new Date();
  const rotatedAt = new Date(now).toISOString();
  const shouldRefreshBeforeFetch = shouldRefreshSub2ApiAuth({
    site,
    now,
    accessTokenRefreshWindowMs: options.accessTokenRefreshWindowMs,
    refreshTokenRotationMs: options.refreshTokenRotationMs,
  });
  const startedAt = Date.now();
  return await runBrowserTask({
    siteId: site.id,
    browserType,
    timeoutMs,
    launchTimeoutMs: options.browserLaunchTimeoutMs,
    cleanupTimeoutMs: options.browserCleanupTimeoutMs,
    logger: options.logger ?? console,
    launchOptions: {
      headless: true,
      ...playwrightProxyLaunchOptions(site.proxy),
    },
  }, async (browser) => {
    const context = await browser.newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const page = await context.newPage();
    const authCheckpointName = typeof options.onAuthUpdate === 'function'
      ? `__aumAuth_${randomUUID().replaceAll('-', '')}` : '';
    if (authCheckpointName) {
      await page.exposeBinding(authCheckpointName, async ({ frame }, update) => {
        if (frame !== page.mainFrame() || new URL(frame.url()).origin !== new URL(site.url).origin) {
          throw new Error('Auth checkpoint requires the configured site main frame');
        }
        await options.onAuthUpdate(update);
      });
    }
    await page.goto(new URL('/login', site.url).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    await page.evaluate(({ token, refreshToken: refresh }) => {
      window.localStorage.setItem('auth_token', token);
      if (refresh) window.localStorage.setItem('refresh_token', refresh);
    }, { token: authToken, refreshToken });

    const raw = await page.evaluate(async ({
      token,
      refreshToken: initialRefreshToken,
      username,
      password,
      proactiveRefresh,
      rotatedAt,
      authCheckpointName,
    }) => {
      let currentToken = token;
      let currentRefreshToken = initialRefreshToken;
      let refreshedAuthUpdate = null;
      let refreshPromise = null;

      async function applyAuthUpdate(data, source) {
        const nextToken = data?.access_token;
        if (!nextToken) throw new Error(`${source} did not return access_token`);
        currentToken = nextToken;
        currentRefreshToken = data?.refresh_token ?? currentRefreshToken;
        window.localStorage.setItem('auth_token', currentToken);
        if (currentRefreshToken) window.localStorage.setItem('refresh_token', currentRefreshToken);
        if (data?.expires_in) {
          window.localStorage.setItem('token_expires_at', String(Date.now() + Number(data.expires_in) * 1000));
        }
        refreshedAuthUpdate = {
          authToken: currentToken,
          refreshToken: currentRefreshToken,
          rotatedAt,
        };
        // Commit a successful rotation before any later collection can time out.
        if (authCheckpointName) await window[authCheckpointName](refreshedAuthUpdate);
        return refreshedAuthUpdate;
      }

      async function postJson(path, body) {
        const response = await fetch(path, {
          method: 'POST',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        const text = await response.text();
        let payload;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          throw new Error(`${path} HTTP ${response.status}: ${text.slice(0, 160)}`);
        }
        if (!response.ok) {
          throw new Error(`${path} HTTP ${response.status}: ${payload?.message ?? response.statusText}`);
        }
        return payload?.data ?? payload;
      }

      async function loginAccessToken() {
        if (!username || !password) return null;
        const data = await postJson('/api/v1/auth/login', {
          email: username,
          password,
        });
        if (data?.requires_2fa) throw new Error('/api/v1/auth/login requires 2FA');
        return applyAuthUpdate(data, '/api/v1/auth/login');
      }

      async function renewAccessToken() {
        if (!refreshPromise) {
          refreshPromise = (async () => {
            if (currentRefreshToken) {
              try {
                const data = await postJson('/api/v1/auth/refresh', {
                  refresh_token: currentRefreshToken,
                });
                return applyAuthUpdate(data, '/api/v1/auth/refresh');
              } catch (error) {
                if (!username || !password) throw error;
              }
            }
            const loginUpdate = await loginAccessToken();
            if (loginUpdate) return loginUpdate;
            return null;
          })().finally(() => {
            refreshPromise = null;
          });
        }
        return refreshPromise;
      }

      async function getJson(path, allowRefresh = true) {
        const response = await fetch(path, {
          headers: {
            accept: 'application/json, text/plain, */*',
            authorization: `Bearer ${currentToken}`,
          },
          credentials: 'include',
        });
        const text = await response.text();
        let payload;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          throw new Error(`${path} HTTP ${response.status}: ${text.slice(0, 160)}`);
        }
        if (response.status === 401 && allowRefresh) {
          await renewAccessToken();
          return getJson(path, false);
        }
        if (!response.ok) {
          throw new Error(`${path} HTTP ${response.status}: ${payload?.message ?? response.statusText}`);
        }
        return payload;
      }

      const KEYS_PAGE_SIZE = 200;
      const MAX_KEYS_PAGES = 25;

      function buildKeysPagePath(page) {
        return `/api/v1/keys?page=${page}&page_size=${KEYS_PAGE_SIZE}&sort_by=created_at&sort_order=desc&timezone=Asia%2FShanghai`;
      }

      function unwrapKeysData(payload) {
        if (payload && typeof payload === 'object' && !Array.isArray(payload) && Object.hasOwn(payload, 'data')) {
          return payload.data;
        }
        return payload;
      }

      function keysPageItems(data) {
        if (Array.isArray(data)) return data;
        if (Array.isArray(data?.items)) return data.items;
        if (Array.isArray(data?.keys)) return data.keys;
        if (Array.isArray(data?.list)) return data.list;
        if (Array.isArray(data?.data)) return data.data;
        return [];
      }

      async function fetchAllKeys(firstPayload) {
        const items = [];
        const seen = new Set();
        let payload = firstPayload;
        for (let page = 1; page <= MAX_KEYS_PAGES; page += 1) {
          const data = unwrapKeysData(payload);
          if (!Array.isArray(data) && !['items', 'keys', 'list', 'data'].some((field) => Array.isArray(data?.[field]))) {
            throw new Error('Sub2API keys response has no recognized list');
          }
          const pageItems = keysPageItems(data);
          for (const item of pageItems) {
            const identity = item?.id ?? item?.key ?? item?.name;
            if (identity !== undefined && identity !== null) {
              const marker = String(identity);
              if (seen.has(marker)) continue;
              seen.add(marker);
            }
            items.push(item);
          }
          const total = Number(data?.total ?? data?.total_count);
          const pages = Number(data?.pages ?? data?.total_pages);
          if (pageItems.length === 0) break;
          if (Number.isFinite(total) && items.length >= total) break;
          if (Number.isFinite(pages) && pages >= 1 && page >= pages) break;
          if (pageItems.length < KEYS_PAGE_SIZE) break;
          payload = await getJson(buildKeysPagePath(page + 1));
        }
        return items;
      }

      if (proactiveRefresh) {
        await renewAccessToken();
      }

      const [profile, groups, rates, firstKeysPage] = await Promise.all([
        getJson('/api/v1/user/profile'),
        getJson('/api/v1/groups/available'),
        getJson('/api/v1/groups/rates'),
        getJson(buildKeysPagePath(1)),
      ]);
      const keys = await fetchAllKeys(firstKeysPage);

      return { profile, groups, rates, keys, authUpdate: refreshedAuthUpdate };
    }, {
      token: authToken,
      refreshToken,
      username: String(site.username ?? '').trim(),
      password: String(site.password ?? '').trim(),
      proactiveRefresh: shouldRefreshBeforeFetch,
      rotatedAt,
      authCheckpointName,
    });

    const checkedAt = new Date();
    const { authUpdate, ...payload } = raw;
    const normalizedSnapshot = normalizeSub2ApiSnapshot({
      site,
      ...payload,
      latencyMs: Date.now() - startedAt,
      checkedAt,
    });
    return {
      rawPayload: payload,
      normalizedSnapshot,
      authUpdate,
      fetchedAt: checkedAt,
    };
  });
}

// 直连路径与浏览器路径（fetchSub2ApiSnapshotWithBrowser 内 page.evaluate 的函数）
// 是同一份 Sub2API JSON API 调用逻辑的两个实现；page.evaluate 的函数会被序列化
// 进浏览器，无法引用模块作用域代码，所以这里保留一份 Node 版本，改动时两边要同步。
const SUB2API_KEYS_PAGE_SIZE = 200;
const SUB2API_MAX_KEYS_PAGES = 25;

async function fetchSub2ApiSnapshotDirect(site, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is not available');
  const baseUrl = String(site.url).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 20_000;
  const now = options.now ?? new Date();
  const rotatedAt = new Date(now).toISOString();
  const proactiveRefresh = shouldRefreshSub2ApiAuth({
    site,
    now,
    accessTokenRefreshWindowMs: options.accessTokenRefreshWindowMs,
    refreshTokenRotationMs: options.refreshTokenRotationMs,
  });
  const startedAt = Date.now();

  let currentToken = String(site.authToken ?? site.auth_token ?? '').trim();
  let currentRefreshToken = String(site.refreshToken ?? site.refresh_token ?? '').trim();
  const username = String(site.username ?? '').trim();
  const password = String(site.password ?? '').trim();
  let refreshedAuthUpdate = null;
  let refreshPromise = null;

  function applyAuthUpdate(data, source) {
    const nextToken = data?.access_token;
    if (!nextToken) throw new Error(`${source} did not return access_token`);
    currentToken = nextToken;
    currentRefreshToken = data?.refresh_token ?? currentRefreshToken;
    refreshedAuthUpdate = {
      authToken: currentToken,
      refreshToken: currentRefreshToken,
      rotatedAt,
    };
    return refreshedAuthUpdate;
  }

  async function request(path, init = {}) {
    let response;
    let text;
    try {
      response = await fetchImpl(new URL(path, baseUrl).toString(), {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw markSub2ApiTransportError(new Error(`${path} request failed: ${error.message}`));
    }
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw markSub2ApiTransportError(new Error(nonJsonResponseMessage(path, response)));
    }
    return { response, payload };
  }

  async function postJson(path, body) {
    const { response, payload } = await request(path, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${path} HTTP ${response.status}: ${payload?.message ?? response.statusText}`);
    }
    return payload?.data ?? payload;
  }

  async function loginAccessToken() {
    if (!username || !password) return null;
    const data = await postJson('/api/v1/auth/login', {
      email: username,
      password,
    });
    if (data?.requires_2fa) throw new Error('/api/v1/auth/login requires 2FA');
    return applyAuthUpdate(data, '/api/v1/auth/login');
  }

  async function renewAccessToken() {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        if (currentRefreshToken) {
          try {
            const data = await postJson('/api/v1/auth/refresh', {
              refresh_token: currentRefreshToken,
            });
            return applyAuthUpdate(data, '/api/v1/auth/refresh');
          } catch (error) {
            if (!username || !password) throw error;
          }
        }
        const loginUpdate = await loginAccessToken();
        if (loginUpdate) return loginUpdate;
        return null;
      })().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  async function getJson(path, allowRefresh = true) {
    const { response, payload } = await request(path, {
      headers: {
        accept: 'application/json, text/plain, */*',
        authorization: `Bearer ${currentToken}`,
      },
    });
    if (response.status === 401 && allowRefresh) {
      await renewAccessToken();
      return getJson(path, false);
    }
    if (!response.ok) {
      throw new Error(`${path} HTTP ${response.status}: ${payload?.message ?? response.statusText}`);
    }
    return payload;
  }

  function buildKeysPagePath(page) {
    return `/api/v1/keys?page=${page}&page_size=${SUB2API_KEYS_PAGE_SIZE}&sort_by=created_at&sort_order=desc&timezone=Asia%2FShanghai`;
  }

  function unwrapKeysData(payload) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && Object.hasOwn(payload, 'data')) {
      return payload.data;
    }
    return payload;
  }

  function keysPageItems(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.keys)) return data.keys;
    if (Array.isArray(data?.list)) return data.list;
    if (Array.isArray(data?.data)) return data.data;
    return [];
  }

  async function fetchAllKeys(firstPayload) {
    const items = [];
    const seen = new Set();
    let payload = firstPayload;
    for (let page = 1; page <= SUB2API_MAX_KEYS_PAGES; page += 1) {
      const data = unwrapKeysData(payload);
      if (!Array.isArray(data) && !['items', 'keys', 'list', 'data'].some((field) => Array.isArray(data?.[field]))) {
        throw new Error('Sub2API keys response has no recognized list');
      }
      const pageItems = keysPageItems(data);
      for (const item of pageItems) {
        const identity = item?.id ?? item?.key ?? item?.name;
        if (identity !== undefined && identity !== null) {
          const marker = String(identity);
          if (seen.has(marker)) continue;
          seen.add(marker);
        }
        items.push(item);
      }
      const total = Number(data?.total ?? data?.total_count);
      const pages = Number(data?.pages ?? data?.total_pages);
      if (pageItems.length === 0) break;
      if (Number.isFinite(total) && items.length >= total) break;
      if (Number.isFinite(pages) && pages >= 1 && page >= pages) break;
      if (pageItems.length < SUB2API_KEYS_PAGE_SIZE) break;
      payload = await getJson(buildKeysPagePath(page + 1));
    }
    return items;
  }

  if (proactiveRefresh || !currentToken) {
    await renewAccessToken();
  }

  const [profile, groups, rates, firstKeysPage] = await settleSnapshotRequests([
    getJson('/api/v1/user/profile'),
    getJson('/api/v1/groups/available'),
    getJson('/api/v1/groups/rates'),
    getJson(buildKeysPagePath(1)),
  ]);
  const keys = await fetchAllKeys(firstKeysPage);

  const checkedAt = new Date();
  const normalizedSnapshot = normalizeSub2ApiSnapshot({
    site,
    profile,
    groups,
    rates,
    keys,
    latencyMs: Date.now() - startedAt,
    checkedAt,
  });
  return {
    rawPayload: { profile, groups, rates, keys },
    normalizedSnapshot,
    authUpdate: refreshedAuthUpdate,
    fetchedAt: checkedAt,
  };
}

function markSub2ApiTransportError(error) {
  error.sub2apiTransportBlocked = true;
  return error;
}

function isSub2ApiTransportError(error) {
  return Boolean(error?.sub2apiTransportBlocked);
}

function getJwtExpiresAtMs(token) {
  const payloadPart = String(token ?? '').split('.')[1];
  if (!payloadPart) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function playwrightProxyLaunchOptions(proxy) {
  if (!proxy || proxy.status === 'inactive') return {};
  const protocol = String(proxy.protocol ?? '').trim();
  const host = String(proxy.host ?? '').trim();
  const port = Number(proxy.port);
  if (!protocol || !host || !Number.isInteger(port)) return {};
  const result = {
    proxy: {
      server: `${protocol}://${host}:${port}`,
    },
  };
  if (proxy.username) result.proxy.username = String(proxy.username);
  if (proxy.password) result.proxy.password = String(proxy.password);
  return result;
}

function normalizeKeyList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.keys)) return value.keys;
  if (Array.isArray(value?.list)) return value.list;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.groups)) return value.groups;
  if (Array.isArray(value?.list)) return value.list;
  return [];
}

function buildRateIndex(value) {
  const entries = new Map();
  if (Array.isArray(value)) {
    for (const item of value) {
      const groupId = item.group_id ?? item.groupId ?? item.id;
      if (groupId === undefined || groupId === null) continue;
      entries.set(String(groupId), item.rate_multiplier ?? item.rateMultiplier ?? item.multiplier);
    }
    return entries;
  }

  if (value && typeof value === 'object') {
    for (const [groupId, rate] of Object.entries(value)) {
      const multiplier = typeof rate === 'object'
        ? rate.rate_multiplier ?? rate.rateMultiplier ?? rate.multiplier
        : rate;
      entries.set(String(groupId), multiplier);
    }
  }

  return entries;
}

function countKeysByGroupId(keys) {
  const counts = new Map();
  for (const key of keys) {
    const groupId = key.group_id ?? key.groupId;
    if (groupId === undefined || groupId === null) continue;
    const normalized = String(groupId);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function collectEmbeddedGroups(keys) {
  const embeddedGroupById = new Map();
  for (const key of keys) {
    const group = key?.group;
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    const groupId = String(group.id ?? key.group_id ?? key.groupId ?? '');
    if (!groupId || embeddedGroupById.has(groupId)) continue;
    embeddedGroupById.set(groupId, group);
  }
  return embeddedGroupById;
}

function mergeTokenOnlyGroups(normalizedGroups, normalizedKeys, rateByGroupId, keyCountByGroupId, embeddedGroupById) {
  const knownGroupIds = new Set(normalizedGroups.map((group) => group.id));
  for (const key of normalizedKeys) {
    const groupId = String(key.groupId ?? '');
    if (!groupId || knownGroupIds.has(groupId)) continue;
    knownGroupIds.add(groupId);
    const embedded = embeddedGroupById?.get(groupId) ?? null;
    const defaultMultiplier = toNumber(embedded?.rate_multiplier ?? embedded?.rateMultiplier ?? 1);
    const effectiveMultiplier = rateByGroupId.get(groupId) ?? embedded?.rate_multiplier ?? embedded?.rateMultiplier;
    const multiplier = toNumber(effectiveMultiplier ?? defaultMultiplier);
    normalizedGroups.push({
      id: groupId,
      name: String(embedded?.name ?? `分组 ${groupId}`),
      platform: normalizeProviderPlatform(embedded?.platform),
      ratePlatform: observeRateHistoryPlatform(embedded?.platform, embedded?.name),
      subscriptionType: String(embedded?.subscription_type ?? embedded?.subscriptionType ?? '-'),
      multiplier,
      multiplierKnown: isKnownMultiplier(effectiveMultiplier),
      defaultMultiplier,
      quotaCny: 0,
      enabled: true,
      status: 'enabled',
      keyCount: keyCountByGroupId.get(groupId) ?? 0,
      isExclusive: Boolean(embedded?.is_exclusive ?? embedded?.isExclusive ?? false),
      isPeak: Boolean(embedded?.peak_rate_enabled ?? embedded?.peakRateEnabled ?? false),
    });
  }
}

function normalizeEnabled(group) {
  const status = String(group.status ?? group.state ?? '').toLowerCase();
  if (status === 'disabled' || status === 'off' || status === 'inactive') return false;
  if (typeof group.enabled === 'boolean') return group.enabled;
  if (typeof group.is_enabled === 'boolean') return group.is_enabled;
  return true;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function hasListPayload(value, fields) {
  return Array.isArray(value) || fields.some((field) => Array.isArray(value?.[field]));
}
