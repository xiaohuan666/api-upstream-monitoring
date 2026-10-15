import { chromium } from 'playwright';
import { runBrowserTask } from './browser-task.mjs';

import { createCaptchaOcr } from './captcha-ocr.mjs';
import { fetchSub2ApiSnapshotViaApi, normalizeSub2ApiSnapshot, playwrightProxyLaunchOptions } from './sub2api.mjs';
import { fetchSnapshotWithFallback } from './sync-strategy.mjs';

const MAX_LOGIN_ATTEMPTS = 3;

export async function fetchSub2ApiFlowSnapshot(site, options = {}) {
  if (!(site.authToken ?? site.auth_token) && !(site.refreshToken ?? site.refresh_token)
    && !(site.username && site.password)) {
    throw new Error('Login username and password are required for credential-flow sub2api');
  }
  return await fetchSnapshotWithFallback(site, options, {
    api: () => fetchSub2ApiSnapshotViaApi(site, options),
    browser: () => fetchSub2ApiFlowSnapshotWithBrowser(site, options),
    // This variant may require a browser-bound session or encrypted login form.
    shouldFallback: () => true,
  });
}

async function fetchSub2ApiFlowSnapshotWithBrowser(site, options = {}) {
  const email = String(site.username ?? '').trim();
  const password = String(site.password ?? '');
  if (!email || !password) {
    throw new Error('Login username and password are required for credential-flow sub2api');
  }

  const browserType = options.browserType ?? chromium;
  const ocr = options.ocr ?? createCaptchaOcr();
  const timeoutMs = options.timeoutMs ?? 30_000;
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

    let accessToken = String(site.authToken ?? site.auth_token ?? '').trim();
    let refreshToken = String(site.refreshToken ?? site.refresh_token ?? '').trim();
    let authUpdate = null;
    let payload = null;

    if (accessToken) {
      payload = await tryFetchData(page, site, accessToken, timeoutMs);
    }
    if (!payload && refreshToken) {
      const rotated = await refreshFlowAccessToken(page, site, refreshToken, timeoutMs).catch(() => null);
      if (rotated) {
        accessToken = rotated.accessToken;
        refreshToken = rotated.refreshToken ?? refreshToken;
        authUpdate = { authToken: accessToken, refreshToken, rotatedAt: new Date().toISOString() };
        await options.onAuthUpdate?.(authUpdate);
        payload = await tryFetchData(page, site, accessToken, timeoutMs);
      }
    }
    if (!payload) {
      const loggedIn = await loginWithCredentialFlow(page, site, { email, password, ocr, timeoutMs });
      accessToken = loggedIn.accessToken;
      refreshToken = loggedIn.refreshToken ?? refreshToken;
      authUpdate = { authToken: accessToken, refreshToken, rotatedAt: new Date().toISOString() };
      await options.onAuthUpdate?.(authUpdate);
      payload = await fetchFlowData(page, site, accessToken, timeoutMs);
    }

    const checkedAt = new Date();
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

async function tryFetchData(page, site, accessToken, timeoutMs) {
  try {
    return await fetchFlowData(page, site, accessToken, timeoutMs);
  } catch (error) {
    if (isAuthRejected(error)) return null;
    throw error;
  }
}

function isAuthRejected(error) {
  return /HTTP 401|SESSION_BINDING_MISMATCH|INVALID_TOKEN/.test(String(error?.message ?? ''));
}

async function ensureOnSite(page, site, timeoutMs) {
  const origin = new URL(String(site.url)).origin;
  if (!page.url().startsWith(origin)) {
    await page.goto(new URL('/login', site.url).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
  }
}

async function fetchFlowData(page, site, accessToken, timeoutMs) {
  await ensureOnSite(page, site, timeoutMs);
  return await page.evaluate(async ({ token }) => {
    async function getJson(path) {
      const response = await fetch(path, {
        headers: {
          accept: 'application/json, text/plain, */*',
          authorization: `Bearer ${token}`,
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
      if (!response.ok) {
        throw new Error(`${path} HTTP ${response.status}: ${payload?.message ?? response.statusText}`);
      }
      return payload;
    }

    const KEYS_PAGE_SIZE = 200;
    const MAX_KEYS_PAGES = 25;

    function keysPagePath(page) {
      return `/api/v1/keys?page=${page}&page_size=${KEYS_PAGE_SIZE}&sort_by=created_at&sort_order=desc&timezone=Asia%2FShanghai`;
    }

    function unwrapData(payload) {
      if (payload && typeof payload === 'object' && !Array.isArray(payload) && Object.hasOwn(payload, 'data')) {
        return payload.data;
      }
      return payload;
    }

    function pageItems(data) {
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
        const data = unwrapData(payload);
        const itemsOnPage = pageItems(data);
        for (const item of itemsOnPage) {
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
        if (itemsOnPage.length === 0) break;
        if (Number.isFinite(total) && items.length >= total) break;
        if (Number.isFinite(pages) && pages >= 1 && page >= pages) break;
        if (itemsOnPage.length < KEYS_PAGE_SIZE) break;
        payload = await getJson(keysPagePath(page + 1));
      }
      return items;
    }

    const [profile, groups, rates, firstKeysPage] = await Promise.all([
      getJson('/api/v1/user/profile'),
      getJson('/api/v1/groups/available'),
      getJson('/api/v1/groups/rates'),
      getJson(keysPagePath(1)),
    ]);
    const keys = await fetchAllKeys(firstKeysPage);
    return { profile, groups, rates, keys };
  }, { token: accessToken });
}

async function refreshFlowAccessToken(page, site, refreshToken, timeoutMs) {
  await ensureOnSite(page, site, timeoutMs);
  const rotated = await page.evaluate(async (refresh) => {
    const response = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ refresh_token: refresh }),
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`/api/v1/auth/refresh HTTP ${response.status}: ${text.slice(0, 160)}`);
    }
    if (!response.ok) {
      throw new Error(`/api/v1/auth/refresh HTTP ${response.status}: ${payload?.message ?? response.statusText}`);
    }
    return payload?.data ?? payload;
  }, refreshToken);
  if (!rotated?.access_token) return null;
  return { accessToken: rotated.access_token, refreshToken: rotated.refresh_token ?? null };
}

async function loginWithCredentialFlow(page, site, { email, password, ocr, timeoutMs }) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt += 1) {
    let captchaPayload = null;
    const onResponse = async (response) => {
      if (response.url().includes('/api/v1/auth/captcha')) {
        try {
          const body = await response.json();
          if (body?.data?.image_data) captchaPayload = body.data;
        } catch {
          // keep waiting for a valid captcha response
        }
      }
    };
    page.on('response', onResponse);
    try {
      await page.goto(new URL('/login', site.url).toString(), {
        waitUntil: 'networkidle',
        timeout: timeoutMs,
      });
      await page.waitForTimeout(1000);
      if (!captchaPayload?.image_data || !captchaPayload?.captcha_id) {
        throw new Error('captcha was not loaded');
      }
      const imageBase64 = String(captchaPayload.image_data).split(',')[1] ?? '';
      const captchaCode = await ocr(imageBase64);
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill(password);
      await page.locator('input[type="text"]').fill(captchaCode);
      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes('/api/v1/auth/login'), { timeout: timeoutMs }),
        page.locator('button[type="submit"]').click(),
      ]);
      const body = await response.json().catch(() => null);
      const data = body?.data ?? null;
      if (data?.access_token) {
        return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null };
      }
      lastError = new Error(body?.message ?? `login HTTP ${response.status()}`);
    } catch (error) {
      lastError = error;
    } finally {
      page.off('response', onResponse);
    }
  }
  throw new Error(`credential-flow login failed after ${MAX_LOGIN_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`);
}
