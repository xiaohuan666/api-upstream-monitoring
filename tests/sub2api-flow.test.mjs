import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchSub2ApiFlowSnapshot } from '../src/upstreams/sub2api-flow.mjs';

const CAPTCHA_BODY = {
  data: { captcha_id: 'captcha-1', image_data: 'data:image/png;base64,QUJD' },
};

function createFlowHarness({
  validToken = 'good-token',
  loginTokens = { access_token: 'good-token', refresh_token: 'rt-good' },
} = {}) {
  const state = {
    fills: [],
    logins: 0,
    launches: 0,
    apiCalls: [],
    responseHandlers: [],
  };

  const fetchImpl = async (path, options = {}) => {
    if (path.startsWith('https://')) {
      state.apiCalls.push(path);
      path = new URL(path).pathname;
    }
    const authorization = options?.headers?.authorization ?? '';
    if (path === '/api/v1/auth/refresh' && options?.method === 'POST') {
      const body = JSON.parse(options.body);
      if (body.refresh_token === 'rt-old') {
        return jsonResponse(200, { code: 0, data: { access_token: 'good-token', refresh_token: 'rt-new', expires_in: 86400 } });
      }
      return jsonResponse(401, { code: 'INVALID_REFRESH_TOKEN', message: 'invalid refresh token' });
    }
    if (authorization !== `Bearer ${validToken}`) {
      return jsonResponse(401, { code: 'SESSION_BINDING_MISMATCH', message: 'fingerprint changed' });
    }
    if (path === '/api/v1/user/profile') {
      return jsonResponse(200, { code: 0, data: { id: 779, email: 'user@example.com', balance: 62.5 } });
    }
    if (path === '/api/v1/groups/available') {
      return jsonResponse(200, { code: 0, data: [{ id: 2, name: 'BUGTEAM', platform: 'openai', rate_multiplier: 0.06 }] });
    }
    if (path === '/api/v1/groups/rates') {
      return jsonResponse(200, { code: 0, data: {} });
    }
    if (path.startsWith('/api/v1/keys')) {
      return jsonResponse(200, { code: 0, data: { items: [{ id: 1331, name: 'kiro', key: 'sk-live', group_id: 2 }] } });
    }
    return jsonResponse(404, { message: 'not found' });
  };

  const page = {
    currentUrl: 'about:blank',
    url() {
      return page.currentUrl;
    },
    on(event, handler) {
      if (event === 'response') state.responseHandlers.push(handler);
    },
    off(event, handler) {
      if (event === 'response') {
        state.responseHandlers = state.responseHandlers.filter((item) => item !== handler);
      }
    },
    async goto(url) {
      page.currentUrl = url;
      for (const handler of [...state.responseHandlers]) {
        await handler({
          url: () => 'https://xbs.example.com/api/v1/auth/captcha?timezone=Asia%2FShanghai',
          json: async () => CAPTCHA_BODY,
        });
      }
    },
    async waitForTimeout() {},
    locator(selector) {
      return {
        async fill(value) {
          state.fills.push([selector, value]);
        },
        async click() {},
      };
    },
    async waitForResponse() {
      state.logins += 1;
      return {
        status: () => 200,
        json: async () => ({ code: 0, data: loginTokens }),
      };
    },
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

  const browserType = {
    async launch() {
      state.launches += 1;
      return {
        async newContext() {
          return { async newPage() { return page; } };
        },
        async close() {},
      };
    },
  };

  return { state, browserType, fetch: fetchImpl };
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

function flowSite(overrides = {}) {
  return {
    id: 'site-xbs',
    url: 'https://xbs.example.com',
    type: 'sub2api',
    username: 'user@example.com',
    password: 'pw',
    authToken: '',
    refreshToken: '',
    ...overrides,
  };
}

test('flow snapshot uses stored access token without login', async () => {
  const { state, browserType, fetch } = createFlowHarness();
  const result = await fetchSub2ApiFlowSnapshot(flowSite({ authToken: 'good-token' }), {
    browserType,
    fetch,
    ocr: async () => 'AB12',
  });

  assert.equal(state.logins, 0);
  assert.equal(state.launches, 0);
  assert.equal(state.apiCalls.length, 4);
  assert.equal(result.authUpdate, null);
  assert.equal(result.normalizedSnapshot.balanceAmount, 62.5);
  assert.equal(result.normalizedSnapshot.groups.length, 1);
  assert.equal(result.normalizedSnapshot.tokens.length, 1);
});

test('flow snapshot refreshes expired token without captcha login', async () => {
  const { state, browserType, fetch } = createFlowHarness();
  const result = await fetchSub2ApiFlowSnapshot(flowSite({ authToken: 'expired', refreshToken: 'rt-old' }), {
    browserType,
    fetch,
    ocr: async () => 'AB12',
  });

  assert.equal(state.logins, 0);
  assert.equal(state.launches, 0);
  assert.deepEqual(result.authUpdate, {
    authToken: 'good-token',
    refreshToken: 'rt-new',
    rotatedAt: result.authUpdate.rotatedAt,
  });
  assert.equal(result.normalizedSnapshot.groups.length, 1);
});

test('flow snapshot falls back to captcha login when tokens are rejected', async () => {
  const { state, browserType, fetch } = createFlowHarness();
  const ocrCalls = [];
  const result = await fetchSub2ApiFlowSnapshot(flowSite({ authToken: 'bad', refreshToken: 'bad' }), {
    browserType,
    fetch,
    ocr: async (image) => {
      ocrCalls.push(image);
      return 'AB12';
    },
  });

  assert.equal(state.logins, 1);
  assert.equal(state.launches, 1);
  assert.ok(state.apiCalls.some((url) => url.endsWith('/api/v1/auth/login')));
  assert.deepEqual(ocrCalls, ['QUJD']);
  assert.deepEqual(state.fills, [
    ['input[type="email"]', 'user@example.com'],
    ['input[type="password"]', 'pw'],
    ['input[type="text"]', 'AB12'],
  ]);
  assert.deepEqual(result.authUpdate, {
    authToken: 'good-token',
    refreshToken: 'rt-good',
    rotatedAt: result.authUpdate.rotatedAt,
  });
  assert.equal(result.normalizedSnapshot.groups[0].name, 'BUGTEAM');
});

test('flow snapshot requires login credentials', async () => {
  await assert.rejects(
    fetchSub2ApiFlowSnapshot(flowSite({ username: '', password: '' }), {
      browserType: createFlowHarness().browserType,
      ocr: async () => 'AB12',
    }),
    /username and password are required/,
  );
});
