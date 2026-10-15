import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiRequest } from './helpers/api-request.mjs';

import {
  fetchNewApiSnapshot,
  normalizeNewApiSnapshot,
  unwrapNewApiPayload,
} from '../src/upstreams/newapi.mjs';

test('unwrapNewApiPayload returns data from successful New API responses', () => {
  assert.deepEqual(unwrapNewApiPayload({ success: true, data: { quota: 100 } }), { quota: 100 });
  assert.deepEqual(unwrapNewApiPayload({ data: ['default'] }), ['default']);
});

test('unwrapNewApiPayload throws clear error for failed New API responses', () => {
  assert.throws(
    () => unwrapNewApiPayload({ success: false, message: '无权进行此操作' }),
    /无权进行此操作/,
  );
});

test('normalizeNewApiSnapshot maps profile, groups, tokens, and full keys to dashboard snapshot', () => {
  const checkedAt = new Date('2026-07-04T04:30:00.000Z');

  const snapshot = normalizeNewApiSnapshot({
    site: { id: 'site-new-api' },
    latencyMs: 420,
    checkedAt,
    status: {
      success: true,
      data: {
        quota_per_unit: 500000,
        quota_display_type: 'USD',
      },
    },
    profile: {
      success: true,
      data: {
        id: 164,
        username: 'zz',
        email: 'zz@example.com',
        quota: 2500000,
        used_quota: 100000,
      },
    },
    groups: {
      success: true,
      data: {
        default: { ratio: 1, desc: '默认分组' },
        'Claude-fast': { ratio: 0.4, desc: 'Claude 分组' },
        auto: { ratio: '自动', desc: '自动分组' },
      },
    },
    tokens: {
      success: true,
      data: {
        total: 2,
        items: [
          { id: 165, name: 'main', key: 'sk-mask-1', group: 'default', remain_quota: 1000, status: 1 },
          { id: 173, name: 'claude', key: 'sk-mask-2', group: 'Claude-fast', remain_quota: 2000, status: 2 },
        ],
      },
    },
    tokenKeys: {
      success: true,
      data: {
        keys: {
          165: 'sk-real-main',
          173: 'sk-real-claude',
        },
      },
    },
  });

  assert.equal(snapshot.siteId, 'site-new-api');
  assert.equal(snapshot.balanceAmount, 5);
  assert.equal(snapshot.balanceCurrency, 'USD');
  assert.equal(snapshot.profile.id, 164);
  assert.equal(snapshot.profile.email, 'zz@example.com');
  assert.equal(snapshot.token, 'sk-real-main');
  assert.equal(snapshot.tokens.length, 2);
  assert.equal(snapshot.tokens[0].key, 'sk-real-main');
  assert.equal(snapshot.groups.length, 3);
  assert.deepEqual(snapshot.groups[0], {
    id: 'default',
    name: 'default',
    platform: 'openai',
    ratePlatform: 'unknown',
    subscriptionType: '默认分组',
    multiplier: 1,
    multiplierKnown: true,
    defaultMultiplier: 1,
    quotaCny: 0,
    enabled: true,
    status: 'enabled',
    keyCount: 1,
    isExclusive: false,
    isPeak: false,
  });
  assert.equal(snapshot.groups[1].platform, 'anthropic');
  assert.equal(snapshot.groups[1].keyCount, 1);
  assert.equal(snapshot.groups[2].multiplier, 1);
  assert.equal(snapshot.groups[2].platform, 'openai');
  assert.equal(snapshot.probe.status, 'healthy');
  assert.equal(snapshot.refreshedAt, '2026-07-04T04:30:00.000Z');
});

test('normalizeNewApiSnapshot converts CNY display balance with the upstream exchange rate', () => {
  const snapshot = normalizeNewApiSnapshot({
    site: { id: 'site-new-api' },
    latencyMs: 100,
    checkedAt: new Date('2026-09-17T00:00:00.000Z'),
    status: {
      success: true,
      data: {
        quota_per_unit: 500000,
        quota_display_type: 'CNY',
        usd_exchange_rate: 6.8,
      },
    },
    profile: { success: true, data: { quota: 1632374 } },
    groups: { success: true, data: {} },
    tokens: { success: true, data: { items: [] } },
    tokenKeys: { success: true, data: { keys: {} } },
  });

  assert.equal(snapshot.balanceAmount, 22.2002864);
  assert.equal(snapshot.balanceCurrency, 'CNY');
  assert.equal(snapshot.balanceUsd, 3.264748);
  assert.equal(snapshot.balanceCny, 22.2002864);
});

test('normalizeNewApiSnapshot merges token-only groups without overriding visible group settings', () => {
  const snapshot = normalizeNewApiSnapshot({
    site: { id: 'site-new-api' },
    latencyMs: 100,
    checkedAt: new Date('2026-07-20T00:00:00.000Z'),
    status: { success: true, data: { quota_per_unit: 1 } },
    profile: { success: true, data: { quota: 0 } },
    groups: {
      success: true,
      data: {
        default: { ratio: 1, desc: '用户分组' },
        visible: { ratio: 0.5, desc: '当前可见分组' },
      },
    },
    tokens: {
      success: true,
      data: {
        items: [
          { id: 1, name: 'visible-key', group: 'visible', effective_group_ratio: 0.2 },
          {
            id: 2,
            name: 'bound-key',
            group: 'codex-team-特惠',
            effective_group_ratio: 0.03,
            base_group_ratio: 0.04,
          },
          { id: 3, name: 'legacy-key-without-ratio', group: 'legacy-bound' },
          { id: 4, name: 'legacy-key-with-ratio', group: 'legacy-bound', base_group_ratio: 0.06 },
          { id: 5, name: 'fallback-key', group: 'fallback-bound' },
        ],
      },
    },
    tokenKeys: { success: true, data: { keys: {} } },
  });

  assert.deepEqual(snapshot.groups.map((group) => group.id), [
    'default',
    'visible',
    'codex-team-特惠',
    'legacy-bound',
    'fallback-bound',
  ]);
  assert.deepEqual(
    snapshot.groups.map(({ id, multiplier, keyCount }) => ({ id, multiplier, keyCount })),
    [
      { id: 'default', multiplier: 1, keyCount: 0 },
      { id: 'visible', multiplier: 0.5, keyCount: 1 },
      { id: 'codex-team-特惠', multiplier: 0.03, keyCount: 1 },
      { id: 'legacy-bound', multiplier: 0.06, keyCount: 2 },
      { id: 'fallback-bound', multiplier: 1, keyCount: 1 },
    ],
  );
});

test('normalizeNewApiSnapshot infers grok and gemini platforms from group names', () => {
  const snapshot = normalizeNewApiSnapshot({
    site: { id: 'site-new-api' },
    latencyMs: 100,
    checkedAt: new Date('2026-08-30T00:00:00.000Z'),
    status: { success: true, data: { quota_per_unit: 1 } },
    profile: { success: true, data: { quota: 0 } },
    groups: {
      success: true,
      data: {
        'grok-heavy': { ratio: 0.1, desc: '' },
        'Gemini-Pro 专线': { ratio: 0.2, desc: '' },
        'gpt-plus': { ratio: 0.05, desc: '' },
      },
    },
    tokens: { success: true, data: { items: [] } },
    tokenKeys: { success: true, data: { keys: {} } },
  });

  assert.deepEqual(snapshot.groups.map((group) => [group.id, group.platform]), [
    ['grok-heavy', 'grok'],
    ['Gemini-Pro 专线', 'gemini'],
    ['gpt-plus', 'openai'],
  ]);
});

test('fetchNewApiSnapshot re-logs in with password when the session cookie expired', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/api/user/login')) {
      const body = JSON.parse(options.body);
      assert.equal(body.username, 'user@example.com');
      assert.equal(body.password, 'pw');
      return jsonResponse(200, { success: true, data: { id: 175 } }, { setCookie: 'session=NEWCOOKIE; Path=/; HttpOnly' });
    }
    const cookie = options.headers?.cookie ?? '';
    if (cookie !== 'session=NEWCOOKIE') {
      return jsonResponse(401, { success: false, message: 'Unauthorized, not logged in' });
    }
    assert.equal(options.headers['new-api-user'], '175');
    if (url.includes('/api/status')) return jsonResponse(200, { success: true, data: { quota_per_unit: 1 } });
    if (url.includes('/api/user/self/groups')) return jsonResponse(200, { success: true, data: {} });
    if (url.includes('/api/user/self')) {
      return jsonResponse(200, { success: true, data: { id: 175, username: 'user@example.com', quota: 5 } });
    }
    if (url.includes('/api/token/batch/keys')) return jsonResponse(200, { success: true, data: { keys: {} } });
    if (url.includes('/api/token/')) return jsonResponse(200, { success: true, data: { items: [] } });
    return jsonResponse(404, null);
  };

  const result = await fetchNewApiSnapshot({
    id: 's-1',
    url: 'https://newapi.example.com',
    username: 'user@example.com',
    newApiUserId: '175',
    password: 'pw',
    authToken: 'session=OLD',
  }, { fetch: fetchImpl });

  assert.equal(result.normalizedSnapshot.profile.username, 'user@example.com');
  assert.equal(result.authUpdate.authToken, 'session=NEWCOOKIE');
  assert.equal(result.authUpdate.refreshToken, '');
  const loginNames = calls
    .filter((call) => call.url.endsWith('/api/user/login'))
    .map((call) => JSON.parse(call.options.body).username);
  assert.deepEqual(loginNames, ['user@example.com']);
});

test('fetchNewApiSnapshot falls back to snapshot login username and to legacy username user id', async () => {
  const loginNames = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/user/login')) {
      const body = JSON.parse(options.body);
      loginNames.push(body.username);
      if (body.username !== 'user@example.com') {
        return jsonResponse(200, { success: false, message: 'Username or password is incorrect' });
      }
      return jsonResponse(200, { success: true, data: { id: 175 } }, { setCookie: 'session=NEWCOOKIE; Path=/' });
    }
    const cookie = options.headers?.cookie ?? '';
    if (cookie !== 'session=NEWCOOKIE') {
      return jsonResponse(401, { success: false, message: 'Unauthorized, not logged in' });
    }
    assert.equal(options.headers['new-api-user'], '175');
    if (url.includes('/api/status')) return jsonResponse(200, { success: true, data: { quota_per_unit: 1 } });
    if (url.includes('/api/user/self/groups')) return jsonResponse(200, { success: true, data: {} });
    if (url.includes('/api/user/self')) {
      return jsonResponse(200, { success: true, data: { id: 175, username: 'user@example.com', quota: 5 } });
    }
    if (url.includes('/api/token/batch/keys')) return jsonResponse(200, { success: true, data: { keys: {} } });
    if (url.includes('/api/token/')) return jsonResponse(200, { success: true, data: { items: [] } });
    return jsonResponse(404, null);
  };

  // legacy config: numeric user id still lives in username
  const result = await fetchNewApiSnapshot({
    id: 's-1',
    url: 'https://newapi.example.com',
    username: '175',
    password: 'pw',
    authToken: 'session=OLD',
  }, { fetch: fetchImpl, fallbackLoginUsername: 'user@example.com' });

  assert.equal(result.authUpdate.authToken, 'session=NEWCOOKIE');
  assert.deepEqual(loginNames, ['175', 'user@example.com']);
});

test('fetchNewApiSnapshot surfaces the original 401 when re-login is not possible', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/user/login')) {
      return jsonResponse(200, { success: false, message: 'Username or password is incorrect' });
    }
    return jsonResponse(401, { success: false, message: 'Unauthorized, not logged in' });
  };

  await assert.rejects(
    fetchNewApiSnapshot({
      id: 's-1',
      url: 'https://newapi.example.com',
      username: 'user@example.com',
      newApiUserId: '175',
      password: 'bad-password',
      authToken: 'session=OLD',
    }, { fetch: fetchImpl }),
    /HTTP 401/,
  );
});

function jsonResponse(status, payload, { setCookie = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    headers: {
      getSetCookie() {
        return setCookie ? [setCookie] : [];
      },
      get(name) {
        return name === 'set-cookie' ? setCookie : null;
      },
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test('fetchNewApiSnapshot uses bearer auth for jwt credentials', async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url, headers: options.headers ?? {} });
    if (url.includes('/api/status')) return jsonResponse(200, { success: true, data: { quota_per_unit: 1 } });
    if (url.includes('/api/user/self/groups')) return jsonResponse(200, { success: true, data: {} });
    if (url.includes('/api/user/self')) {
      return jsonResponse(200, { success: true, data: { id: 175, username: 'user@example.com', quota: 9 } });
    }
    if (url.includes('/api/token/')) return jsonResponse(200, { success: true, data: { items: [] } });
    return jsonResponse(404, null);
  };

  const result = await fetchNewApiSnapshot({
    id: 's-1',
    url: 'https://newapi.example.com',
    username: 'user@example.com',
    newApiUserId: '175',
    authToken: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoxNzV9.signature',
  }, { fetch: fetchImpl });

  assert.equal(result.normalizedSnapshot.balanceAmount, 9);
  for (const call of seen) {
    assert.equal(call.headers.authorization, 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoxNzV9.signature');
    assert.equal(call.headers.cookie, undefined);
  }
});

test('fetchNewApiSnapshot re-logs in with jwt login response and retries with bearer', async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/user/login')) {
      return jsonResponse(200, {
        success: true,
        data: { access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJuZXciLCJ0b2tlbiI6In0.new', access_expires_at: 1784963580, token_type: 'Bearer', user: { id: 175 } },
      });
    }
    const authorization = options.headers?.authorization ?? '';
    seen.push({ url, authorization });
    if (authorization !== 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJuZXciLCJ0b2tlbiI6In0.new') {
      return jsonResponse(401, { success: false, message: 'Unauthorized, invalid access token' });
    }
    if (url.includes('/api/status')) return jsonResponse(200, { success: true, data: { quota_per_unit: 1 } });
    if (url.includes('/api/user/self/groups')) return jsonResponse(200, { success: true, data: {} });
    if (url.includes('/api/user/self')) {
      return jsonResponse(200, { success: true, data: { id: 175, username: 'user@example.com', quota: 4 } });
    }
    if (url.includes('/api/token/')) return jsonResponse(200, { success: true, data: { items: [] } });
    return jsonResponse(404, null);
  };

  const result = await fetchNewApiSnapshot({
    id: 's-1',
    url: 'https://newapi.example.com',
    username: 'user@example.com',
    newApiUserId: '175',
    password: 'pw',
    authToken: 'session=OLD',
  }, { fetch: fetchImpl });

  assert.equal(result.authUpdate.authToken, 'eyJhbGciOiJIUzI1NiJ9.eyJuZXciLCJ0b2tlbiI6In0.new');
  assert.equal(result.normalizedSnapshot.profile.username, 'user@example.com');
  assert.ok(seen.some((call) => call.authorization.startsWith('Bearer eyJ')));
});

function makeJwt(exp) {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.c2ln`;
}

function dashboardFetchImpl(authorizeWith, extra = {}) {
  return async (url, options = {}) => {
    if (url.endsWith('/api/user/auth/refresh') && extra.onRefresh) {
      return extra.onRefresh(url, options);
    }
    if (url.endsWith('/api/user/login') && extra.onLogin) {
      return extra.onLogin(url, options);
    }
    const authorization = options.headers?.authorization ?? '';
    if (authorization !== authorizeWith) {
      return jsonResponse(401, { success: false, code: 'AUTH_TOKEN_EXPIRED', message: 'Unauthorized, not logged in and no access token provided' });
    }
    if (url.includes('/api/status')) return jsonResponse(200, { success: true, data: { quota_per_unit: 1 } });
    if (url.includes('/api/user/self/groups')) return jsonResponse(200, { success: true, data: {} });
    if (url.includes('/api/user/self')) {
      return jsonResponse(200, { success: true, data: { id: 175, username: 'user@example.com', quota: 7 } });
    }
    if (url.includes('/api/token/batch/keys')) return jsonResponse(200, { success: true, data: { keys: {} } });
    if (url.includes('/api/token/')) return jsonResponse(200, { success: true, data: { items: [] } });
    return jsonResponse(404, null);
  };
}

test('fetchNewApiSnapshot proactively rotates an expired jwt through the refresh cookie', async () => {
  const expiredJwt = makeJwt(Math.floor(Date.now() / 1000) - 3600);
  const freshJwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
  const calls = [];
  const fetchImpl = dashboardFetchImpl(`Bearer ${freshJwt}`, {
    onRefresh: async (url, options) => {
      calls.push({ url, headers: options.headers });
      return jsonResponse(200, {
        success: true,
        data: { access_token: freshJwt, token_type: 'Bearer', access_expires_at: 0, user: { id: 175 }, session: { sid: 's-1' } },
      }, { setCookie: 'new_api_refresh=REFRESH_NEW; Path=/api/user/auth; HttpOnly' });
    },
  });

  const result = await fetchNewApiSnapshot({
    id: 's-1',
    url: 'https://newapi.example.com',
    username: 'user@example.com',
    newApiUserId: '175',
    authToken: expiredJwt,
    refreshToken: 'REFRESH_OLD',
  }, { fetch: fetchImpl });

  assert.equal(result.normalizedSnapshot.profile.username, 'user@example.com');
  assert.equal(result.authUpdate.authToken, freshJwt);
  assert.equal(result.authUpdate.refreshToken, 'REFRESH_NEW');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.cookie, 'new_api_refresh=REFRESH_OLD');
  assert.equal(calls[0].headers.origin, 'https://newapi.example.com');
});

test('fetchNewApiSnapshot falls back to refresh rotation on 401 and keeps the old refresh cookie when none is returned', async () => {
  const freshJwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
  const calls = [];
  const fetchImpl = dashboardFetchImpl(`Bearer ${freshJwt}`, {
    onRefresh: async (url, options) => {
      calls.push({ url, headers: options.headers });
      return jsonResponse(200, {
        success: true,
        data: { access_token: freshJwt, token_type: 'Bearer', user: { id: 175 }, session: { sid: 's-1' } },
      });
    },
  });

  const result = await fetchNewApiSnapshot({
    id: 's-1',
    url: 'https://newapi.example.com',
    username: 'user@example.com',
    newApiUserId: '175',
    authToken: 'OPAQUE_PAT_TOKEN',
    refreshToken: 'REFRESH_OLD',
  }, { fetch: fetchImpl });

  assert.equal(result.authUpdate.authToken, freshJwt);
  assert.equal(result.authUpdate.refreshToken, 'REFRESH_OLD');
  assert.equal(calls.length, 1);
});

test('fetchNewApiSnapshot falls back to password login when the refresh cookie is rejected', async () => {
  const loginJwt = makeJwt(Math.floor(Date.now() / 1000) + 900);
  const fetchImpl = dashboardFetchImpl(`Bearer ${loginJwt}`, {
    onRefresh: async () => jsonResponse(401, { success: false, code: 'AUTH_UNAUTHORIZED', message: 'Unauthorized' }),
    onLogin: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.username, 'user@example.com');
      assert.equal(body.password, 'pw');
      return jsonResponse(200, {
        success: true,
        data: { access_token: loginJwt, token_type: 'Bearer', user: { id: 175 }, session: { sid: 's-2' } },
      }, { setCookie: 'new_api_refresh=REFRESH_FROM_LOGIN; Path=/api/user/auth; HttpOnly' });
    },
  });

  const result = await fetchNewApiSnapshot({
    id: 's-1',
    url: 'https://newapi.example.com',
    username: 'user@example.com',
    newApiUserId: '175',
    password: 'pw',
    authToken: 'session=OLD',
    refreshToken: 'REFRESH_BAD',
  }, { fetch: fetchImpl });

  assert.equal(result.authUpdate.authToken, loginJwt);
  assert.equal(result.authUpdate.refreshToken, 'REFRESH_FROM_LOGIN');
  assert.equal(result.normalizedSnapshot.profile.username, 'user@example.com');
});

test('fetchNewApiSnapshot surfaces the original 401 when both refresh and password login fail', async () => {
  const fetchImpl = dashboardFetchImpl('Bearer never', {
    onRefresh: async () => jsonResponse(401, { success: false, code: 'AUTH_UNAUTHORIZED', message: 'Unauthorized' }),
    onLogin: async () => jsonResponse(200, { success: false, message: 'Turnstile token 为空' }),
  });

  await assert.rejects(
    fetchNewApiSnapshot({
      id: 's-1',
      url: 'https://newapi.example.com',
      username: 'user@example.com',
      newApiUserId: '175',
      password: 'pw',
      authToken: 'session=OLD',
      refreshToken: 'REFRESH_BAD',
    }, { fetch: fetchImpl }),
    /HTTP 401/,
  );
});

test('fetchNewApiSnapshot sends opaque personal access tokens as bearer credentials', async () => {
  const seen = [];
  const baseImpl = dashboardFetchImpl('Bearer OPAQUE_PAT_TOKEN');
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url, headers: options.headers ?? {} });
    return baseImpl(url, options);
  };

  const result = await fetchNewApiSnapshot({
    id: 's-1',
    url: 'https://newapi.example.com',
    username: 'user@example.com',
    newApiUserId: '175',
    authToken: 'OPAQUE_PAT_TOKEN',
  }, { fetch: fetchImpl });

  assert.equal(result.normalizedSnapshot.balanceAmount, 7);
  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.equal(call.headers.authorization, 'Bearer OPAQUE_PAT_TOKEN');
    assert.equal(call.headers.cookie, undefined);
  }
});

test('fetchNewApiSnapshot treats base64-padded opaque tokens as bearer, not cookie', async () => {
  const seen = [];
  const baseImpl = dashboardFetchImpl('Bearer TeA2aSbNcUdVeWfXgYhZiZjKkLug==');
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url, headers: options.headers ?? {} });
    return baseImpl(url, options);
  };

  const result = await fetchNewApiSnapshot({
    id: 's-1',
    url: 'https://newapi.example.com',
    username: 'user@example.com',
    newApiUserId: '156',
    authToken: 'TeA2aSbNcUdVeWfXgYhZiZjKkLug==',
  }, { fetch: fetchImpl });

  assert.equal(result.normalizedSnapshot.balanceAmount, 7);
  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.equal(call.headers.authorization, 'Bearer TeA2aSbNcUdVeWfXgYhZiZjKkLug==');
    assert.equal(call.headers.cookie, undefined);
  }
});

test('fetchNewApiSnapshot retries token pagination with page_size when size is explicitly unsupported', async () => {
  const tokenPaths = [];
  const baseImpl = dashboardFetchImpl('Bearer OPAQUE_PAT_TOKEN');
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('/api/token/batch/keys')) {
      return jsonResponse(200, { success: true, data: { keys: { 901: 'sk-mixflow' } } });
    }
    if (url.includes('/api/token/')) {
      const path = new URL(url).pathname + new URL(url).search;
      tokenPaths.push(path);
      if (url.includes('size=200') && !url.includes('page_size=200')) {
        return jsonResponse(400, {
          success: false,
          message: 'unsupported pagination parameter "size"; use page_size',
        });
      }
      return jsonResponse(200, {
        success: true,
        data: { items: [{ id: 901, name: 'mixflow', group: 'default' }] },
      });
    }
    return baseImpl(url, options);
  };

  const result = await fetchNewApiSnapshot({
    id: 'mixflow',
    url: 'https://llm.example.test',
    newApiUserId: '225',
    authToken: 'OPAQUE_PAT_TOKEN',
  }, { fetch: fetchImpl });

  assert.deepEqual(tokenPaths, [
    '/api/token/?p=1&size=200',
    '/api/token/?p=1&page_size=200',
  ]);
  assert.equal(result.normalizedSnapshot.tokens[0].key, 'sk-mixflow');
});

test('fetchNewApiSnapshot keeps unrelated token pagination errors instead of retrying', async () => {
  const tokenPaths = [];
  const baseImpl = dashboardFetchImpl('Bearer OPAQUE_PAT_TOKEN');
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('/api/token/')) {
      tokenPaths.push(new URL(url).pathname + new URL(url).search);
      return jsonResponse(400, { success: false, message: 'invalid token filter' });
    }
    return baseImpl(url, options);
  };

  await assert.rejects(
    fetchNewApiSnapshot({
      id: 's-1',
      url: 'https://newapi.example.com',
      newApiUserId: '175',
      authToken: 'OPAQUE_PAT_TOKEN',
    }, { fetch: fetchImpl }),
    /invalid token filter/,
  );
  assert.deepEqual(tokenPaths, ['/api/token/?p=1&size=200']);
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

function createBrowserTypeForEvaluate(fetchImpl, launchCalls = []) {
  return {
    async launch(options = {}) {
      launchCalls.push(options);
      return {
        async newContext() {
          return {
            async addCookies() {},
            async newPage() {
              return {
                async goto() {},
                async evaluate(fn, arg) {
                  const originalFetch = globalThis.fetch;
                  globalThis.fetch = fetchImpl;
                  try {
                    return await fn(arg);
                  } finally {
                    globalThis.fetch = originalFetch;
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

test('fetchNewApiSnapshot retries browser token pagination with page_size when size is unsupported', async () => {
  const tokenPaths = [];
  const baseImpl = dashboardFetchImpl('Bearer OPAQUE_PAT_TOKEN');
  const browserFetch = async (path, options = {}) => {
    if (path.includes('/api/token/batch/keys')) {
      return jsonResponse(200, { success: true, data: { keys: { 901: 'sk-mixflow' } } });
    }
    if (path.includes('/api/token/')) {
      tokenPaths.push(path);
      if (path.includes('size=200') && !path.includes('page_size=200')) {
        return jsonResponse(400, {
          success: false,
          message: 'unsupported pagination parameter "size"; use page_size',
        });
      }
      return jsonResponse(200, {
        success: true,
        data: { items: [{ id: 901, name: 'mixflow', group: 'default' }] },
      });
    }
    return baseImpl(path, options);
  };

  const result = await fetchNewApiSnapshot({
    id: 'mixflow',
    url: 'https://llm.example.test',
    newApiUserId: '225',
    authToken: 'OPAQUE_PAT_TOKEN',
    proxy: { protocol: 'http', host: 'proxy.example.com', port: 8080, status: 'active' },
  }, {
    apiRequest: createApiRequest(cloudflareBlockedFetch),
    browserType: createBrowserTypeForEvaluate(browserFetch),
  });

  assert.deepEqual(tokenPaths, [
    '/api/token/?p=1&size=200',
    '/api/token/?p=1&page_size=200',
  ]);
  assert.equal(result.normalizedSnapshot.tokens[0].key, 'sk-mixflow');
});

test('fetchNewApiSnapshot falls back to browser when direct fetch hits a Cloudflare challenge', async () => {
  const launchCalls = [];
  const browserType = createBrowserTypeForEvaluate(dashboardFetchImpl('Bearer OPAQUE_PAT_TOKEN'), launchCalls);

  const result = await fetchNewApiSnapshot({
    id: 's-1',
    url: 'https://newapi.example.com',
    username: 'user@example.com',
    newApiUserId: '175',
    authToken: 'OPAQUE_PAT_TOKEN',
  }, { fetch: cloudflareBlockedFetch, browserType });

  assert.equal(result.normalizedSnapshot.balanceAmount, 7);
  assert.equal(result.normalizedSnapshot.profile.username, 'user@example.com');
  assert.equal(launchCalls.length, 1);
});

test('fetchNewApiSnapshot does not fall back to browser for clean JSON auth errors', async () => {
  const fetchImpl = dashboardFetchImpl('Bearer never');
  let launches = 0;
  const browserType = {
    async launch() {
      launches += 1;
      throw new Error('browser must not be launched for clean JSON errors');
    },
  };

  await assert.rejects(
    fetchNewApiSnapshot({
      id: 's-1',
      url: 'https://newapi.example.com',
      username: 'user@example.com',
      newApiUserId: '175',
      authToken: 'session=OLD',
    }, { fetch: fetchImpl, browserType }),
    /HTTP 401/,
  );
  assert.equal(launches, 0);
});
