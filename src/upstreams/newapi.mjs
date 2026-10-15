import { observeRateHistoryPlatform } from '../group-rate-metadata.mjs';
import { isKnownMultiplier } from '../group-rate-changes.mjs';
import { chromium } from 'playwright';
import { runBrowserTask } from './browser-task.mjs';

import { classifyProbe, normalizeProviderPlatform } from '../domain.mjs';
import { hasActiveProxy, nonJsonResponseMessage, settleSnapshotRequests, withUpstreamApi } from './api-transport.mjs';
import { fetchSnapshotWithFallback } from './sync-strategy.mjs';

const NEW_API_TOKEN_PAGINATION_PATHS = {
  primary: '/api/token/?p=1&size=200',
  pageSizeFallback: '/api/token/?p=1&page_size=200',
};

export function unwrapNewApiPayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.success === false) {
      throw new Error(payload.message || 'New API request failed');
    }
    if (Object.hasOwn(payload, 'data')) return payload.data;
  }
  return payload;
}

export function normalizeNewApiSnapshot({
  site,
  status,
  profile,
  groups,
  tokens,
  tokenKeys,
  latencyMs,
  checkedAt = new Date(),
}) {
  const statusData = unwrapNewApiPayload(status) ?? {};
  const profileData = unwrapNewApiPayload(profile) ?? {};
  const groupPayload = unwrapNewApiPayload(groups);
  const tokenPayload = unwrapNewApiPayload(tokens);
  const groupMap = groupPayload ?? {};
  const tokenPage = tokenPayload ?? {};
  const groupsComplete = groupPayload !== null && typeof groupPayload === 'object' && !Array.isArray(groupPayload)
    && Object.values(groupPayload).every((value) => ['number', 'string'].includes(typeof value)
      || (value && typeof value === 'object' && Object.hasOwn(value, 'ratio')))
    && (Array.isArray(tokenPayload) || Array.isArray(tokenPayload?.items) || Array.isArray(tokenPayload?.tokens) || Array.isArray(tokenPayload?.data));
  const tokenList = normalizeTokenList(tokenPage);
  const fullKeys = normalizeTokenKeys(unwrapNewApiPayload(tokenKeys));
  const quotaPerUnit = toPositiveNumber(statusData.quota_per_unit, 1);
  const balanceUsd = normalizeQuotaUsdBalance(profileData.quota, quotaPerUnit);
  const displayBalance = normalizeDisplayBalance(profileData.quota, balanceUsd, statusData);
  const checkedAtIso = toIso(checkedAt);
  const normalizedTokens = tokenList.map((token) => {
    const id = String(token.id ?? token.name ?? token.key);
    return {
      id,
      name: String(token.name ?? id),
      key: String(fullKeys.get(id) ?? token.key ?? ''),
      groupId: String(token.group ?? ''),
      quota: toNumber(token.remain_quota ?? token.quota ?? 0),
      createdAt: token.created_time ?? token.createdAt ?? null,
    };
  });
  const normalizedGroups = normalizeNewApiGroups(groupMap, tokenList);
  const statusLabel = classifyProbe({ ok: true, latencyMs });

  return {
    siteId: site.id,
    balanceAmount: displayBalance.amount,
    balanceCurrency: displayBalance.currency,
    balanceCny: balanceUsd * toPositiveNumber(statusData.usd_exchange_rate, 1),
    balanceUsd,
    profile: {
      id: profileData.id ?? null,
      email: profileData.email ?? '',
      username: profileData.username ?? '',
      usedQuota: profileData.used_quota ?? null,
      quotaPerUnit,
    },
    token: normalizedTokens[0]?.key ?? '',
    tokens: normalizedTokens,
    groups: normalizedGroups,
    groupsComplete,
    probe: {
      ok: true,
      latencyMs,
      status: statusLabel,
      checkedAt: checkedAtIso,
    },
    refreshedAt: checkedAtIso,
  };
}

export async function fetchNewApiSnapshot(site, options = {}) {
  const credential = String(site.authToken ?? site.auth_token ?? site.password ?? '').trim();
  const userId = resolveNewApiUserId(site);
  if (!credential) throw new Error('New API cookie is required');
  if (!userId) throw new Error('New API user id is required');

  return await fetchSnapshotWithFallback(site, options, {
    api: () => withUpstreamApi(site, options, (fetch) => fetchNewApiSnapshotDirect(site, { ...options, fetch })),
    browser: () => fetchNewApiSnapshotWithBrowser(site, options),
    shouldFallback: isNewApiTransportError,
  });
}

async function fetchNewApiSnapshotDirect(site, options = {}) {
  const credential = String(site.authToken ?? site.auth_token ?? site.password ?? '').trim();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is not available');
  const baseUrl = String(site.url).replace(/\/+$/, '');
  const refreshToken = String(site.refreshToken ?? site.refresh_token ?? '').trim();

  const rotateAndFetch = async () => {
    const rotated = await refreshNewApiSession({ baseUrl, refreshToken, fetchImpl });
    const result = await fetchNewApiSnapshotWithCredential(site, rotated.credential, fetchImpl);
    result.authUpdate = buildAuthUpdate(rotated);
    return result;
  };

  // Newer new-api versions issue 15-minute JWT access tokens; rotate proactively
  // through the refresh cookie instead of paying a 401 round-trip on every sync.
  if (refreshToken && isJwtExpiringSoon(credential)) {
    try {
      return await rotateAndFetch();
    } catch {
      // fall through to the stored credential and the reactive chain below
    }
  }

  try {
    return await fetchNewApiSnapshotWithCredential(site, credential, fetchImpl);
  } catch (error) {
    if (!isAuthError(error)) throw error;
    if (refreshToken) {
      try {
        return await rotateAndFetch();
      } catch (refreshError) {
        if (!isAuthError(refreshError)) throw refreshError;
        // refresh cookie rejected — fall back to password login below
      }
    }
    const login = await tryNewApiReLogin({ site, baseUrl, options, fetchImpl });
    if (!login) throw error;
    const result = await fetchNewApiSnapshotWithCredential(site, login.credential, fetchImpl);
    result.authUpdate = buildAuthUpdate(login);
    return result;
  }
}

function isJwtCredential(value) {
  return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(String(value ?? '').trim());
}

function isCookieCredential(value) {
  const text = String(value ?? '').trim();
  // '=' appearing only as trailing base64-style padding means this is an
  // opaque token (new-api personal access token), not a cookie string
  return /=[^=]/.test(text);
}

function decodeJwtExpiry(credential) {
  if (!isJwtCredential(credential)) return null;
  try {
    const segment = String(credential).trim().split('.')[1];
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    return Number.isFinite(payload?.exp) ? Number(payload.exp) : null;
  } catch {
    return null;
  }
}

function isJwtExpiringSoon(credential, skewSeconds = 60) {
  const expiresAt = decodeJwtExpiry(credential);
  if (!expiresAt) return false;
  return expiresAt <= Math.floor(Date.now() / 1000) + skewSeconds;
}

function buildAuthUpdate({ credential, refreshToken }) {
  return {
    authToken: credential,
    refreshToken: String(refreshToken ?? '').trim(),
    rotatedAt: new Date().toISOString(),
  };
}

function buildNewApiHeaders(credential, userId) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-store',
    'new-api-user': userId,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0',
  };
  if (isCookieCredential(credential)) headers.cookie = credential;
  else headers.authorization = `Bearer ${credential}`;
  return headers;
}

async function fetchNewApiSnapshotWithCredential(site, credential, fetchImpl) {
  const userId = resolveNewApiUserId(site);
  const startedAt = Date.now();
  const checkedAt = new Date();
  const baseUrl = String(site.url).replace(/\/+$/, '');
  const headers = buildNewApiHeaders(credential, userId);

  async function getJson(path) {
    let response;
    try {
      response = await fetchImpl(new URL(path, baseUrl).toString(), { headers });
    } catch (error) {
      throw markNewApiTransportError(new Error(`${path} request failed: ${error.message}`));
    }
    return await parseJsonResponse(path, response);
  }

  async function postJson(path, body) {
    let response;
    try {
      response = await fetchImpl(new URL(path, baseUrl).toString(), {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw markNewApiTransportError(new Error(`${path} request failed: ${error.message}`));
    }
    return await parseJsonResponse(path, response);
  }

  async function getTokensJson() {
    try {
      return await getJson(NEW_API_TOKEN_PAGINATION_PATHS.primary);
    } catch (error) {
      if (!isUnsupportedTokenSizeError(error)) throw error;
      return await getJson(NEW_API_TOKEN_PAGINATION_PATHS.pageSizeFallback);
    }
  }

  const [status, profile, groups, tokens] = await settleSnapshotRequests([
    getJson('/api/status'),
    getJson('/api/user/self'),
    getJson('/api/user/self/groups'),
    getTokensJson(),
  ]);
  const tokenIds = normalizeTokenList(unwrapNewApiPayload(tokens))
    .map((token) => Number(token.id))
    .filter(Number.isFinite)
    .slice(0, 100);
  const tokenKeys = tokenIds.length > 0
    ? await postJson('/api/token/batch/keys', { ids: tokenIds })
    : { success: true, data: { keys: {} } };

  const rawPayload = { status, profile, groups, tokens, tokenKeys };
  const normalizedSnapshot = normalizeNewApiSnapshot({
    site,
    ...rawPayload,
    latencyMs: Date.now() - startedAt,
    checkedAt,
  });

  return {
    rawPayload,
    normalizedSnapshot,
    fetchedAt: checkedAt,
  };
}

function resolveNewApiUserId(site) {
  return String(site?.newApiUserId ?? site?.new_api_user_id ?? '').trim()
    || String(site?.username ?? '').trim();
}

function isAuthError(error) {
  return /HTTP 401\b/.test(String(error?.message ?? ''));
}

function isUnsupportedTokenSizeError(error) {
  const message = String(error?.message ?? '');
  return /HTTP 400\b/i.test(message)
    && /\bsize\b/i.test(message)
    && /\bpage_size\b/i.test(message);
}

function markNewApiTransportError(error) {
  error.newApiTransportBlocked = true;
  return error;
}

function isNewApiTransportError(error) {
  return Boolean(error?.newApiTransportBlocked);
}

const NEW_API_REFRESH_COOKIE_NAME = 'new_api_refresh';

async function refreshNewApiSession({ baseUrl, refreshToken, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(new URL('/api/user/auth/refresh', baseUrl).toString(), {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        cookie: `${NEW_API_REFRESH_COOKIE_NAME}=${refreshToken}`,
        origin: baseUrl,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0',
      },
    });
  } catch (error) {
    throw markNewApiTransportError(new Error(`/api/user/auth/refresh request failed: ${error.message}`));
  }
  const text = await readNewApiResponseText('/api/user/auth/refresh', response);
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw markNewApiTransportError(new Error(nonJsonResponseMessage('/api/user/auth/refresh', response)));
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(`/api/user/auth/refresh HTTP ${response.status}: ${payload?.message ?? response.statusText}`);
  }
  const accessToken = String(payload?.data?.access_token ?? '').trim();
  if (!accessToken) throw new Error('/api/user/auth/refresh did not return an access token');
  return {
    credential: accessToken,
    // the server rotates the refresh cookie on every refresh; keep the old one
    // only when the response does not carry a replacement
    refreshToken: readResponseCookie(response, NEW_API_REFRESH_COOKIE_NAME) || refreshToken,
  };
}

function readResponseCookie(response, name) {
  const setCookies = typeof response.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers?.get?.('set-cookie')].filter(Boolean);
  const pattern = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`);
  for (const line of setCookies) {
    const match = pattern.exec(String(line));
    if (match) return match[1];
  }
  return '';
}

async function tryNewApiReLogin({ site, baseUrl, options, fetchImpl }) {
  const password = String(site.password ?? '').trim();
  if (!password) return null;
  const candidates = [
    options.loginUsername,
    String(site.username ?? '').trim(),
    options.fallbackLoginUsername,
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  for (const loginName of [...new Set(candidates)]) {
    try {
      return await loginNewApiCredential({ baseUrl, username: loginName, password, fetchImpl });
    } catch (error) {
      if (isNewApiTransportError(error)) throw error;
      // try the next login name candidate
    }
  }
  return null;
}

async function loginNewApiCredential({ baseUrl, username, password, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(new URL('/api/user/login', baseUrl).toString(), {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0',
      },
      body: JSON.stringify({ username, password }),
    });
  } catch (error) {
    throw markNewApiTransportError(new Error(`/api/user/login request failed: ${error.message}`));
  }
  const text = await readNewApiResponseText('/api/user/login', response);
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw markNewApiTransportError(new Error(nonJsonResponseMessage('/api/user/login', response)));
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.message ?? `/api/user/login HTTP ${response.status}`);
  }
  const accessToken = String(payload?.data?.access_token ?? '').trim();
  if (accessToken) {
    return {
      credential: accessToken,
      refreshToken: readResponseCookie(response, NEW_API_REFRESH_COOKIE_NAME),
    };
  }
  const sessionCookie = readResponseCookie(response, 'session');
  if (sessionCookie) return { credential: `session=${sessionCookie}`, refreshToken: '' };
  throw new Error('/api/user/login did not return a session cookie');
}

async function fetchNewApiSnapshotWithBrowser(site, options = {}) {
  const credential = String(site.authToken ?? site.auth_token ?? site.password ?? '').trim();
  const userId = resolveNewApiUserId(site);
  const browserType = options.browserType ?? chromium;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const startedAt = Date.now();
  const checkedAt = new Date();
  const baseUrl = String(site.url).replace(/\/+$/, '');
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
    if (isCookieCredential(credential)) {
      await context.addCookies(parseCookieHeader(credential, baseUrl));
    }
    const page = await context.newPage();
    await page.goto(new URL('/keys', baseUrl).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    const rawPayload = await page.evaluate(async ({
      userId: newApiUser,
      credential: cred,
      isCookie,
      tokenPaginationPaths,
    }) => {
      const commonHeaders = {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-store',
        'new-api-user': newApiUser,
        ...(isCookie ? {} : { authorization: `Bearer ${cred}` }),
      };

      async function readJson(path, init = {}) {
        const response = await fetch(path, {
          credentials: 'include',
          ...init,
          headers: {
            ...commonHeaders,
            ...(init.headers ?? {}),
          },
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
        return payload;
      }

      async function readTokens() {
        try {
          return await readJson(tokenPaginationPaths.primary);
        } catch (error) {
          const message = String(error?.message ?? '');
          const supportsFallback = /HTTP 400\b/i.test(message)
            && /\bsize\b/i.test(message)
            && /\bpage_size\b/i.test(message);
          if (!supportsFallback) throw error;
          return await readJson(tokenPaginationPaths.pageSizeFallback);
        }
      }

      const [status, profile, groups, tokens] = await Promise.all([
        readJson('/api/status'),
        readJson('/api/user/self'),
        readJson('/api/user/self/groups'),
        readTokens(),
      ]);
      const items = Array.isArray(tokens?.data?.items) ? tokens.data.items : [];
      const ids = items.map((token) => Number(token.id)).filter(Number.isFinite).slice(0, 100);
      const tokenKeys = ids.length > 0
        ? await readJson('/api/token/batch/keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
        : { success: true, data: { keys: {} } };
      return { status, profile, groups, tokens, tokenKeys };
    }, {
      userId,
      credential,
      isCookie: isCookieCredential(credential),
      tokenPaginationPaths: NEW_API_TOKEN_PAGINATION_PATHS,
    });

    const normalizedSnapshot = normalizeNewApiSnapshot({
      site,
      ...rawPayload,
      latencyMs: Date.now() - startedAt,
      checkedAt,
    });

    return {
      rawPayload,
      normalizedSnapshot,
      fetchedAt: checkedAt,
    };
  });
}

async function parseJsonResponse(path, response) {
  const text = await readNewApiResponseText(path, response);
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw markNewApiTransportError(new Error(nonJsonResponseMessage(path, response)));
  }
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status}: ${payload?.message ?? response.statusText}`);
  }
  unwrapNewApiPayload(payload);
  return payload;
}

async function readNewApiResponseText(path, response) {
  try {
    return await response.text();
  } catch (error) {
    throw markNewApiTransportError(new Error(`${path} response failed: ${error.message}`));
  }
}

function playwrightProxyLaunchOptions(proxy) {
  if (!hasActiveProxy(proxy)) return {};
  const result = {
    proxy: {
      server: `${proxy.protocol}://${proxy.host}:${Number(proxy.port)}`,
    },
  };
  if (proxy.username) result.proxy.username = String(proxy.username);
  if (proxy.password) result.proxy.password = String(proxy.password);
  return result;
}

function parseCookieHeader(cookieHeader, baseUrl) {
  const url = new URL(baseUrl);
  return String(cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) return null;
      return {
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1).trim(),
        domain: url.hostname,
        path: '/',
        httpOnly: false,
        secure: url.protocol === 'https:',
        sameSite: 'Lax',
      };
    })
    .filter(Boolean);
}

function normalizeTokenList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.tokens)) return value.tokens;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function normalizeTokenKeys(value) {
  const keys = value?.keys ?? value ?? {};
  const entries = new Map();
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return entries;
  for (const [id, key] of Object.entries(keys)) {
    entries.set(String(id), String(key));
  }
  return entries;
}

function countTokensByGroup(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    for (const group of parseTokenGroups(token.group)) {
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
  }
  return counts;
}

function normalizeNewApiGroups(groupMap, tokens) {
  const keyCountByGroup = countTokensByGroup(tokens);
  const normalizedGroups = [];
  const knownGroups = new Set();

  for (const [name, config] of Object.entries(groupMap)) {
    const ratio = typeof config === 'object' && config !== null ? config.ratio : config;
    const desc = typeof config === 'object' && config !== null ? config.desc : '';
    normalizedGroups.push(createNormalizedGroup({
      name,
      description: desc,
      multiplier: toNumberOrDefault(ratio, 1),
      multiplierKnown: isKnownMultiplier(ratio),
      keyCount: keyCountByGroup.get(name) ?? 0,
    }));
    knownGroups.add(name);
  }

  for (const [name, multiplier] of collectTokenOnlyGroups(tokens)) {
    if (knownGroups.has(name)) continue;
    normalizedGroups.push(createNormalizedGroup({
      name,
      description: '',
      multiplier: multiplier ?? 1,
      multiplierKnown: isKnownMultiplier(multiplier),
      keyCount: keyCountByGroup.get(name) ?? 0,
    }));
    knownGroups.add(name);
  }

  return normalizedGroups;
}

function collectTokenOnlyGroups(tokens) {
  const groups = new Map();
  for (const token of tokens) {
    const multiplier = resolveTokenGroupMultiplier(token);
    for (const name of parseTokenGroups(token.group)) {
      if (!groups.has(name)) groups.set(name, multiplier);
      else if (groups.get(name) === null && multiplier !== null) groups.set(name, multiplier);
    }
  }
  return groups;
}

function parseTokenGroups(value) {
  return String(value ?? '')
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean);
}

function resolveTokenGroupMultiplier(token) {
  for (const value of [
    token?.effective_group_ratio,
    token?.base_group_ratio,
    token?.group_ratio,
  ]) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (isKnownMultiplier(value)) return number;
  }
  return null;
}

function createNormalizedGroup({ name, description, multiplier, multiplierKnown, keyCount }) {
  return {
    id: name,
    name,
    platform: normalizeProviderPlatform(inferPlatformFromGroupName(name)),
    ratePlatform: observeRateHistoryPlatform(undefined, name),
    subscriptionType: String(description ?? ''),
    multiplier,
    multiplierKnown,
    defaultMultiplier: multiplier,
    quotaCny: 0,
    enabled: true,
    status: 'enabled',
    keyCount,
    isExclusive: false,
    isPeak: false,
  };
}

function inferPlatformFromGroupName(value) {
  const name = String(value ?? '').toLowerCase();
  if (name.includes('claude') || name.includes('anthropic') || name.includes('kiro') || name.includes('cc')) {
    return 'anthropic';
  }
  if (name.includes('grok')) return 'grok';
  if (name.includes('gemini')) return 'gemini';
  return 'openai';
}

function normalizeQuotaUsdBalance(quota, quotaPerUnit) {
  return toNumber(quota) / quotaPerUnit;
}

function normalizeDisplayBalance(quota, balanceUsd, statusData) {
  const displayType = String(statusData.quota_display_type ?? 'USD').trim().toUpperCase();
  if (displayType === 'TOKENS') {
    return { amount: toNumber(quota), currency: 'TOKENS' };
  }
  if (displayType === 'CNY') {
    return {
      amount: balanceUsd * toPositiveNumber(statusData.usd_exchange_rate, 1),
      currency: 'CNY',
    };
  }
  if (displayType === 'CUSTOM') {
    return {
      amount: balanceUsd * toPositiveNumber(statusData.custom_currency_exchange_rate, 1),
      currency: 'CUSTOM',
    };
  }
  return { amount: balanceUsd, currency: 'USD' };
}

function toPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function toNumberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
