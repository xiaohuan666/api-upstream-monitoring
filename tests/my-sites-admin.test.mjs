import test from 'node:test';
import assert from 'node:assert/strict';

import { MySiteAdminApiError, createSub2ApiAdminClient } from '../src/my-sites-admin.mjs';

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

test('admin client lists groups with x-api-key header and normalizes shape', async () => {
  const calls = [];
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'admin-key-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, {
        code: 0,
        data: [
          { id: 7, name: 'gpt-plus', platform: 'openai', rate_multiplier: 0.09, status: 'active' },
          { id: 8, name: 'claude', platform: 'anthropic', rate_multiplier: 0.35 },
          { id: 28, name: 'X.grok', platform: 'grok', rate_multiplier: 0.15 },
        ],
      });
    },
  });

  const groups = await client.listGroups();

  assert.equal(calls[0].url, 'https://sub.example.com/api/v1/admin/groups/all');
  assert.equal(calls[0].options.headers['x-api-key'], 'admin-key-1');
  assert.deepEqual(groups, [
    { id: '7', name: 'gpt-plus', platform: 'openai', rateMultiplier: 0.09, status: 'active' },
    { id: '8', name: 'claude', platform: 'anthropic', rateMultiplier: 0.35, status: 'active' },
    { id: '28', name: 'X.grok', platform: 'grok', rateMultiplier: 0.15, status: 'active' },
  ]);
});

test('admin client creates account with idempotency key and credentials', async () => {
  const calls = [];
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'admin-key-1',
    createIdempotencyKey: () => 'idem-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { code: 0, data: { id: 42, name: '上游站 · gpt-plus' } });
    },
  });

  const account = await client.createAccount({
    name: '上游站 · gpt-plus',
    platform: 'OpenAI',
    apiKey: 'sk-upstream-key',
    baseUrl: 'https://upstream.example.com',
    groupId: '7',
    rateMultiplier: 0.05,
  });

  assert.deepEqual(account, { id: '42', name: '上游站 · gpt-plus' });
  assert.equal(calls[0].url, 'https://sub.example.com/api/v1/admin/accounts');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['idempotency-key'], 'idem-1');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    name: '上游站 · gpt-plus',
    platform: 'openai',
    type: 'apikey',
    credentials: {
      api_key: 'sk-upstream-key',
      base_url: 'https://upstream.example.com',
      pool_mode: true,
      pool_mode_retry_count: 3,
    },
    group_ids: [7],
    priority: 1,
    concurrency: 1000,
    rate_multiplier: 0.05,
  });
});

test('admin client keeps grok platform instead of normalizing to openai', async () => {
  const calls = [];
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'admin-key-1',
    createIdempotencyKey: () => 'idem-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { code: 0, data: { id: 61 } });
    },
  });

  await client.createAccount({ name: 'g', platform: 'grok', apiKey: 'sk', groupId: 28 });
  await client.createAccount({ name: 'g2', platform: 'Gemini', apiKey: 'sk', groupId: 31 });

  assert.equal(JSON.parse(calls[0].options.body).platform, 'grok');
  assert.equal(JSON.parse(calls[1].options.body).platform, 'gemini');
});

test('admin client sends pool mode toggle and responses mode options', async () => {
  const calls = [];
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'admin-key-1',
    createIdempotencyKey: () => 'idem-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { code: 0, data: { id: 43 } });
    },
  });

  await client.createAccount({
    name: 'a',
    platform: 'openai',
    apiKey: 'sk',
    groupId: 7,
    poolMode: false,
    responsesMode: 'force_responses',
  });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.credentials, { api_key: 'sk', pool_mode: false });
  assert.deepEqual(body.extra, { openai_responses_mode: 'force_responses' });

  await client.createAccount({
    name: 'b',
    platform: 'openai',
    apiKey: 'sk',
    groupId: 7,
    poolModeRetryCount: 99,
  });
  const retryClamped = JSON.parse(calls[1].options.body);
  assert.equal(retryClamped.credentials.pool_mode_retry_count, 10);
  assert.equal(retryClamped.extra, undefined);

  await assert.rejects(
    () => client.createAccount({ name: 'c', platform: 'openai', apiKey: 'sk', groupId: 7, responsesMode: 'bogus' }),
    MySiteAdminApiError,
  );
});

test('admin client gets account and normalizes shape', async () => {
  const calls = [];
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'admin-key-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { code: 0, data: { id: 42, name: '上游站 · gpt-plus', rate_multiplier: 0.05, schedulable: true, priority: 3, status: 'active' } });
    },
  });

  const account = await client.getAccount('42');

  assert.equal(calls[0].url, 'https://sub.example.com/api/v1/admin/accounts/42');
  assert.deepEqual(account, {
    id: '42',
    name: '上游站 · gpt-plus',
    rateMultiplier: 0.05,
    schedulable: true,
    priority: 3,
    status: 'active',
    groupIds: null,
  });
});

test('admin client surfaces 404 http status when account is gone', async () => {
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'admin-key-1',
    fetchImpl: async () => jsonResponse(404, { message: 'account not found' }),
  });

  const error = await client.getAccount('42').catch((err) => err);
  assert.ok(error instanceof MySiteAdminApiError);
  assert.equal(error.httpStatus, 404);
});

test('admin client updates account name and rate multiplier', async () => {
  const calls = [];
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'admin-key-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { code: 0, data: { id: 42 } });
    },
  });

  await client.updateAccount('42', { name: '上游站 · 狂欢004', rateMultiplier: 0.06 });
  assert.equal(calls[0].url, 'https://sub.example.com/api/v1/admin/accounts/42');
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: '上游站 · 狂欢004', rate_multiplier: 0.06 });

  await client.updateAccount('42', { name: '上游站 · 狂欢005' });
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: '上游站 · 狂欢005' });

  await client.updateAccount('42', { priority: 5 });
  assert.deepEqual(JSON.parse(calls[2].options.body), { priority: 5 });
});

test('admin client toggles schedulable via dedicated endpoint', async () => {
  const calls = [];
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'admin-key-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { code: 0, data: { id: 42, schedulable: false } });
    },
  });

  await client.setSchedulable('42', false);
  assert.equal(calls[0].url, 'https://sub.example.com/api/v1/admin/accounts/42/schedulable');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { schedulable: false });
});

test('admin client rejects invalid updates before calling remote', async () => {
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'admin-key-1',
    fetchImpl: async () => jsonResponse(200, {}),
  });

  await assert.rejects(() => client.updateAccount('42', { rateMultiplier: -1 }), MySiteAdminApiError);
  await assert.rejects(() => client.updateAccount('42', { rateMultiplier: 'abc' }), MySiteAdminApiError);
  await assert.rejects(() => client.updateAccount('42', { name: '  ' }), MySiteAdminApiError);
  await assert.rejects(() => client.updateAccount('42', { priority: -2 }), MySiteAdminApiError);
  await assert.rejects(() => client.updateAccount('42', { priority: 1.5 }), MySiteAdminApiError);
  await assert.rejects(() => client.updateAccount('42', {}), MySiteAdminApiError);
});

test('admin client exposes http status on failure', async () => {
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'bad-key',
    fetchImpl: async () => jsonResponse(401, { message: 'invalid admin key', error_code: 'INVALID_ADMIN_KEY' }),
  });

  const error = await client.listGroups().catch((err) => err);
  assert.ok(error instanceof MySiteAdminApiError);
  assert.equal(error.httpStatus, 401);
  assert.equal(error.errorCode, 'INVALID_ADMIN_KEY');
  assert.match(error.message, /invalid admin key/);
});

test('admin client sends model mapping whitelist in credentials', async () => {
  const calls = [];
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'admin-key-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { code: 0, data: { id: 44 } });
    },
  });

  await client.createAccount({
    name: 'a',
    platform: 'openai',
    apiKey: 'sk',
    groupId: 7,
    modelMapping: { 'gpt-5.6': 'gpt-5.6', 'gpt-5.6-mini': 'gpt-5.6-mini' },
  });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.credentials.model_mapping, {
    'gpt-5.6': 'gpt-5.6',
    'gpt-5.6-mini': 'gpt-5.6-mini',
  });

  // 不传或传空对象时不下发 model_mapping（空对象在 sub2api 语义是"允许所有"）
  await client.createAccount({ name: 'b', platform: 'openai', apiKey: 'sk', groupId: 7, modelMapping: {} });
  const withoutMapping = JSON.parse(calls[1].options.body);
  assert.equal(withoutMapping.credentials.model_mapping, undefined);
});

test('admin client getAccount normalizes bound group ids', async () => {
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'admin-key-1',
    fetchImpl: async () => jsonResponse(200, {
      code: 0,
      data: {
        id: 42,
        name: 'a',
        rate_multiplier: 0.05,
        account_groups: [{ group_id: 15 }, { group: { id: 24 } }],
      },
    }),
  });

  const account = await client.getAccount(42);
  assert.deepEqual(account.groupIds, ['15', '24']);
});

test('admin client getAccount returns null groupIds when account_groups is absent', async () => {
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com',
    adminKey: 'admin-key-1',
    fetchImpl: async () => jsonResponse(200, { code: 0, data: { id: 42, name: 'a', rate_multiplier: 0.05 } }),
  });

  const account = await client.getAccount(42);
  assert.equal(account.groupIds, null);
});

test('admin client synchronizes proxy fields and clears expiry and credentials explicitly', async () => {
  const calls = [];
  const client = createSub2ApiAdminClient({
    baseUrl: 'https://sub.example.com', adminKey: 'admin-key',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse(200, { code: 0, data: {} }); },
  });
  await client.updateProxy('66', {
    name: '新名', protocol: 'socks5', host: 'proxy.test', port: 1080,
    username: '', password: '', status: 'inactive', expiresAt: null,
  });
  assert.equal(calls[0].url, 'https://sub.example.com/api/v1/admin/proxies/66');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    name: '新名', protocol: 'socks5', host: 'proxy.test', port: 1080,
    username: '', password: '', status: 'inactive', expires_at: null,
  });
  await client.updateProxy('66', { name: '局部更新' });
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: '局部更新' });
});
