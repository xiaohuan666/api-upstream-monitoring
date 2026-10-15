import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuthSub2ClientError, createOAuthSub2Client, buildOAuthCredentials } from '../src/oauth-sub2-client.mjs';
import { normalizeImportOptions, importModelMapping, accountMatchesImportOptions } from '../src/oauth-import-options.mjs';

const NOW = Date.parse('2026-10-06T00:00:00Z');
const FUTURE = 4_102_444_800;
const EMAIL = 'person@example.com';
const SECRET = 'upstream-password-refresh-token-admin-key-do-not-leak';
const AUTH = 'https://api.openai.com/auth';
const PROFILE = 'https://api.openai.com/profile';
function jwt(claims) {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
}
function tokens(overrides = {}) {
  return { access_token: 'real-access', refresh_token: 'real-refresh', expires_at: FUTURE, email: EMAIL, chatgpt_account_id: 'default-account', chatgpt_user_id: 'default-user', ...overrides };
}
function proxy(overrides = {}) {
  return { id: 9, name: 'isolated proxy', protocol: 'socks5', host: 'proxy.example.com', port: 1080,
    username: ' user ', password: ' password ', status: 'active', expires_at: '2030-01-01T00:00:00Z', ...overrides };
}
function account(id, overrides = {}) {
  return { id, name: 'custom display name', platform: 'openai', type: 'oauth', credentials: { email: EMAIL },
    extra: {}, group_ids: [2, 3], proxy_id: 9, status: 'active', ...overrides };
}
function response(data, { status = 200, raw, envelope = true } = {}) {
  return { status, ok: status >= 200 && status < 300,
    async text() { return raw ?? JSON.stringify(envelope ? { code: 0, data } : data); } };
}
function page(items, { total = items.length, number = 1, size = 100, pages = Math.max(1, Math.ceil(total / size)) } = {}) {
  return { items, total, page: number, page_size: size, pages };
}
function mockClient(responses, options = {}) {
  const calls = [];
  const client = createOAuthSub2Client({ baseUrl: 'https://sub.example.test', adminKey: SECRET,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : undefined });
      assert.ok(responses.length, 'unexpected network call');
      const next = responses.shift();
      return typeof next === 'function' ? next(url, init) : next;
    }, ...options });
  return { client, calls };
}
function checkError(error, { code, ambiguous = false, httpStatus = null, needsAttention = false, statusCode } = {}) {
  assert.ok(error instanceof OAuthSub2ClientError);
  assert.equal(error.safe, true);
  assert.equal(error.code, code);
  assert.equal(error.errorCode, code);
  assert.equal(error.ambiguous, ambiguous);
  assert.equal(error.httpStatus, httpStatus);
  assert.equal(error.needsAttention, needsAttention);
  assert.ok(Number.isInteger(error.statusCode));
  if (statusCode) assert.equal(error.statusCode, statusCode);
  const printed = `${String(error)} ${error.stack} ${JSON.stringify(error)}`;
  assert.ok(!printed.includes(SECRET));
  assert.ok(!printed.includes('real-refresh'));
  assert.equal(error.cause, undefined);
  return true;
}
function build(info, options = {}) {
  return buildOAuthCredentials(info, { email: EMAIL, now: NOW, ...options });
}
const creation = () => ({ name: 'My OAuth account', credentials: build(tokens()), proxyId: 9, groupIds: [2, 3] });
const create = (client) => client.createOAuthAccount(creation(), { idempotencyKey: 'stable-job-1' });

test('credentials map trusted TokenInfo, whitelist metadata, and never invent expiration/client/models', () => {
  const input = tokens({ chatgpt_account_id: 'acc', chatgpt_user_id: 'user', organization_id: 'org', client_id: 'client',
    plan_type: 'plus', expires_in: 3600, id_token: 'opaque-id-token', model_mapping: { fabricated: 'model' },
    api_key: SECRET, auth_mode: 'pat', subscription_expires_at: SECRET });
  const original = structuredClone(input);
  assert.deepEqual(build(input), {
    access_token: 'real-access', refresh_token: 'real-refresh', expires_at: '2100-01-01T00:00:00.000Z', email: EMAIL,
    chatgpt_account_id: 'acc', chatgpt_user_id: 'user', organization_id: 'org', client_id: 'client', plan_type: 'plus',
    id_token: 'opaque-id-token', expires_in: 3600,
  });
  assert.deepEqual(input, original);
  assert.deepEqual(Object.keys(build(tokens())).sort(), ['access_token', 'chatgpt_account_id', 'chatgpt_user_id', 'email', 'expires_at', 'refresh_token']);
});

test('JWT fallback extracts profile email, exp, account/user/org/client/plan without signature verification', () => {
  const access = jwt({ exp: FUTURE, [PROFILE]: { email: 'PERSON@example.com' }, client_id: 'jwt-client',
    [AUTH]: { chatgpt_account_id: 'jwt-account', chatgpt_user_id: 'jwt-user', chatgpt_plan_type: 'team' } });
  const id = jwt({ email: EMAIL, [AUTH]: { organizations: [{ id: '' }, { id: 'jwt-org' }] } });
  const mapped = build(tokens({ chatgpt_account_id: undefined, chatgpt_user_id: undefined, email: undefined, expires_at: undefined, access_token: access, id_token: id }));
  assert.equal(mapped.chatgpt_account_id, 'jwt-account');
  assert.equal(mapped.chatgpt_user_id, 'jwt-user');
  assert.equal(mapped.organization_id, 'jwt-org');
  assert.equal(mapped.client_id, 'jwt-client');
  assert.equal(mapped.plan_type, 'team');
  assert.equal(mapped.email, EMAIL);
  assert.equal(mapped.expires_at, '2100-01-01T00:00:00.000Z');
});

test('JWT root email and ID token auth metadata are valid fallbacks', () => {
  const mapped = build(tokens({ chatgpt_account_id: undefined, chatgpt_user_id: undefined, email: undefined, account_id: 'response-account', id_token: jwt({ email: EMAIL,
    client_id: 'id-client', [AUTH]: { chatgpt_user_id: 'id-user', organization_id: 'id-org', chatgpt_plan_type: 'pro' } }) }));
  assert.equal(mapped.chatgpt_account_id, 'response-account');
  assert.equal(mapped.chatgpt_user_id, 'id-user');
  assert.equal(mapped.client_id, 'id-client');
  assert.equal(mapped.organization_id, 'id-org');
  assert.equal(mapped.plan_type, 'pro');
});

for (const [label, info] of [
  ['null info', null], ['array info', []], ['blank access', tokens({ access_token: '  ' })],
  ['blank refresh', tokens({ refresh_token: '' })], ['object token', tokens({ refresh_token: { secret: SECRET } })],
  ['number token', tokens({ access_token: 42 })], ['whitespace token', tokens({ access_token: 'token with space' })],
  ['missing expiry', tokens({ expires_at: undefined, expires_in: 3600 })],
  ['expired', tokens({ expires_at: Math.floor(NOW / 1000) - 1 })],
  ['equal now', tokens({ expires_at: Math.floor(NOW / 1000) })],
  ['invented TTL only', tokens({ expires_at: undefined, expires_in: 863999 })],
  ['invalid expiry', tokens({ expires_at: SECRET })], ['millisecond expiry', tokens({ expires_at: NOW + 3600_000 })], ['out of range expiry', tokens({ expires_at: Number.MAX_SAFE_INTEGER })],
  ['negative expiry', tokens({ expires_at: -5 })], ['fractional expiry', tokens({ expires_at: FUTURE + 0.1 })],
  ['expired JWT despite response', tokens({ access_token: jwt({ email: EMAIL, exp: Math.floor(NOW / 1000) - 10 }) })],
  ['invalid JWT exp', tokens({ access_token: jwt({ email: EMAIL, exp: 'future' }) })],
]) {
  test(`credential gate rejects ${label} safely`, () => {
    assert.throws(() => build(info), (error) => checkError(error, { code: 'invalid_credentials', statusCode: 400 }));
  });
}

for (const [label, info] of [
  ['absent evidence', tokens({ email: undefined })], ['different response email', tokens({ email: 'other@example.com' })],
  ['object email', tokens({ email: { secret: SECRET } })],
  ['conflicting JWT', tokens({ access_token: jwt({ email: 'other@example.com', exp: FUTURE }) })],
  ['conflicting ID token', tokens({ id_token: jwt({ email: 'other@example.com' }) })],
  ['malformed JWT without response', tokens({ email: undefined, access_token: 'header.invalid-json.signature' })],
]) {
  test(`email verification rejects ${label}`, () => {
    assert.throws(() => build(info), (error) => checkError(error, { code: 'email_mismatch', statusCode: 400 }));
  });
}

test('credentials accept RFC3339, Date/function clock, normalized emails, and earliest real expiration', () => {
  const exp = Math.floor(NOW / 1000) + 3600;
  const mapped = build(tokens({ email: ' PERSON@EXAMPLE.COM ', access_token: jwt({ exp }), expires_at: '2100-01-01T00:00:00Z' }), { now: () => new Date(NOW) });
  assert.equal(mapped.expires_at, new Date(exp * 1000).toISOString());
  assert.equal(mapped.email, EMAIL);
  assert.throws(() => build(tokens(), { now: NaN }), (error) => checkError(error, { code: 'invalid_credentials', statusCode: 400 }));
  assert.throws(() => build(tokens(), { now: () => { throw new Error(SECRET); } }), (error) => checkError(error, { code: 'invalid_credentials', statusCode: 400 }));
});

test('malformed JWT can use trusted response; unsafe metadata is omitted without stringifying secrets', () => {
  const mapped = build(tokens({ access_token: 'e30.not-json.fixture',
    organization_id: [SECRET], client_id: {}, plan_type: '\n\0bad' }));
  assert.equal(mapped.chatgpt_user_id, 'default-user');
  for (const field of ['organization_id', 'client_id', 'plan_type']) assert.ok(!Object.hasOwn(mapped, field));
});

test('groups expose integer IDs and exact platform/status, without active/openai defaults', async () => {
  const { client, calls } = mockClient([response([
    { id: '4', name: 'active OpenAI', platform: 'openai', status: 'active', secret: SECRET },
    { id: 5, name: 'inactive mixed', platform: 'composite', status: 'inactive' },
  ])]);
  assert.deepEqual(await client.listGroups(), [
    { id: 4, name: 'active OpenAI', platform: 'openai', status: 'active' },
    { id: 5, name: 'inactive mixed', platform: 'composite', status: 'inactive' },
  ]);
  assert.equal(calls[0].url.pathname, '/api/v1/admin/groups/all');
  assert.equal(calls[0].init.headers['x-api-key'], SECRET);
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('base URL prefix is retained without following redirects or reading config', async () => {
  const { client, calls } = mockClient([response([])], { baseUrl: 'https://sub.example.test/panel///' });
  await client.listGroups();
  assert.equal(calls[0].url.pathname, '/panel/api/v1/admin/groups/all');
});

for (const options of [
  { baseUrl: 'invalid' }, { baseUrl: 'file:///etc/passwd' }, { baseUrl: `https://user:${SECRET}@example.test` },
  { baseUrl: 'https://example.test/?q=secret' }, { adminKey: '' }, { adminKey: `${SECRET}\r\nx: header` },
  { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { fetchImpl: null },
]) {
  test(`invalid client configuration is controlled: ${Object.keys(options)[0]} ${JSON.stringify(options).length}`, () => {
    assert.throws(() => mockClient([], options), (error) => checkError(error, { code: 'invalid_input', statusCode: 400 }));
  });
}

test('proxy pagination uses actual page_size, includes inactive/auth, and normalizes exact backend shape', async () => {
  const first = proxy();
  const second = proxy({ id: 10, status: 'inactive', username: undefined, password: undefined, expires_at: null });
  const { client, calls } = mockClient([
    response(page([first], { total: 2, size: 1 })), response(page([second], { total: 2, size: 1, number: 2 })),
  ]);
  const list = await client.listProxies();
  assert.deepEqual(list, [
    { id: 9, name: first.name, protocol: 'socks5', host: first.host, port: 1080,
      username: ' user ', password: ' password ', status: 'active', expiresAt: '2030-01-01T00:00:00.000Z' },
    { id: 10, name: first.name, protocol: 'socks5', host: first.host, port: 1080,
      username: '', password: '', status: 'inactive', expiresAt: null },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.searchParams.get('page'), '2');
  assert.equal(calls[0].url.searchParams.get('page_size'), '100');
});

test('getProxy returns full authentication with standard keys and rejects mismatched IDs', async () => {
  const { client, calls } = mockClient([response(proxy()), response(proxy({ id: 10 }))]);
  const value = await client.getProxy('9');
  assert.equal(value.password, ' password ');
  assert.deepEqual(Object.keys(value).sort(), ['expiresAt', 'host', 'id', 'name', 'password', 'port', 'protocol', 'status', 'username'].sort());
  assert.equal(calls[0].url.pathname, '/api/v1/admin/proxies/9');
  await assert.rejects(client.getProxy(9), (error) => checkError(error, { code: 'sub2_invalid_response', httpStatus: 200 }));
});

test('getProxy 404 throws safe controlled error without response message', async () => {
  const { client } = mockClient([response({ message: SECRET }, { status: 404, envelope: false })]);
  await assert.rejects(client.getProxy(9), (error) => checkError(error, { code: 'sub2_http_error', httpStatus: 404 }));
});

test('createProxy preserves authentication, stable key and unix expiry; returns uniform normalization', async () => {
  const remote = proxy();
  const { client, calls } = mockClient([response(remote, { status: 201 })]);
  const result = await client.createProxy({ ...remote, expiresAt: '2030-01-01T00:00:00Z', model_mapping: SECRET }, { idempotencyKey: 'proxy-job-1' });
  assert.equal(result.password, ' password ');
  assert.equal(calls[0].init.headers['idempotency-key'], 'proxy-job-1');
  assert.deepEqual(calls[0].body, { name: remote.name, protocol: 'socks5', host: remote.host, port: 1080,
    username: ' user ', password: ' password ', expires_at: 1_893_456_000 });
  assert.equal(calls[0].init.rejectUnauthorized, undefined);
});

test('createProxy without expiry does not add a fixed TTL or fallback', async () => {
  const { client, calls } = mockClient([response(proxy({ expires_at: null }))]);
  await client.createProxy(proxy({ expires_at: null }), { idempotencyKey: 'proxy-stable' });
  assert.ok(!Object.hasOwn(calls[0].body, 'expires_at'));
  assert.ok(!Object.hasOwn(calls[0].body, 'fallback_mode'));
});

test('generate/exchange use handler paths and exact proxy/session/state/redirect fields; exchange returns raw token info', async () => {
  const tokenInfo = tokens({ additional_backend_metadata: 'preserved' });
  const { client, calls } = mockClient([
    response({ auth_url: 'https://auth.openai.com/oauth/authorize?state=secret-state', session_id: 'session-1' }),
    response(tokenInfo),
  ]);
  assert.deepEqual(await client.generateAuthUrl({ proxyId: '9' }), { authUrl: 'https://auth.openai.com/oauth/authorize?state=secret-state', sessionId: 'session-1' });
  const exchanged = await client.exchangeCode({ sessionId: 'session-1', code: 'authorization-code', state: 'secret-state', proxyId: 9, redirectUri: 'http://localhost:1455/auth/callback' });
  assert.deepEqual(exchanged, tokenInfo);
  assert.equal(calls[0].url.pathname, '/api/v1/admin/openai/generate-auth-url');
  assert.deepEqual(calls[0].body, { proxy_id: 9 });
  assert.equal(calls[1].url.pathname, '/api/v1/admin/openai/exchange-code');
  assert.deepEqual(calls[1].body, { session_id: 'session-1', code: 'authorization-code', state: 'secret-state', proxy_id: 9, redirect_uri: 'http://localhost:1455/auth/callback' });
});

test('direct OAuth flow explicitly uses null proxy_id and no made-up redirect', async () => {
  const { client, calls } = mockClient([
    response({ auth_url: 'https://auth.openai.com/oauth/authorize', session_id: 'session-1' }), response(tokens()),
  ]);
  await client.generateAuthUrl();
  await client.exchangeCode({ sessionId: 'session-1', code: 'code', state: 'state' });
  assert.deepEqual(calls[0].body, { proxy_id: null });
  assert.deepEqual(calls[1].body, { session_id: 'session-1', code: 'code', state: 'state', proxy_id: null });
});

for (const url of ['https://evil.test/oauth/authorize', 'http://auth.openai.com/oauth/authorize', 'https://auth.openai.com.evil.test/', 'https://user:password@auth.openai.com/', 'https://auth.openai.com:444/']) {
  test(`unsafe authorization URL fails as ambiguous session result: ${url}`, async () => {
    const { client } = mockClient([response({ auth_url: url, session_id: 'session' })]);
    await assert.rejects(client.generateAuthUrl(), (error) => checkError(error, { code: 'sub2_invalid_response', ambiguous: true, httpStatus: 200 }));
  });
}

test('exchange rejects malformed success tokens as ambiguous, but never changes raw valid token info', async () => {
  const { client } = mockClient([response(tokens({ refresh_token: '' }))]);
  await assert.rejects(client.exchangeCode({ sessionId: 's', code: 'c', state: 'st' }), (error) => checkError(error, { code: 'sub2_invalid_response', ambiguous: true, httpStatus: 200 }));
});

test('listAccounts traverses actual pagination and keeps duplicate candidates with full raw fields', async () => {
  const first = account(1, { extra: { email: ' PERSON@EXAMPLE.COM ', metadata: { retained: true } }, credentials: { email: EMAIL, account_identity: 'identity-1' } });
  const second = account(2, { credentials: { email: 'other@example.com' }, extra: null });
  const third = account(3, { platform: 'anthropic', type: 'apikey', credentials: {}, extra: { email: EMAIL }, group_ids: [4], proxy_id: null });
  const fourth = account(4, { name: EMAIL, credentials: {}, extra: {} });
  const { client, calls } = mockClient([
    response(page([first, second], { total: 4, size: 2 })), response(page([third, fourth], { total: 4, size: 2, number: 2 })),
  ]);
  assert.deepEqual(await client.listAccounts({ email: EMAIL }), [first, third, fourth]);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url.pathname, '/api/v1/admin/accounts');
    assert.equal(call.url.searchParams.get('search'), null);
    assert.equal(call.url.searchParams.get('type'), null);
    assert.equal(call.url.searchParams.get('platform'), null);
    assert.notEqual(call.url.searchParams.get('lite'), 'true');
    assert.equal(call.url.searchParams.get('sort_by'), 'id');
    assert.equal(call.url.searchParams.get('sort_order'), 'asc');
  }
});

test('listAccounts can list all and find JWT/ID-token email candidates with arbitrary names', async () => {
  const items = [account(1, { credentials: { access_token: jwt({ [PROFILE]: { email: EMAIL } }) } }),
    account(2, { credentials: { id_token: jwt({ email: EMAIL }) } })];
  const { client } = mockClient([response(page(items)), response(page(items))]);
  assert.deepEqual(await client.listAccounts(), items);
  assert.deepEqual(await client.listAccounts({ email: 'PERSON@EXAMPLE.COM' }), items);
});

test('empty account/proxy pagination is safe only with complete metadata', async () => {
  const { client } = mockClient([response(page([])), response(page([]))]);
  assert.deepEqual(await client.listAccounts({ email: EMAIL }), []);
  assert.deepEqual(await client.listProxies(), []);
});

for (const [label, pages, code] of [
  ['missing metadata', [{ items: [] }], 'sub2_pagination_error'],
  ['empty early page', [page([], { total: 2, size: 1 })], 'sub2_pagination_error'],
  ['wrong page', [page([account(1)], { number: 2 })], 'sub2_pagination_error'],
  ['wrong pages', [page([account(1)], { pages: 2 })], 'sub2_pagination_error'],
  ['noninteger total', [page([], { total: '0' })], 'sub2_pagination_error'],
  ['over account limit', [page([], { total: 10001, size: 1000 })], 'sub2_scan_limit'],
  ['over page limit', [page([account(1)], { total: 101, size: 1 })], 'sub2_scan_limit'],
  ['overlapping pages', [page([account(1)], { total: 2, size: 1 }), page([account(1)], { total: 2, size: 1, number: 2 })], 'sub2_pagination_error'],
  ['changing total', [page([account(1)], { total: 2, size: 1 }), page([account(2)], { total: 3, size: 1, number: 2 })], 'sub2_pagination_error'],
  ['changing page size', [page([account(1)], { total: 3, size: 1 }), page([account(3)], { total: 3, size: 2, number: 2 })], 'sub2_pagination_error'],
  ['partial final page', [page([account(1)], { total: 2, size: 1 }), page([], { total: 2, size: 1, number: 2 })], 'sub2_pagination_error'],
  ['lite DTO without extra', [page([account(1, { extra: undefined })])], 'sub2_pagination_error'],
]) {
  test(`account pagination fails closed for ${label}`, async () => {
    const { client } = mockClient(pages.map((value) => response(value)));
    await assert.rejects(client.listAccounts({ email: EMAIL }), (error) => checkError(error, { code, httpStatus: 200 }));
  });
}

test('account creation defaults are fixed safe values, credentials whitelisted, all groups bound once', async () => {
  const result = account(42);
  const { client, calls } = mockClient([response(result, { status: 201 }), response(result, { status: 201 })]);
  const input = creation();
  input.groupIds = [2, '3', 2];
  input.credentials.model_mapping = { fake: 'fixed' };
  input.credentials.insecure_skip_verify = true;
  input.priority = 100;
  assert.deepEqual(await client.createOAuthAccount(input, { idempotencyKey: 'same-stable-job' }), result);
  await client.createOAuthAccount(input, { idempotencyKey: 'same-stable-job' });
  const body = calls[0].body;
  assert.deepEqual(body, { name: 'My OAuth account', platform: 'openai', type: 'oauth',
    credentials: build(tokens()), extra: { email: EMAIL }, proxy_id: 9, group_ids: [2, 3],
    concurrency: 1, priority: 1, rate_multiplier: 1, auto_pause_on_expired: true });
  assert.equal(calls[0].init.headers['idempotency-key'], 'same-stable-job');
  assert.equal(calls[1].init.headers['idempotency-key'], 'same-stable-job');
  assert.equal(calls[0].url.pathname, '/api/v1/admin/accounts');
  assert.deepEqual(calls[1].body, body);
});

test('direct account creation does not attach a remote proxy', async () => {
  const { client, calls } = mockClient([response(account(42, { proxy_id: null }))]);
  await client.createOAuthAccount({ ...creation(), proxyId: null }, { idempotencyKey: 'stable-direct' });
  assert.equal(calls[0].body.proxy_id, null);
});

for (const invalidKey of [undefined, '', 'contains space', 'a\r\nheader', 'x'.repeat(129)]) {
  test(`caller-supplied idempotency key required for both creations: ${String(invalidKey).length}`, async () => {
    const { client, calls } = mockClient([]);
    await assert.rejects(client.createOAuthAccount(creation(), { idempotencyKey: invalidKey }), (error) => checkError(error, { code: 'invalid_input', statusCode: 400 }));
    await assert.rejects(client.createProxy(proxy(), { idempotencyKey: invalidKey }), (error) => checkError(error, { code: 'invalid_input', statusCode: 400 }));
    assert.equal(calls.length, 0);
  });
}

test('invalid IDs/groups/proxy/state are rejected before any fetch', async () => {
  const { client, calls } = mockClient([]);
  const actions = [
    () => client.getProxy('../evil'), () => client.getProxy(0), () => client.getProxy(Number.MAX_SAFE_INTEGER + 1),
    () => client.generateAuthUrl({ proxyId: {} }),
    () => client.exchangeCode({ sessionId: 's', code: SECRET, state: '' }),
    () => client.createOAuthAccount({ ...creation(), groupIds: [] }, { idempotencyKey: 'k' }),
    () => client.createOAuthAccount({ ...creation(), groupIds: [true] }, { idempotencyKey: 'k' }),
    () => client.createProxy({ ...proxy(), port: 65536 }, { idempotencyKey: 'k' }),
    () => client.createProxy({ ...proxy(), expiresAt: SECRET }, { idempotencyKey: 'k' }),
    () => client.listAccounts({ email: SECRET }),
  ];
  for (const action of actions) await assert.rejects(action(), (error) => checkError(error, { code: 'invalid_input', statusCode: 400 }));
  assert.equal(calls.length, 0);
});

for (const [label, mocked, expected] of [
  ['fetch exception', async () => { throw new Error(SECRET); }, { code: 'sub2_network_error', ambiguous: true }],
  ['body exception', { status: 201, async text() { throw new Error(SECRET); } }, { code: 'sub2_network_error', ambiguous: true, httpStatus: 201 }],
  ['503 response', response({ message: SECRET, code: 503, reason: SECRET }, { status: 503, envelope: false }), { code: 'sub2_http_error', ambiguous: true, httpStatus: 503 }],
  ['503 invalid JSON', response(null, { status: 503, raw: SECRET }), { code: 'sub2_http_error', ambiguous: true, httpStatus: 503 }],
  ['408 response', response({}, { status: 408 }), { code: 'sub2_http_error', ambiguous: true, httpStatus: 408 }],
  ['400 response', response({ message: SECRET }, { status: 400 }), { code: 'sub2_http_error', httpStatus: 400 }],
  ['401 non-JSON', response(null, { status: 401, raw: SECRET }), { code: 'sub2_http_error', httpStatus: 401 }],
  ['409 invalid JSON', response(null, { status: 409, raw: SECRET }), { code: 'sub2_http_error', httpStatus: 409, statusCode: 409 }],
  ['404 body exception', { status: 404, async text() { throw new Error(SECRET); } }, { code: 'sub2_network_error', httpStatus: 404 }],
  ['success non-JSON', response(null, { raw: SECRET }), { code: 'sub2_invalid_response', ambiguous: true, httpStatus: 200 }],
  ['success empty', { status: 204, async text() { return ''; } }, { code: 'sub2_invalid_response', ambiguous: true, httpStatus: 204 }],
  ['success error envelope', response({ code: 500, message: SECRET }, { envelope: false }), { code: 'sub2_invalid_response', ambiguous: true, httpStatus: 200 }],
  ['success nonzero envelope', response({ code: 1, message: SECRET, data: { id: 42 } }, { envelope: false }), { code: 'sub2_invalid_response', ambiguous: true, httpStatus: 200 }],
  ['success missing ID', response({ name: SECRET }), { code: 'sub2_invalid_response', ambiguous: true, httpStatus: 200 }],
  ['success invalid ID', response({ id: 'not-an-id', secret: SECRET }), { code: 'sub2_invalid_response', ambiguous: true, httpStatus: 200 }],
]) {
  test(`controlled mutation failure and no auto retry: ${label}`, async () => {
    const { client, calls } = mockClient([mocked]);
    await assert.rejects(create(client), (error) => checkError(error, expected));
    assert.equal(calls.length, 1);
  });
}

test('mixed-channel 409 is needsAttention, does not confirm conflict or echo upstream details', async () => {
  const { client, calls } = mockClient([response({ error: 'mixed_channel_warning', message: SECRET, details: { secret: SECRET } }, { status: 409, envelope: false })]);
  await assert.rejects(create(client), (error) => checkError(error, { code: 'mixed_channel_warning', needsAttention: true, statusCode: 409, httpStatus: 409 }));
  assert.equal(calls.length, 1);
  assert.ok(!Object.hasOwn(calls[0].body, 'confirm_mixed_channel_risk'));
});

for (const reason of ['IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_RETRY_BACKOFF']) {
  test(`pending idempotency 409 is ambiguous: ${reason}`, async () => {
    const { client } = mockClient([response({ reason, message: SECRET }, { status: 409, envelope: false })]);
    await assert.rejects(create(client), (error) => checkError(error, { code: 'sub2_idempotency_pending', ambiguous: true, statusCode: 409, httpStatus: 409 }));
  });
}

test('ordinary 409 remains controlled without automatic confirm or arbitrary upstream code', async () => {
  const { client } = mockClient([response({ reason: SECRET, code: SECRET, message: SECRET }, { status: 409, envelope: false })]);
  await assert.rejects(create(client), (error) => checkError(error, { code: 'sub2_http_error', httpStatus: 409, statusCode: 409 }));
});

test('proxy creation success missing ID is ambiguous too', async () => {
  const { client } = mockClient([response(proxy({ id: undefined }))]);
  await assert.rejects(client.createProxy(proxy(), { idempotencyKey: 'stable-proxy' }), (error) => checkError(error, { code: 'sub2_invalid_response', ambiguous: true, httpStatus: 200 }));
});

test('read failures are not marked ambiguous writes and expose no upstream secrets', async () => {
  const { client } = mockClient([
    async () => { throw new Error(SECRET); }, response(null, { status: 502, raw: SECRET }), response(null, { raw: SECRET }),
  ]);
  await assert.rejects(client.listGroups(), (error) => checkError(error, { code: 'sub2_network_error' }));
  await assert.rejects(client.listGroups(), (error) => checkError(error, { code: 'sub2_http_error', httpStatus: 502 }));
  await assert.rejects(client.listGroups(), (error) => checkError(error, { code: 'sub2_invalid_response', httpStatus: 200 }));
});

test('timeout is bounded even when injected fetch ignores abort, and create is never retried', async () => {
  let signal;
  const { client, calls } = mockClient([async (_, init) => { signal = init.signal; return new Promise(() => {}); }], { timeoutMs: 10 });
  await assert.rejects(create(client), (error) => checkError(error, { code: 'sub2_timeout', statusCode: 504, ambiguous: true }));
  assert.equal(signal.aborted, true);
  assert.equal(calls.length, 1);
});

test('timeout covers response body reads and read operations too', async () => {
  const { client } = mockClient([{ status: 200, async text() { return new Promise(() => {}); } }], { timeoutMs: 10 });
  await assert.rejects(client.listGroups(), (error) => checkError(error, { code: 'sub2_timeout', httpStatus: 200, statusCode: 504 }));
});

test('raw valid legacy payloads work; malformed group/proxy shapes fail rather than assume active or empty', async () => {
  const { client } = mockClient([
    response([], { envelope: false }), response([{ id: 1, name: 'missing metadata' }]),
    response(proxy({ password: { secret: SECRET } })),
  ]);
  assert.deepEqual(await client.listGroups(), []);
  await assert.rejects(client.listGroups(), (error) => checkError(error, { code: 'sub2_invalid_response', httpStatus: 200 }));
  await assert.rejects(client.getProxy(9), (error) => checkError(error, { code: 'sub2_invalid_response', httpStatus: 200 }));
});


for (const [label, overrides] of [
  ['both missing', { chatgpt_account_id: undefined, chatgpt_user_id: undefined }],
  ['workspace only', { chatgpt_user_id: undefined }],
  ['user only', { chatgpt_account_id: undefined }],
  ['non-string identity', { chatgpt_account_id: { secret: SECRET } }],
  ['whitespace identity', { chatgpt_user_id: ' user ' }],
  ['conflicting JWT identity', { access_token: jwt({ [AUTH]: { chatgpt_account_id: 'different-account', chatgpt_user_id: 'default-user' } }) }],
]) {
  test(`identity gate rejects ${label} without guessing a seat`, () => {
    assert.throws(() => build(tokens(overrides)), (error) => checkError(error, { code: 'invalid_identity', statusCode: 400 }));
  });
}

function importedAccount(options = {}, overrides = {}) {
  const normalized = normalizeImportOptions(options);
  // Actual safe Sub2 DTO: token keys are redacted, but identity and model/plan settings remain.
  return account(42, {
    credentials: { email: EMAIL, chatgpt_account_id: 'default-account', chatgpt_user_id: 'default-user',
      model_mapping: importModelMapping(normalized), plan_type: normalized.planType || 'plus' },
    extra: { anti_degradation: normalized.accountProtection, email: EMAIL, codex_fingerprint_mode: normalized.fingerprintMode,
      openai_oauth_responses_websockets_v2_mode: normalized.wsMode,
      openai_oauth_responses_websockets_v2_enabled: normalized.wsMode !== 'off' },
    concurrency: normalized.concurrency, load_factor: normalized.loadFactor, priority: normalized.priority,
    rate_multiplier: normalized.rateMultiplier, auto_pause_on_expired: normalized.autoPauseOnExpired,
    schedulable: normalized.schedulable, ...overrides,
  });
}
function createImported(client, importOptions = {}) {
  return client.createOAuthAccount({ ...creation(), importOptions }, { idempotencyKey: 'stable-batch-account' });
}

test('import capability GET reads precise boolean in standard envelope and keeps prefix/auth', async () => {
  const { client, calls } = mockClient([response({ atomic_schedulable: true }, { raw: '{"data":{"atomic_schedulable":true}}' })], { baseUrl: 'https://sub.example.test/prefix' });
  assert.deepEqual(await client.importCapabilities(), { atomicSchedulable: true, atomicProtection: false });
  assert.equal(calls[0].url.pathname, '/prefix/api/v1/admin/accounts/import/capabilities');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['x-api-key'], SECRET);
  assert.equal(calls[0].body, undefined);
});

for (const unsupported of [response({ atomic_schedulable: false }), response({ other_future_feature: true }),
  response({}, { status: 404, raw: '<html>Not Found</html>' }), response({}, { status: 405, raw: SECRET }),
]) {
  test(`capability explicitly unsupported ${unsupported.status} returns false only`, async () => {
    const { client, calls } = mockClient([unsupported]);
    assert.deepEqual(await client.importCapabilities(), { atomicSchedulable: false, atomicProtection: false });
    assert.equal(calls.length, 1);
  });
}

for (const status of [301, 400, 401, 403, 408, 409, 429, 500, 502, 503]) {
  test(`capability HTTP ${status} never silently becomes compatible legacy`, async () => {
    const { client } = mockClient([response({ message: SECRET }, { status })]);
    await assert.rejects(client.importCapabilities(), (error) => checkError(error, { code: 'sub2_http_error', httpStatus: status }));
  });
}
for (const malformed of [response(null), response([]), response(true), response({ atomic_schedulable: 'true' }),
  response({ atomic_schedulable: 0 }), response({ atomic_schedulable: null }), response({}, { raw: SECRET }),
  response({}, { raw: '{"code":401,"message":"secret","data":{"atomic_schedulable":true}}' }),
]) {
  test('capability malformed success is a controlled error, never unsupported', async () => {
    const { client } = mockClient([malformed]);
    await assert.rejects(client.importCapabilities(), (error) => checkError(error, { code: 'sub2_invalid_response', httpStatus: 200 }));
  });
}

test('capability transport and body-read failures are errors, not compatibility', async () => {
  for (const [next, httpStatus] of [[() => { throw new Error(SECRET); }, null],
    [() => ({ status: 404, async text() { throw new Error(SECRET); } }), 404]]) {
    const { client } = mockClient([next]);
    await assert.rejects(client.importCapabilities(), (error) => checkError(error, {
      code: 'sub2_network_error', httpStatus,
    }));
  }
  const { client } = mockClient([() => new Promise(() => {})], { timeoutMs: 5 });
  await assert.rejects(client.importCapabilities(), (error) => checkError(error, { code: 'sub2_timeout', statusCode: 504 }));
});

test('new default options map whitelist and all exact wire fields; complete DTO requires no extra GET', async () => {
  const remote = importedAccount();
  const { client, calls } = mockClient([response(remote, { status: 201 })]);
  const value = await createImported(client);
  assert.deepEqual(value, remote);
  assert.equal(accountMatchesImportOptions(value, {}), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    name: 'My OAuth account', platform: 'openai', type: 'oauth', credentials: { ...build(tokens()), model_mapping: importModelMapping(normalizeImportOptions()) },
    extra: { email: EMAIL, codex_fingerprint_mode: 'device', openai_oauth_responses_websockets_v2_mode: 'off', openai_oauth_responses_websockets_v2_enabled: false },
    proxy_id: 9, group_ids: [2, 3], concurrency: 50, load_factor: 50, priority: 1, rate_multiplier: 1,
    auto_pause_on_expired: true, schedulable: true,
  });
  assert.equal(calls[0].init.headers['idempotency-key'], 'stable-batch-account');
});

test('custom options set explicit plan, mapping, WS enabled, null load and disabled atomic scheduling without seed copy', async () => {
  const options = { modelMode: 'mapping', modelMapping: { 'gpt-*': 'target', exact: 'upstream' },
    concurrency: 80, loadFactor: null, priority: 9, rateMultiplier: 0,
    fingerprintMode: 'session', wsMode: 'passthrough', planType: 'self_serve_business_prolite',
    autoPauseOnExpired: false, schedulable: false };
  const input = { ...creation(), importOptions: options };
  input.credentials.plan_type = 'plus';
  input.credentials.model_mapping = { bad: 'bad' };
  input.credentials.codex_fingerprint_seed = SECRET;
  input.credentials.extra = { codex_fingerprint_seed: SECRET };
  input.credentials.password = SECRET;
  const before = structuredClone(input);
  const { client, calls } = mockClient([response(importedAccount(options))]);
  const remote = await client.createOAuthAccount(input, { idempotencyKey: 'stable-batch-account' });
  assert.equal(accountMatchesImportOptions(remote, options), true);
  const body = calls[0].body;
  assert.equal(body.credentials.plan_type, 'self_serve_business_prolite');
  assert.deepEqual(body.credentials.model_mapping, { exact: 'upstream', 'gpt-*': 'target' });
  assert.equal(body.credentials.access_token, input.credentials.access_token);
  assert.equal(body.credentials.refresh_token, input.credentials.refresh_token);
  assert.equal(body.credentials.chatgpt_account_id, 'default-account');
  assert.equal(body.credentials.chatgpt_user_id, 'default-user');
  assert.deepEqual(body.extra, { email: EMAIL, codex_fingerprint_mode: 'session',
    openai_oauth_responses_websockets_v2_mode: 'passthrough', openai_oauth_responses_websockets_v2_enabled: true });
  assert.equal(body.load_factor, null); assert.equal(body.rate_multiplier, 0);
  assert.equal(body.concurrency, 80); assert.equal(body.priority, 9);
  assert.equal(body.schedulable, false); assert.equal(body.auto_pause_on_expired, false);
  assert.ok(!JSON.stringify(body).includes(SECRET));
  assert.deepEqual(input, before);
});

test('automatic plan preserves trusted token plan; unrestricted sends explicit empty nested mapping', async () => {
  const options = { modelMode: 'unrestricted', models: [], modelMapping: {}, wsMode: 'ctx_pool' };
  const { client, calls } = mockClient([response(importedAccount(options))]);
  await client.createOAuthAccount({ ...creation(), credentials: build(tokens({ plan_type: 'plus' })), importOptions: options }, { idempotencyKey: 'k' });
  assert.equal(calls[0].body.credentials.plan_type, 'plus');
  assert.deepEqual(calls[0].body.credentials.model_mapping, {});
  assert.equal(calls[0].body.extra.openai_oauth_responses_websockets_v2_enabled, true);
});

test('all WS choices use exact mode and derived bool wire fields, not preference key spelling', async () => {
  for (const wsMode of ['off', 'ctx_pool', 'passthrough', 'http_bridge']) {
    const { client, calls } = mockClient([response(importedAccount({ wsMode }))]);
    await createImported(client, { wsMode });
    const extra = calls[0].body.extra;
    assert.equal(extra.openai_oauth_responses_websockets_v2_mode, wsMode);
    assert.equal(extra.openai_oauth_responses_websockets_v2_enabled, wsMode !== 'off');
    assert.ok(!Object.hasOwn(extra, 'openai_oauth_responses_websocket_v2_mode'));
  }
});

for (const importOptions of [null, { password: SECRET }, { access_token: SECRET }, { credentials: { access_token: SECRET } },
  { extra: { codex_fingerprint_seed: SECRET } }, { models: [] }, { concurrency: '50' }, { schedulable: 'false' }]) {
  test('create rejects invalid/secret import options before any network effect', async () => {
    const { client, calls } = mockClient([]);
    await assert.rejects(createImported(client, importOptions), (error) => {
      assert.equal(error.code, 'INVALID_IMPORT_OPTIONS'); assert.equal(error.safe, true); assert.equal(error.statusCode, 400);
      assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(SECRET)); return true;
    });
    assert.equal(calls.length, 0);
  });
}

test('create lacking group_ids reads the persisted DTO by numeric id, never fabricates groups from request', async () => {
  const incomplete = importedAccount(); delete incomplete.group_ids;
  const actual = importedAccount({}, { name: 'renamed-on-server', group_ids: [7] });
  const { client, calls } = mockClient([response(incomplete), response(actual)]);
  const result = await createImported(client);
  assert.deepEqual(result, actual);
  assert.deepEqual(result.group_ids, [7]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].url.pathname, '/api/v1/admin/accounts/42');
  assert.equal(calls[1].init.headers['idempotency-key'], undefined);
});

for (const remove of ['credentials', 'proxy_id', 'extra', 'schedulable', 'rate_multiplier', 'concurrency', 'priority', 'auto_pause_on_expired', 'load_factor']) {
  test(`create incomplete ${remove} GETs safe DTO only for new contract`, async () => {
    const incomplete = importedAccount(); delete incomplete[remove];
    const remote = importedAccount();
    const { client, calls } = mockClient([response(incomplete), response(remote)]);
    assert.deepEqual(await createImported(client), remote);
    assert.equal(calls.length, 2);
  });
}

for (const next of [response({}, { status: 401 }), response({}, { status: 404 }), response({}, { status: 500 }),
  response({ id: 43 }), response({ id: 42 }), response({}, { raw: SECRET }),
  () => { throw new Error(SECRET); },
]) {
  test('read-back failure after confirmed create always remains ambiguous and never repeats POST', async () => {
    const incomplete = importedAccount(); delete incomplete.group_ids;
    const { client, calls } = mockClient([response(incomplete), next]);
    await assert.rejects(createImported(client), (error) => {
      assert.ok(error instanceof OAuthSub2ClientError); assert.equal(error.safe, true); assert.equal(error.ambiguous, true);
      assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(SECRET)); return true;
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.init.method), ['POST', 'GET']);
  });
}

test('read-back timeout is ambiguous even though failing operation is GET', async () => {
  const incomplete = importedAccount(); delete incomplete.group_ids;
  const { client, calls } = mockClient([response(incomplete), () => new Promise(() => {})], { timeoutMs: 5 });
  await assert.rejects(createImported(client), (error) => checkError(error, { code: 'sub2_timeout', ambiguous: true, statusCode: 504 }));
  assert.equal(calls.length, 2);
});

test('full but mismatched remote options are returned for parent reconciliation, never success proof from request', async () => {
  const remote = importedAccount({}, { concurrency: 1, schedulable: false });
  const { client, calls } = mockClient([response(remote)]);
  const result = await createImported(client);
  assert.equal(accountMatchesImportOptions(result, {}), false);
  assert.equal(calls.length, 1);
});

test('model names resembling credential keys remain nested and cannot replace tokens or identity', async () => {
  const modelMapping = { access_token: 'replacement-access', refresh_token: 'replacement-refresh',
    chatgpt_account_id: 'replacement-workspace', chatgpt_user_id: 'replacement-user', plan_type: 'replacement-plan' };
  const options = { modelMode: 'mapping', modelMapping };
  const { client, calls } = mockClient([response(importedAccount(options))]);
  await createImported(client, options);
  const credentials = calls[0].body.credentials;
  assert.equal(credentials.access_token, 'real-access');
  assert.equal(credentials.refresh_token, 'real-refresh');
  assert.equal(credentials.chatgpt_account_id, 'default-account');
  assert.equal(credentials.chatgpt_user_id, 'default-user');
  assert.ok(!Object.hasOwn(credentials, 'plan_type'));
  assert.deepEqual(credentials.model_mapping, modelMapping);
});

test('auto-plan and actual omitted defaults return complete response without unnecessary GET', async () => {
  const options = { loadFactor: null, modelMode: 'unrestricted', models: [], fingerprintMode: 'off' };
  const remote = importedAccount(options);
  delete remote.load_factor;
  delete remote.credentials.plan_type;
  delete remote.credentials.model_mapping;
  delete remote.extra.codex_fingerprint_mode;
  const { client, calls } = mockClient([response(remote)]);
  const result = await createImported(client, options);
  assert.equal(calls.length, 1);
  assert.equal(accountMatchesImportOptions(result, options), true);
});

for (const field of ['email', 'chatgpt_account_id', 'chatgpt_user_id', 'model_mapping', 'plan_type']) {
  test(`new create reads back absent safe credential ${field}, rather than trust request/name`, async () => {
    const options = { planType: 'plus' };
    const incomplete = importedAccount(options); delete incomplete.credentials[field];
    const actual = importedAccount(options);
    const { client, calls } = mockClient([response(incomplete), response(actual)]);
    assert.deepEqual(await createImported(client, options), actual);
    assert.equal(calls.length, 2);
  });
}

test('repeat imports carry this operation marker without changing OAuth credentials', async () => {
  const creationKey = 'oauth-account-11111111-1111-4111-8111-111111111111';
  const { client, calls } = mockClient([response({ id: 42 })]);
  await client.createOAuthAccount({ ...creation(), creationKey }, { idempotencyKey: creationKey });
  assert.equal(calls[0].body.extra.oauth_onboarding_creation_key, creationKey);
  assert.equal(calls[0].body.credentials.oauth_onboarding_creation_key, undefined);
  assert.equal(calls[0].init.headers['idempotency-key'], creationKey);
});

test('creation marker cannot diverge from the stable idempotency key', async () => {
  const { client, calls } = mockClient([]);
  await assert.rejects(client.createOAuthAccount({ ...creation(), creationKey: 'oauth-account-11111111-1111-4111-8111-111111111111' }, { idempotencyKey: 'different-key' }));
  assert.equal(calls.length, 0);
});

test('new protection capability is explicit and rejects malformed booleans', async () => {
  const { client } = mockClient([response({ atomic_schedulable: true, atomic_protection: true })]);
  assert.deepEqual(await client.importCapabilities(), { atomicSchedulable: true, atomicProtection: true });
  for (const value of ['true', 0, null]) {
    const { client: invalid } = mockClient([response({ atomic_protection: value })]);
    await assert.rejects(invalid.importCapabilities(), { code: 'sub2_invalid_response' });
  }
});

test('explicit protection false uses top-level creation contract and verifies persisted flag through read-back', async () => {
  const options = normalizeImportOptions();
  const complete = importedAccount(options);
  const incomplete = structuredClone(complete); delete incomplete.extra.anti_degradation;
  const { client, calls } = mockClient([response(incomplete, { status: 201 }), response(complete)]);
  const result = await createImported(client, options);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.anti_degradation, false);
  assert.equal(calls[0].body.extra.anti_degradation, undefined);
  assert.equal(calls[0].body.extra.codex_fingerprint_mode, 'device');
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(accountMatchesImportOptions(result, options), true);
});

test('persisted pre-protection job creation keeps old request body and idempotency semantics', async () => {
  const legacy = normalizeImportOptions(); delete legacy.accountProtection;
  const remote = importedAccount(legacy); delete remote.extra.anti_degradation;
  const { client, calls } = mockClient([response(remote, { status: 201 })]);
  await createImported(client, legacy);
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0].body, 'anti_degradation'), false);
});
