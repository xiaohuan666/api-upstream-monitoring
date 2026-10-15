import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiRequest } from './helpers/api-request.mjs';

import {
  fetchSub2ApiSnapshot,
  normalizeSub2ApiSnapshot,
  shouldRefreshSub2ApiAuth,
  unwrapSub2ApiPayload,
} from '../src/upstreams/sub2api.mjs';

test('unwrapSub2ApiPayload returns nested data from standard Sub2API responses', () => {
  assert.deepEqual(unwrapSub2ApiPayload({ code: 200, data: { balance: 23.7 } }), {
    balance: 23.7,
  });
  assert.deepEqual(unwrapSub2ApiPayload([{ id: 1 }]), [{ id: 1 }]);
});

test('unwrapSub2ApiPayload throws clear error for failed Sub2API responses', () => {
  assert.throws(
    () => unwrapSub2ApiPayload({ code: 400, message: 'turnstile verification failed' }),
    /turnstile verification failed/,
  );
});

test('normalizeSub2ApiSnapshot maps profile, groups, rates, and keys to dashboard snapshot', () => {
  const startedAt = new Date('2026-07-04T01:00:00.000Z');
  const snapshot = normalizeSub2ApiSnapshot(
    {
      site: { id: 'site-1' },
      latencyMs: 312,
      checkedAt: startedAt,
      profile: {
        id: 4344,
        email: 'user@example.test',
        balance: 23.73969433,
        concurrency: 1000,
      },
      groups: [
        {
          id: 11,
          name: 'Example Anthropic',
          platform: 'anthropic',
          subscription_type: 'standard',
          rate_multiplier: 0.9,
          is_exclusive: false,
          is_peak: false,
        },
        {
          id: 22,
          name: 'Example Gemini',
          platform: 'gemini',
          rate_multiplier: 0.06,
        },
      ],
      rates: [
        { group_id: 11, rate_multiplier: 0.9 },
        { group_id: 22, rate_multiplier: 0.06 },
      ],
      keys: [
        {
          id: 7665,
          name: 'example-key',
          key: 'sk-live',
          group_id: 22,
          quota: 0,
          created_at: '2026-06-28T01:06:24.123834+08:00',
        },
      ],
    },
  );

  assert.equal(snapshot.siteId, 'site-1');
  assert.equal(snapshot.balanceAmount, 23.73969433);
  assert.equal(snapshot.balanceCurrency, 'USD');
  assert.equal(snapshot.balanceCny, 23.73969433);
  assert.equal(snapshot.balanceUsd, 23.73969433);
  assert.equal(snapshot.profile.email, 'user@example.test');
  assert.equal(snapshot.token, 'sk-live');
  assert.equal(snapshot.tokens.length, 1);
  assert.equal(snapshot.groups.length, 2);
  assert.deepEqual(snapshot.groups[0], {
    id: '11',
    name: 'Example Anthropic',
    platform: 'anthropic',
    ratePlatform: 'anthropic',
    subscriptionType: 'standard',
    multiplier: 0.9,
    multiplierKnown: true,
    defaultMultiplier: 0.9,
    quotaCny: 0,
    enabled: true,
    status: 'enabled',
    keyCount: 0,
    isExclusive: false,
    isPeak: false,
  });
  assert.equal(snapshot.groups[1].keyCount, 1);
  assert.equal(snapshot.groups[1].platform, 'gemini');
  assert.deepEqual(snapshot.probe, {
    ok: true,
    latencyMs: 312,
    status: 'healthy',
    checkedAt: '2026-07-04T01:00:00.000Z',
  });
  assert.equal(snapshot.refreshedAt, '2026-07-04T01:00:00.000Z');
});

test('fetchSub2ApiSnapshot refreshes expired bearer token and retries requests', async () => {
  const calls = [];
  const browserType = createBrowserTypeForEvaluate(async (path, options) => {
    calls.push({
      path,
      authorization: options?.headers?.authorization,
      body: options?.body,
    });
    if (path === '/api/v1/user/profile' && options?.headers?.authorization === 'Bearer expired-token') {
      return jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'Token has expired' });
    }
    if (path === '/api/v1/auth/refresh') {
      return jsonResponse(200, {
        code: 0,
        data: {
          access_token: 'fresh-token',
          refresh_token: 'rt-fresh',
          expires_in: 86400,
        },
      });
    }
    if (path === '/api/v1/user/profile') {
      return jsonResponse(200, { code: 0, data: { id: 1, email: 'user@example.com', balance: 8.5 } });
    }
    if (path === '/api/v1/groups/available') {
      return jsonResponse(200, { code: 0, data: [{ id: 2, name: 'plus', platform: 'openai', rate_multiplier: 0.1 }] });
    }
    if (path === '/api/v1/groups/rates') {
      return jsonResponse(200, { code: 0, data: {} });
    }
    if (path.startsWith('/api/v1/keys')) {
      return jsonResponse(200, { code: 0, data: { items: [{ id: 3, name: 'key', key: 'sk-live', group_id: 2 }] } });
    }
    return jsonResponse(404, { message: 'not found' });
  });

  const result = await fetchSub2ApiSnapshot({
    id: 'site-1',
    url: 'https://relay.example.com',
    authToken: 'expired-token',
    refreshToken: 'rt-old',
  }, {
    browserType,
    fetch: cloudflareBlockedFetch,
    now: new Date('2026-07-05T01:00:00.000Z'),
    timeoutMs: 1000,
  });

  assert.equal(result.normalizedSnapshot.balanceAmount, 8.5);
  assert.deepEqual(result.authUpdate, {
    authToken: 'fresh-token',
    refreshToken: 'rt-fresh',
    rotatedAt: '2026-07-05T01:00:00.000Z',
  });
  assert.equal(calls.some((call) => call.path === '/api/v1/auth/refresh'), true);
  assert.equal(
    calls.some((call) => call.path === '/api/v1/user/profile' && call.authorization === 'Bearer fresh-token'),
    true,
  );
});

test('fetchSub2ApiSnapshot falls back to password login when refresh token is invalid', async () => {
  const calls = [];
  const browserType = createBrowserTypeForEvaluate(async (path, options) => {
    calls.push({
      path,
      authorization: options?.headers?.authorization,
      body: options?.body,
    });
    if (path === '/api/v1/user/profile' && options?.headers?.authorization === 'Bearer expired-token') {
      return jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'Token has expired' });
    }
    if (path === '/api/v1/auth/refresh') {
      return jsonResponse(401, { code: 'INVALID_REFRESH_TOKEN', message: 'invalid refresh token' });
    }
    if (path === '/api/v1/auth/login') {
      return jsonResponse(200, {
        code: 0,
        data: {
          access_token: 'login-access-token',
          refresh_token: 'login-refresh-token',
          expires_in: 86400,
          user: { id: 9, email: 'user@example.com' },
        },
      });
    }
    if (path === '/api/v1/user/profile') {
      return jsonResponse(200, { code: 0, data: { id: 9, email: 'user@example.com', balance: 18.25 } });
    }
    if (path === '/api/v1/groups/available') {
      return jsonResponse(200, { code: 0, data: [{ id: 7, name: 'fallback', platform: 'anthropic', rate_multiplier: 0.9 }] });
    }
    if (path === '/api/v1/groups/rates') {
      return jsonResponse(200, { code: 0, data: [{ group_id: 7, rate_multiplier: 0.9 }] });
    }
    if (path.startsWith('/api/v1/keys')) {
      return jsonResponse(200, { code: 0, data: { items: [{ id: 8, name: 'key', key: 'sk-fallback', group_id: 7 }] } });
    }
    return jsonResponse(404, { message: 'not found' });
  });

  const result = await fetchSub2ApiSnapshot({
    id: 'site-1',
    url: 'https://relay.example.com',
    username: 'user@example.com',
    password: 'plain-password',
    authToken: 'expired-token',
    refreshToken: 'rt-expired',
  }, {
    browserType,
    fetch: cloudflareBlockedFetch,
    now: new Date('2026-07-05T01:00:00.000Z'),
    timeoutMs: 1000,
  });

  assert.equal(result.normalizedSnapshot.balanceAmount, 18.25);
  assert.deepEqual(result.authUpdate, {
    authToken: 'login-access-token',
    refreshToken: 'login-refresh-token',
    rotatedAt: '2026-07-05T01:00:00.000Z',
  });
  assert.equal(
    calls.some((call) => call.path === '/api/v1/auth/login' && call.body.includes('"email":"user@example.com"')),
    true,
  );
  assert.equal(
    calls.some((call) => call.path === '/api/v1/user/profile' && call.authorization === 'Bearer login-access-token'),
    true,
  );
});

test('shouldRefreshSub2ApiAuth requests refresh when access token is near expiry or refresh token is older than one day', () => {
  const now = new Date('2026-07-05T00:00:00.000Z');

  assert.equal(shouldRefreshSub2ApiAuth({
    site: {
      authToken: createJwtExpiringAt('2026-07-05T05:59:00.000Z'),
      refreshToken: 'rt-current',
      refreshTokenRotatedAt: '2026-07-04T23:00:00.000Z',
    },
    now,
  }), true);

  assert.equal(shouldRefreshSub2ApiAuth({
    site: {
      authToken: createJwtExpiringAt('2026-07-06T00:00:00.000Z'),
      refreshToken: 'rt-old',
      refreshTokenRotatedAt: '2026-07-03T23:59:59.000Z',
    },
    now,
  }), true);

  assert.equal(shouldRefreshSub2ApiAuth({
    site: {
      authToken: createJwtExpiringAt('2026-07-06T00:00:00.000Z'),
      refreshToken: 'rt-current',
      refreshTokenRotatedAt: '2026-07-04T23:30:00.000Z',
    },
    now,
  }), false);
});

test('fetchSub2ApiSnapshot proactively rotates refresh token before reading upstream data', async () => {
  const calls = [];
  const browserType = createBrowserTypeForEvaluate(async (path, options) => {
    calls.push({
      path,
      authorization: options?.headers?.authorization,
      body: options?.body,
    });
    if (path === '/api/v1/auth/refresh') {
      return jsonResponse(200, {
        code: 0,
        data: {
          access_token: 'proactive-token',
          refresh_token: 'rt-proactive',
          expires_in: 86400,
        },
      });
    }
    if (path === '/api/v1/user/profile') {
      return jsonResponse(200, { code: 0, data: { id: 1, email: 'user@example.com', balance: 12.5 } });
    }
    if (path === '/api/v1/groups/available') {
      return jsonResponse(200, { code: 0, data: [] });
    }
    if (path === '/api/v1/groups/rates') {
      return jsonResponse(200, { code: 0, data: {} });
    }
    if (path.startsWith('/api/v1/keys')) {
      return jsonResponse(200, { code: 0, data: { items: [] } });
    }
    return jsonResponse(404, { message: 'not found' });
  });

  const result = await fetchSub2ApiSnapshot({
    id: 'site-1',
    url: 'https://relay.example.com',
    authToken: createJwtExpiringAt('2026-07-06T00:00:00.000Z'),
    refreshToken: 'rt-old',
    refreshTokenRotatedAt: '2026-07-03T23:59:59.000Z',
  }, {
    browserType,
    fetch: cloudflareBlockedFetch,
    now: new Date('2026-07-05T00:00:00.000Z'),
    timeoutMs: 1000,
  });

  assert.deepEqual(result.authUpdate, {
    authToken: 'proactive-token',
    refreshToken: 'rt-proactive',
    rotatedAt: '2026-07-05T00:00:00.000Z',
  });
  assert.equal(calls[0].path, '/api/v1/auth/refresh');
  assert.equal(
    calls.some((call) => call.path === '/api/v1/user/profile' && call.authorization === 'Bearer proactive-token'),
    true,
  );
});

test('fetchSub2ApiSnapshot retains the proxy when API failure requires browser fallback', async () => {
  const launchCalls = [];
  const browserType = createBrowserTypeForEvaluate(async (path) => {
    if (path === '/api/v1/user/profile') {
      return jsonResponse(200, { code: 0, data: { id: 1, email: 'user@example.com', balance: 8.5 } });
    }
    if (path === '/api/v1/groups/available') {
      return jsonResponse(200, { code: 0, data: [] });
    }
    if (path === '/api/v1/groups/rates') {
      return jsonResponse(200, { code: 0, data: {} });
    }
    if (path.startsWith('/api/v1/keys')) {
      return jsonResponse(200, { code: 0, data: { items: [] } });
    }
    return jsonResponse(404, { message: 'not found' });
  }, launchCalls);

  await fetchSub2ApiSnapshot({
    id: 'site-1',
    url: 'https://relay.example.com',
    authToken: 'token',
    proxy: {
      protocol: 'http',
      host: 'host.docker.internal',
      port: 17896,
      username: 'proxy-user',
      password: 'proxy-pass',
    },
  }, {
    browserType,
    apiRequest: createApiRequest(cloudflareBlockedFetch),
    timeoutMs: 1000,
  });

  assert.deepEqual(launchCalls[0].proxy, {
    server: 'http://host.docker.internal:17896',
    username: 'proxy-user',
    password: 'proxy-pass',
  });
});

test('fetchSub2ApiSnapshot paginates through all key pages', async () => {
  const firstPageKeys = Array.from({ length: 200 }, (_, index) => ({
    id: index + 1,
    name: `key-${index + 1}`,
    key: `sk-${index + 1}`,
    group_id: 2,
  }));
  const calls = [];
  const browserType = createBrowserTypeForEvaluate(async (path) => {
    calls.push(path);
    if (path === '/api/v1/user/profile') {
      return jsonResponse(200, { code: 0, data: { id: 1, email: 'user@example.com', balance: 8.5 } });
    }
    if (path === '/api/v1/groups/available') {
      return jsonResponse(200, { code: 0, data: [{ id: 2, name: 'plus', platform: 'openai', rate_multiplier: 0.1 }] });
    }
    if (path === '/api/v1/groups/rates') {
      return jsonResponse(200, { code: 0, data: {} });
    }
    if (path.startsWith('/api/v1/keys') && path.includes('page=1&')) {
      return jsonResponse(200, {
        code: 0,
        data: { items: firstPageKeys, total: 201, page: 1, page_size: 200, pages: 2 },
      });
    }
    if (path.startsWith('/api/v1/keys') && path.includes('page=2&')) {
      return jsonResponse(200, {
        code: 0,
        data: {
          items: [{ id: 201, name: 'key-201', key: 'sk-201', group_id: 2 }],
          total: 201,
          page: 2,
          page_size: 200,
          pages: 2,
        },
      });
    }
    return jsonResponse(404, { message: 'not found' });
  });

  const result = await fetchSub2ApiSnapshot({
    id: 'site-1',
    url: 'https://relay.example.com',
    authToken: 'token',
  }, {
    browserType,
    fetch: cloudflareBlockedFetch,
    timeoutMs: 1000,
  });

  assert.equal(result.normalizedSnapshot.tokens.length, 201);
  assert.equal(result.normalizedSnapshot.groups[0].keyCount, 201);
  assert.equal(calls.filter((path) => path.startsWith('/api/v1/keys')).length, 2);
});

function createBrowserTypeForEvaluate(fetchImpl, launchCalls = []) {
  return {
    async launch(options = {}) {
      launchCalls.push(options);
      return {
        async newContext() {
          return {
            async newPage() {
              return {
                async goto() {},
                async evaluate(fn, arg) {
                  const originalFetch = globalThis.fetch;
                  const originalWindow = globalThis.window;
                  const store = new Map();
                  globalThis.fetch = fetchImpl;
                  globalThis.window = {
                    localStorage: {
                      setItem(key, value) {
                        store.set(key, String(value));
                      },
                      getItem(key) {
                        return store.get(key) ?? null;
                      },
                    },
                  };
                  try {
                    return await fn(arg);
                  } finally {
                    globalThis.fetch = originalFetch;
                    globalThis.window = originalWindow;
                  }
                },
              };
            },
          };
        },
        async close() {},
      };
    },
  };
}

function createJwtExpiringAt(isoDate) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(new Date(isoDate).getTime() / 1000) })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test('normalizeSub2ApiSnapshot keeps groups that only appear in key bindings', () => {
  const snapshot = normalizeSub2ApiSnapshot({
    site: { id: 'site-1' },
    latencyMs: 100,
    checkedAt: new Date('2026-07-24T00:00:00.000Z'),
    profile: { balance: 1 },
    groups: [
      { id: 44, name: 'ChatGPT-Plus【高并发-特惠通道】', platform: 'openai', rate_multiplier: 0.05 },
    ],
    rates: { data: {} },
    keys: [
      {
        id: 17811,
        name: '008',
        key: 'sk-a',
        group_id: 37,
        group: {
          id: 37,
          name: 'ChatGPT-Pro【高并发-稳定通道】',
          platform: 'openai',
          rate_multiplier: 0.08,
          is_exclusive: true,
          subscription_type: 'standard',
        },
      },
      { id: 14526, name: 'plus', key: 'sk-b', group_id: 44 },
      { id: 14527, name: 'legacy', key: 'sk-c', group_id: 51 },
    ],
  });

  assert.equal(snapshot.groups.length, 3);
  const tokenOnly = snapshot.groups.find((group) => group.id === '37');
  assert.equal(tokenOnly.keyCount, 1);
  assert.equal(tokenOnly.name, 'ChatGPT-Pro【高并发-稳定通道】');
  assert.equal(tokenOnly.multiplier, 0.08);
  assert.equal(tokenOnly.isExclusive, true);
  assert.equal(snapshot.groups.find((group) => group.id === '44').keyCount, 1);

  const withoutEmbedded = snapshot.groups.find((group) => group.id === '51');
  assert.equal(withoutEmbedded.name, '分组 51');
  assert.equal(withoutEmbedded.multiplier, 1);
  assert.equal(withoutEmbedded.keyCount, 1);
});

async function cloudflareBlockedFetch() {
  return {
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    async text() {
      return '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>cf-challenge</body></html>';
    },
  };
}

test('fetchSub2ApiSnapshot uses direct bearer fetch without launching a browser', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.authorization });
    if (url.includes('/api/v1/user/profile')) {
      return jsonResponse(200, { code: 0, data: { id: 1, email: 'user@example.com', balance: 6.5 } });
    }
    if (url.includes('/api/v1/groups/available')) {
      return jsonResponse(200, { code: 0, data: [{ id: 2, name: 'plus', platform: 'openai', rate_multiplier: 0.1 }] });
    }
    if (url.includes('/api/v1/groups/rates')) {
      return jsonResponse(200, { code: 0, data: {} });
    }
    if (url.includes('/api/v1/keys')) {
      return jsonResponse(200, { code: 0, data: { items: [{ id: 3, name: 'key', key: 'sk-live', group_id: 2 }] } });
    }
    return jsonResponse(404, { message: 'not found' });
  };
  const browserType = {
    async launch() {
      throw new Error('browser must not be launched for direct-capable sites');
    },
  };

  const result = await fetchSub2ApiSnapshot({
    id: 'site-1',
    url: 'https://relay.example.com',
    authToken: 'token',
  }, { fetch: fetchImpl, browserType, timeoutMs: 1000 });

  assert.equal(result.normalizedSnapshot.balanceAmount, 6.5);
  assert.equal(result.normalizedSnapshot.tokens.length, 1);
  assert.equal(result.normalizedSnapshot.groups[0].keyCount, 1);
  assert.equal(result.authUpdate, null);
  assert.equal(calls.length > 0, true);
  assert.equal(calls.every((call) => call.url.startsWith('https://relay.example.com/')), true);
  assert.equal(calls.every((call) => call.authorization === 'Bearer token'), true);
});

test('fetchSub2ApiSnapshot direct path renews an expired token without a browser', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.authorization });
    if (url.includes('/api/v1/auth/refresh')) {
      return jsonResponse(200, {
        code: 0,
        data: { access_token: 'fresh-token', refresh_token: 'rt-fresh', expires_in: 86400 },
      });
    }
    if (options.headers?.authorization !== 'Bearer fresh-token') {
      return jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'Token has expired' });
    }
    if (url.includes('/api/v1/user/profile')) {
      return jsonResponse(200, { code: 0, data: { id: 1, email: 'user@example.com', balance: 8.5 } });
    }
    if (url.includes('/api/v1/groups/available')) return jsonResponse(200, { code: 0, data: [] });
    if (url.includes('/api/v1/groups/rates')) return jsonResponse(200, { code: 0, data: {} });
    if (url.includes('/api/v1/keys')) return jsonResponse(200, { code: 0, data: { items: [] } });
    return jsonResponse(404, { message: 'not found' });
  };
  const browserType = {
    async launch() {
      throw new Error('browser must not be launched for direct-capable sites');
    },
  };

  const result = await fetchSub2ApiSnapshot({
    id: 'site-1',
    url: 'https://relay.example.com',
    authToken: 'expired-token',
    refreshToken: 'rt-old',
  }, { fetch: fetchImpl, browserType, now: new Date('2026-07-05T01:00:00.000Z'), timeoutMs: 1000 });

  assert.equal(result.normalizedSnapshot.balanceAmount, 8.5);
  assert.deepEqual(result.authUpdate, {
    authToken: 'fresh-token',
    refreshToken: 'rt-fresh',
    rotatedAt: '2026-07-05T01:00:00.000Z',
  });
  assert.equal(calls.some((call) => call.url.includes('/api/v1/auth/refresh')), true);
  assert.equal(
    calls.some((call) => call.url.includes('/api/v1/user/profile') && call.authorization === 'Bearer fresh-token'),
    true,
  );
});

test('fetchSub2ApiSnapshot does not fall back to browser for clean JSON auth errors', async () => {
  const fetchImpl = async () => jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'Token has expired' });
  let launches = 0;
  const browserType = {
    async launch() {
      launches += 1;
      throw new Error('browser must not be launched for clean JSON errors');
    },
  };

  await assert.rejects(
    fetchSub2ApiSnapshot({
      id: 'site-1',
      url: 'https://relay.example.com',
      authToken: 'dead-token',
    }, { fetch: fetchImpl, browserType, timeoutMs: 1000 }),
    /HTTP 401/,
  );
  assert.equal(launches, 0);
});

test('fetchSub2ApiSnapshot falls back to browser when direct fetch hits a Cloudflare challenge', async () => {
  const launchCalls = [];
  const browserType = createBrowserTypeForEvaluate(async (path) => {
    if (path === '/api/v1/user/profile') {
      return jsonResponse(200, { code: 0, data: { id: 1, email: 'user@example.com', balance: 3.25 } });
    }
    if (path === '/api/v1/groups/available') return jsonResponse(200, { code: 0, data: [] });
    if (path === '/api/v1/groups/rates') return jsonResponse(200, { code: 0, data: {} });
    if (path.startsWith('/api/v1/keys')) return jsonResponse(200, { code: 0, data: { items: [] } });
    return jsonResponse(404, { message: 'not found' });
  }, launchCalls);

  const result = await fetchSub2ApiSnapshot({
    id: 'site-1',
    url: 'https://relay.example.com',
    authToken: 'token',
  }, { fetch: cloudflareBlockedFetch, browserType, timeoutMs: 1000 });

  assert.equal(result.normalizedSnapshot.balanceAmount, 3.25);
  assert.equal(launchCalls.length, 1);
});

test('fetchSub2ApiSnapshot falls back to browser when the direct response body stalls', async () => {
  const launchCalls = [];
  const stallingFetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {
      throw new Error('The operation was aborted due to timeout');
    },
  });
  const browserType = createBrowserTypeForEvaluate(async (path) => {
    if (path === '/api/v1/user/profile') {
      return jsonResponse(200, { code: 0, data: { id: 1, email: 'user@example.com', balance: 3.25 } });
    }
    if (path === '/api/v1/groups/available') return jsonResponse(200, { code: 0, data: [] });
    if (path === '/api/v1/groups/rates') return jsonResponse(200, { code: 0, data: {} });
    if (path.startsWith('/api/v1/keys')) return jsonResponse(200, { code: 0, data: { items: [] } });
    return jsonResponse(404, { message: 'not found' });
  }, launchCalls);

  const result = await fetchSub2ApiSnapshot({
    id: 'site-1',
    url: 'https://relay.example.com',
    authToken: 'token',
  }, { fetch: stallingFetch, browserType, timeoutMs: 1000 });

  assert.equal(result.normalizedSnapshot.balanceAmount, 3.25);
  assert.equal(launchCalls.length, 1);
});
