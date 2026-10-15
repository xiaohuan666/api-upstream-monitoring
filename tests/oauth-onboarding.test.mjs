import { createOAuthCredentialVault } from '../src/oauth-credential-vault.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loginOpenAI } from '../src/oauth-login.mjs';
import { createOAuthOnboardingService } from '../src/oauth-onboarding.mjs';
import { onboardingError } from '../src/oauth-onboarding-store.mjs';

const SITE = '11111111-1111-4111-8111-111111111111';
const PROXY = '22222222-2222-4222-8222-222222222222';
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const INPUT = { mySiteId: SITE, email: 'User@example.com', password: ' password with spaces ', totpSecret: SECRET, proxyId: PROXY, groupIds: [2, 1] };

function memoryStore() {
  const jobs = new Map();
  return {
    jobs, async expireStale() {}, async get(id) { return jobs.get(id) ?? null; }, async list() { return [...jobs.values()].reverse(); },
    async create(input) {
      const previous = jobs.get(input.id);
      if (previous) return { job: previous, created: false };
      if ([...jobs.values()].some((job) => job.email === input.email && job.mySiteId === input.mySiteId && ['queued', 'running', 'pushing', 'uncertain'].includes(job.status))) {
        throw onboardingError('ACCOUNT_BUSY', 'busy', 409);
      }
      const job = { ...input, status: 'queued', stage: 'validating', remoteProxyId: null, remoteAccountId: null, message: '', errorCode: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      jobs.set(job.id, job);
      return { job, created: true };
    },
    async update(id, owner, patch) { const job = { ...jobs.get(id), ...patch }; jobs.set(id, job); return job; },
    async heartbeat() { return true; }, async withProxyLock(_site, _proxy, fn) { return fn(); },
    async reconcileSuccess(id, remoteAccountId) { return this.update(id, null, { status: 'succeeded', stage: 'done', remoteAccountId }); },
  };
}

function fixture(options = {}) {
  const store = memoryStore();
  const logs = [];
  const calls = [];
  const proxy = { id: PROXY, name: 'test proxy', protocol: 'http', host: 'proxy.example.test', port: 8080, username: 'proxy-user', password: 'proxy-secret', status: 'active', expiresAt: null };
  const site = { id: SITE, name: 'production-target', type: 'sub2api', url: 'https://sub2.example.test', adminKey: 'admin-secret' };
  const ctx = { store, proxy, site, logs, calls, accounts: [], groups: [{ id: 1, platform: 'openai', status: 'active' }, { id: 2, platform: 'openai', status: 'active' }], links: [], remoteProxy: { ...proxy, id: 51 } };
  const client = {
    async importCapabilities() { return { atomicProtection: true, atomicSchedulable: true }; },
    async listGroups() { return ctx.groups; },
    async listAccounts({ email } = {}) {
      // Mirror the real client's email-filtered candidate API: redacted metadata has no JWT fallback.
      return email ? ctx.accounts.filter((account) => [account.name, account.email, account.credentials?.email, account.extra?.email]
        .some((value) => typeof value === 'string' && value.trim().toLowerCase() === email)) : ctx.accounts;
    },
    async listProxies() { calls.push(['listProxies']); return options.adopt ? [ctx.remoteProxy] : []; },
    async getProxy(id) { calls.push(['getProxy', id]); return ctx.remoteProxy; },
    async createProxy(value, key) { calls.push(['createProxy', value, key]); return ctx.remoteProxy; },
    async generateAuthUrl(value) { calls.push(['generateAuthUrl', value]); return { authUrl: 'https://auth.openai.com/oauth/authorize', sessionId: 'session-test' }; },
    async exchangeCode(value) {
      calls.push(['exchangeCode', value]);
      return { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: Math.floor(Date.now() / 1000) + 3600, email: 'user@example.com', chatgpt_account_id: 'account-id', chatgpt_user_id: 'user-id', ...options.tokenInfo };
    },
    async createOAuthAccount(value, key) {
      calls.push(['createOAuthAccount', value, key]);
      if (options.createError) throw options.createError;
      return { id: 99, name: value.name, platform: 'openai', type: 'oauth', credentials: { ...value.credentials, model_mapping: Object.fromEntries(value.importOptions.models.map(m => [m,m])) },
        proxy_id: value.proxyId, group_ids: value.groupIds, concurrency: value.importOptions.concurrency,
        auto_pause_on_expired: value.importOptions.autoPauseOnExpired, load_factor: value.importOptions.loadFactor,
        priority: value.importOptions.priority, rate_multiplier: value.importOptions.rateMultiplier,
        schedulable: value.importOptions.schedulable, extra: { anti_degradation: false,
          oauth_onboarding_creation_key: value.creationKey, codex_fingerprint_mode: value.importOptions.fingerprintMode,
          openai_oauth_responses_websockets_v2_mode: value.importOptions.wsMode, openai_oauth_responses_websockets_v2_enabled: value.importOptions.wsMode !== 'off', codex_fingerprint_device_id: 'fresh-device' } };
    },
  };
  const service = createOAuthOnboardingService({
    credentialVault: createOAuthCredentialVault({ key: Buffer.alloc(32, 7).toString('base64') }),
    store, logger: { info(...args) { logs.push(args); }, warn(...args) { logs.push(args); } },
    mySiteRepository: { async listMySites() { return [site]; }, async getMySiteById() { return site; } },
    proxyRepository: { async listProxies() { return [proxy]; }, async getProxyById() { return proxy; } },
    mySiteProxyRepository: { async listLinks() { return ctx.links; }, async createLink(value) { calls.push(['createLink', value]); ctx.links.push(value); } },
    clientFactory: () => client,
    login: options.login ?? (async (value) => { calls.push(['login', value]); await value.onStage('totp'); return { code: 'oauth-code-secret', state: 'state-test', redirectUri: 'http://localhost:1455/auth/callback' }; }),
    ...options.serviceOptions,
  });
  return { ...ctx, ctx, service, client };
}

function applyRemoteOptions(account, options) {
  Object.assign(account, { concurrency: options.concurrency, priority: options.priority, rate_multiplier: options.rateMultiplier,
    load_factor: options.loadFactor, schedulable: options.schedulable, auto_pause_on_expired: options.autoPauseOnExpired });
  account.credentials.model_mapping = Object.fromEntries(options.models.map(m => [m,m]));
  Object.assign(account.extra, { anti_degradation: false, codex_fingerprint_mode: options.fingerprintMode,
    openai_oauth_responses_websockets_v2_mode: options.wsMode, openai_oauth_responses_websockets_v2_enabled: options.wsMode !== 'off' });
}

async function run(f, input = {}) {
  const job = await f.service.submit({ ...INPUT, requestId: randomUUID(), ...input });
  await f.service.waitForIdle();
  return f.service.get(job.id);
}

test('one OAuth account uses selected proxy and all groups, without persisting secrets', async () => {
  const f = fixture();
  const result = await run(f);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.remoteAccountId, 99);
  const create = f.calls.find(([name]) => name === 'createOAuthAccount');
  assert.deepEqual(create[1].groupIds, [1, 2]);
  assert.equal(create[1].proxyId, 51);
  assert.equal(create[1].credentials.refresh_token, 'refresh-secret');
  assert.equal(create[2].idempotencyKey, `oauth-account-${result.id}`);
  assert.equal(f.calls.find(([name]) => name === 'login')[1].password, INPUT.password);
  assert.equal(f.calls.find(([name]) => name === 'exchangeCode')[1].proxyId, 51);
  const exposed = JSON.stringify([await f.service.options(), await f.service.list(), [...f.store.jobs.values()], f.logs]);
  for (const secret of [INPUT.password, SECRET, 'admin-secret', 'proxy-secret', 'refresh-secret', 'access-secret', 'oauth-code-secret']) assert.ok(!exposed.includes(secret), secret);
});

test('same request ID replays result, ignores new credentials, conflicts on changed options', async () => {
  const f = fixture();
  const requestId = randomUUID();
  const first = await run(f, { requestId });
  const replay = await f.service.submit({ ...INPUT, password: undefined, totpSecret: undefined, requestId });
  assert.equal(replay.id, first.id);
  assert.equal(replay.status, 'succeeded');
  assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 1);
  await assert.rejects(f.service.submit({ ...INPUT, requestId, groupIds: [1] }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('concurrent submissions for same identity cannot create two accounts', async () => {
  let finish;
  const f = fixture({ login: async () => new Promise((resolve) => { finish = resolve; }) });
  await f.service.submit({ ...INPUT, requestId: randomUUID() });
  await assert.rejects(f.service.submit({ ...INPUT, requestId: randomUUID() }), { code: 'ACCOUNT_BUSY' });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  finish({ code: 'x', state: 's' });
  await f.service.waitForIdle();
  assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 1);
});

test('adopts exact proxy without mutating existing remote proxy', async () => {
  const f = fixture({ adopt: true });
  const job = await run(f);
  assert.equal(job.status, 'succeeded');
  assert.equal(f.calls.filter(([name]) => name === 'createProxy').length, 0);
  assert.equal(f.calls.filter(([name]) => name === 'createLink').length, 1);
});

test('existing mapping must match protocol, authentication and active status', async () => {
  for (const change of [{ protocol: 'socks5' }, { password: 'different' }, { status: 'inactive' }]) {
    const f = fixture();
    f.ctx.links.push({ myProxyId: '51' });
    Object.assign(f.ctx.remoteProxy, change);
    const job = await run(f);
    assert.equal(job.errorCode, 'PROXY_MAPPING_STALE');
    assert.equal(f.calls.filter(([name]) => name === 'login').length, 0);
  }
});

test('existing remote email permits a new explicit import without overwriting the old account', async () => {
  const f = fixture();
  f.ctx.accounts.push({ id: 1, name: 'different-name', platform: 'openai', type: 'oauth', credentials: { email: 'USER@example.com' } });
  const job = await run(f);
  assert.equal(job.status, 'succeeded');
  assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 1);
  assert.equal(f.ctx.accounts[0].name, 'different-name');
});

test('invalid/disabled/non-OpenAI groups fail before login; empty groups rejected at admission', async () => {
  const f = fixture();
  f.ctx.groups[0].platform = 'anthropic';
  await assert.rejects(run(f), { code: 'GROUP_UNAVAILABLE' });
  assert.equal(f.store.jobs.size, 0);
  await assert.rejects(run(f, { groupIds: [] }), { code: 'INVALID_GROUPS' });
  assert.equal(f.calls.length, 0);
});

test('token email mismatch and missing refresh token never create a remote account', async () => {
  for (const tokenInfo of [{ email: 'someone@example.com' }, { refresh_token: '' }]) {
    const f = fixture({ tokenInfo });
    const job = await run(f);
    assert.equal(job.status, 'failed');
    assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 0);
  }
});

test('direct connection has null proxy consistently, never touches mappings', async () => {
  const f = fixture();
  const job = await run(f, { proxyId: null });
  assert.equal(job.status, 'succeeded');
  for (const [name, value] of f.calls) {
    if (['generateAuthUrl', 'exchangeCode', 'createOAuthAccount'].includes(name)) assert.equal(value.proxyId, null);
  }
  assert.equal(f.calls.filter(([name]) => /Proxy|Link/.test(name)).length, 0);
});

test('ambiguous write remains locked until an exact read-only reconciliation succeeds', async () => {
  const error = Object.assign(onboardingError('UPSTREAM_TIMEOUT', '超时', 502), { ambiguous: true });
  const f = fixture({ createError: error });
  const job = await run(f);
  assert.equal(job.status, 'uncertain');
  await assert.rejects(run(f), { code: 'ACCOUNT_BUSY' });
  await assert.rejects(f.service.reconcile(job.id), { code: 'RECONCILE_UNRESOLVED' });
  const account = { id: 99, name: job.email, extra: { oauth_onboarding_creation_key: `oauth-account-${job.id}` }, platform: 'openai', type: 'oauth', proxy_id: 51, group_ids: [1],
    credentials: { email: job.email, chatgpt_account_id: 'account-id', chatgpt_user_id: 'user-id' } };
  applyRemoteOptions(account, job.importOptions);
  f.ctx.accounts.push(account);
  await assert.rejects(f.service.reconcile(job.id), { code: 'RECONCILE_UNRESOLVED' });
  account.group_ids = [2, 1];
  const resolved = await f.service.reconcile(job.id);
  assert.equal(resolved.status, 'succeeded');
  assert.equal(resolved.remoteAccountId, 99);
  assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 1);
});

test('known rejected write is failed, not uncertain, and raw external errors are never exposed', async () => {
  const f = fixture({ createError: Object.assign(onboardingError('GROUP_CONFLICT', '分组存在混合渠道风险', 409), { ambiguous: false }) });
  assert.equal((await run(f)).status, 'failed');
  const g = fixture({ login: async () => { throw new Error('password=TOP_SECRET_PROXY'); } });
  const job = await run(g);
  assert.equal(job.errorCode, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify([job, g.logs]).includes('TOP_SECRET_PROXY'));
});

test('manual verification stops cleanly and does not push partial credentials', async () => {
  const f = fixture({ login: async () => { throw Object.assign(onboardingError('EMAIL_OTP_REQUIRED', '需要人工邮箱验证码'), { needsAttention: true }); } });
  assert.equal((await run(f)).status, 'needs_attention');
  assert.equal(f.calls.filter(([name]) => name === 'exchangeCode').length, 0);
});

test('changed group configuration after login prevents push', async () => {
  const f = fixture();
  f.client.exchangeCode = async () => {
    f.ctx.groups[0].status = 'inactive';
    return { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, email: INPUT.email.toLowerCase(), chatgpt_account_id: 'account-id', chatgpt_user_id: 'user-id' };
  };
  assert.equal((await run(f)).errorCode, 'GROUP_UNAVAILABLE');
  assert.equal(f.store.jobs.size, 1);
  assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 0);
});

test('graceful close aborts browser work and rejects new submissions', async () => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = fixture({ login: async ({ signal }) => new Promise((_, reject) => {
    entered();
    signal.addEventListener('abort', () => reject(onboardingError('TASK_INTERRUPTED', '任务中断')), { once: true });
  }) });
  const job = await f.service.submit({ ...INPUT, requestId: randomUUID() });
  await started;
  await f.service.close();
  assert.equal((await f.service.get(job.id)).status, 'needs_attention');
  await assert.rejects(f.service.submit({ ...INPUT, requestId: randomUUID() }), { code: 'SHUTTING_DOWN' });
});


test('HTTP worker accepts authenticated SOCKS5 and preserves the proxy through exchange and push', async () => {
  const f = fixture();
  f.ctx.proxy.protocol = 'socks5';
  f.ctx.remoteProxy.protocol = 'socks5';
  const job = await run(f);
  assert.equal(job.status, 'succeeded');
  assert.equal(f.calls.find(([name]) => name === 'createProxy')[1].protocol, 'socks5');
  assert.equal(f.calls.find(([name]) => name === 'exchangeCode')[1].proxyId, 51);
  assert.equal(f.calls.find(([name]) => name === 'createOAuthAccount')[1].proxyId, 51);
});


test('existing remote workspace/user identity also permits a new explicit import', async () => {
  const f = fixture();
  f.ctx.accounts.push({ id: 71, name: '自定义名称', platform: 'openai', type: 'oauth', extra: {},
    credentials: { chatgpt_account_id: 'account-id', chatgpt_user_id: 'user-id' } });
  const job = await run(f);
  assert.equal(job.status, 'succeeded');
  assert.equal(f.calls.filter(([name]) => name === 'exchangeCode').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 1);
});

test('other remote seats and incomplete historical identities do not block explicit repeat imports', async () => {
  const allowed = fixture();
  allowed.ctx.accounts.push({ id: 71, name: 'another seat', platform: 'openai', type: 'oauth',
    credentials: { chatgpt_account_id: 'account-id', chatgpt_user_id: 'other-user' } });
  assert.equal((await run(allowed)).status, 'succeeded');
  for (const credentials of [{}, { chatgpt_account_id: 'account-id' }, { chatgpt_user_id: 'user-id' }]) {
    const f = fixture();
    f.ctx.accounts.push({ id: 71, name: 'unknown seat', platform: 'openai', type: 'oauth', credentials });
    assert.equal((await run(f)).status, 'succeeded');
    assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 1);
  }
});

test('incomplete token identity never enters pushing and never creates an account', async () => {
  const f = fixture({ tokenInfo: { chatgpt_user_id: undefined } });
  const job = await run(f);
  assert.equal(job.errorCode, 'invalid_identity');
  assert.equal(job.status, 'failed');
  assert.ok(!f.logs.some(([, event]) => event.status === 'pushing'));
  assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 0);
});

test('reconciliation requires consistent authoritative email and the persisted seat, never a display name', async () => {
  const f = fixture({ createError: Object.assign(onboardingError('UPSTREAM_TIMEOUT', '超时', 502), { ambiguous: true }) });
  const job = await run(f);
  const account = { id: 99, name: job.email, extra: { oauth_onboarding_creation_key: `oauth-account-${job.id}` }, platform: 'openai', type: 'oauth', proxy_id: 51, group_ids: [1, 2],
    credentials: { email: 'different@example.test', chatgpt_account_id: 'account-id', chatgpt_user_id: 'user-id' } };
  applyRemoteOptions(account, job.importOptions);
  f.ctx.accounts.push(account);
  await assert.rejects(f.service.reconcile(job.id), { code: 'RECONCILE_UNRESOLVED' });
  delete account.credentials.email;
  await assert.rejects(f.service.reconcile(job.id), { code: 'RECONCILE_UNRESOLVED' });
  account.credentials.email = job.email;
  account.credentials.chatgpt_user_id = 'other-user';
  await assert.rejects(f.service.reconcile(job.id), { code: 'RECONCILE_UNRESOLVED' });
  account.credentials.chatgpt_user_id = 'user-id';
  account.extra = { ...account.extra, oauth_onboarding_creation_key: `oauth-account-${job.id}`, email: 'conflicting@example.test' };
  await assert.rejects(f.service.reconcile(job.id), { code: 'RECONCILE_UNRESOLVED' });
  account.extra.email = job.email;
  account.name = '改名不影响身份验证';
  assert.equal((await f.service.reconcile(job.id)).status, 'succeeded');
});


test('real Python workspace failure classifications persist at consent, log only code and prevent exchange/push', async () => {
  for (const [mode, code] of Object.entries({ missing: 'OAUTH_WORKSPACE_NOT_FOUND', multiple: 'OAUTH_WORKSPACE_AMBIGUOUS',
    'multiple-teams': 'OAUTH_WORKSPACE_AMBIGUOUS', 'multiple-nonpersonal': 'OAUTH_WORKSPACE_AMBIGUOUS',
    unclassified: 'OAUTH_WORKSPACE_AMBIGUOUS', 'missing-label': 'OAUTH_WORKSPACE_AMBIGUOUS',
    conflict: 'OAUTH_WORKSPACE_CONFLICT', 'pointer-conflict': 'OAUTH_WORKSPACE_CONFLICT',
    'type-conflict': 'OAUTH_WORKSPACE_CONFLICT', invalid: 'OAUTH_WORKSPACE_INVALID',
    'kind-raw-conflict-web': 'OAUTH_WORKSPACE_CONFLICT', 'kind-raw-conflict-html': 'OAUTH_WORKSPACE_CONFLICT',
    'kind-type-conflict-web': 'OAUTH_WORKSPACE_CONFLICT', 'kind-type-source-conflict-web': 'OAUTH_WORKSPACE_CONFLICT',
    'unknown-kind-web': 'OAUTH_WORKSPACE_INVALID', 'nonstring-kind-web': 'OAUTH_WORKSPACE_INVALID',
    'null-kind-web': 'OAUTH_WORKSPACE_INVALID', 'null-kind-html': 'OAUTH_WORKSPACE_INVALID',
    'null-kind-cookie-web': 'OAUTH_WORKSPACE_INVALID',
    'mixed-script': 'OAUTH_WORKSPACE_INVALID', 'http-duplicate': 'OAUTH_WORKSPACE_INVALID',
    'cookie-corrupt': 'OAUTH_WORKSPACE_INVALID', 'cookie-nonutf8': 'OAUTH_WORKSPACE_INVALID', 'cookie-null': 'OAUTH_WORKSPACE_INVALID' })) {
    const f = fixture({ login: async (options) => {
      const authUrl = `https://auth.openai.com/oauth/authorize?${new URLSearchParams({ response_type: 'code', state: 'sub2-state',
        redirect_uri: 'http://localhost:1455/auth/callback', workspace_fixture: mode })}`;
      return loginOpenAI({ ...options, email: 'fixture@example.test', authUrl,
        spawnWorker(command, args, spawnOptions) {
          return spawn(command, [args[0], fileURLToPath(new URL('./fixtures/oauth-http-flow.py', import.meta.url))], spawnOptions);
        } });
    } });
    const job = await run(f, { proxyId: null });
    assert.equal(job.status, 'needs_attention');
    assert.equal(job.stage, mode === 'http-duplicate' ? 'authorizing' : 'consent');
    assert.equal(job.errorCode, code);
    if (code === 'OAUTH_WORKSPACE_AMBIGUOUS') {
      assert.equal(job.message, '检测到多个工作空间，未自动选择，未推送账号');
    }
    assert.deepEqual(f.logs.filter(([, details]) => details.code), [['[oauth-onboarding]', { jobId: job.id, code, attempt: 1 }]]);
    assert.equal(f.calls.filter(([name]) => ['exchangeCode', 'createOAuthAccount'].includes(name)).length, 0);
    const exposed = JSON.stringify([job, f.logs]);
    for (const secret of [INPUT.password, SECRET, 'workspace-one', 'workspace-two', 'workspace-personal', 'workspace-team',
      'workspace-team-other', 'fixture-personal-renamed', 'fixture-team-private', 'fixture-other-private',
      'fixture-kind-team-private', 'fixture-kind-personal-private', 'fixture-kind-unknown-private',
      'fixture-kind-invalid-private', 'web-code', 'target-code', 'web-only-token']) assert.ok(!exposed.includes(secret));
  }
});


for (const mode of ['kind-web-team', 'kind-type-web-team']) {
  test(`real Python first-Web kind selection passes the original callback to exchange and creates once: ${mode}`, async () => {
    const stages = [];
    const f = fixture({ login: async (options) => {
      const authUrl = `https://auth.openai.com/oauth/authorize?${new URLSearchParams({ client_id: 'sub2-client',
        response_type: 'code', state: 'sub2-state', redirect_uri: 'http://localhost:1455/auth/callback',
        code_challenge: 'original-pkce', code_challenge_method: 'S256', workspace_fixture: mode })}`;
      return loginOpenAI({ ...options, email: 'fixture@example.test', authUrl,
        onStage: async (stage) => { stages.push(stage); await options.onStage(stage); },
        spawnWorker(command, args, spawnOptions) {
          return spawn(command, [args[0], fileURLToPath(new URL('./fixtures/oauth-http-flow.py', import.meta.url))], spawnOptions);
        } });
    } });
    const job = await run(f, { proxyId: null });
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(stages, ['warmup', 'csrf', 'authorizing', 'email', 'password', 'totp', 'consent', 'authorizing']);
    const exchanges = f.calls.filter(([name]) => name === 'exchangeCode');
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0][1].code, 'target-code');
    assert.equal(exchanges[0][1].state, 'sub2-state');
    assert.equal(exchanges[0][1].redirectUri, 'http://localhost:1455/auth/callback');
    assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 1);
    const exposed = JSON.stringify([job, f.logs, [...f.store.jobs.values()]]);
    for (const secret of [INPUT.password, SECRET, 'workspace-personal', 'workspace-team',
      'fixture-kind-team-private', 'fixture-kind-personal-private', 'web-code', 'target-code',
      'web-only-token', 'access-secret', 'refresh-secret']) assert.ok(!exposed.includes(secret));
  });
}

const httpChallenge = () => Object.assign(onboardingError('OAUTH_HTTP_CHALLENGE', '上游访问挑战', 422), { needsAttention: true });

function retryFixture(options = {}) {
  let attempts = 0;
  const sessions = [];
  const f = fixture({
    login: async (input) => {
      attempts += 1;
      f.calls.push(['login-attempt', { authUrl: input.authUrl, proxyId: input.proxy?.id }]);
      assert.equal(input.password, INPUT.password); assert.equal(input.totpSecret, SECRET);
      await input.onStage('authorizing');
      if (attempts === 1 || options.alwaysChallenge) throw httpChallenge();
      return { code: 'new-code', state: 'new-state', redirectUri: 'http://localhost:1455/auth/callback' };
    },
    serviceOptions: { retryWait: async () => {}, ...options.serviceOptions },
  });
  f.client.generateAuthUrl = async () => {
    const sessionId = `new-session-${sessions.length + 1}`;
    sessions.push(sessionId);
    return { sessionId, authUrl: `https://auth.openai.com/oauth/authorize?session=${sessionId}` };
  };
  return Object.assign(f, { sessions, attempts: () => attempts });
}

test('challenge retry keeps a single job and repeats preparation, but exchanges and pushes only once with the new session', async () => {
  const f = retryFixture();
  const updates = [];
  const update = f.store.update.bind(f.store);
  f.store.update = async (...args) => { updates.push(args[2]); return update(...args); };
  const job = await run(f);
  assert.equal(job.status, 'succeeded'); assert.match(job.message, /自动重试一次后成功/);
  assert.equal(f.store.jobs.size, 1); assert.equal(f.attempts(), 2);
  assert.deepEqual(f.sessions, ['new-session-1', 'new-session-2']);
  assert.equal(updates.filter(p => p.stage === 'validating').length, 2);
  assert.equal(updates.filter(p => p.stage === 'retry_wait').length, 1);
  assert.ok(!updates.some(p => ['failed', 'needs_attention'].includes(p.status)));
  const exchanges = f.calls.filter(([name]) => name === 'exchangeCode');
  assert.equal(exchanges.length, 1); assert.equal(exchanges[0][1].sessionId, 'new-session-2');
  const pushes = f.calls.filter(([name]) => name === 'createOAuthAccount');
  assert.equal(pushes.length, 1); assert.equal(pushes[0][2].idempotencyKey, `oauth-account-${job.id}`);
  assert.equal(f.calls.filter(([name]) => name === 'createProxy').length, 1);
  assert.ok(!JSON.stringify([job, f.logs, [...f.store.jobs.values()]]).includes(INPUT.password));
});

test('two challenges terminate the original job with an explicit exhausted-retry message and no exchange/write', async () => {
  const f = retryFixture({ alwaysChallenge: true });
  const job = await run(f);
  assert.equal(job.status, 'needs_attention'); assert.equal(job.errorCode, 'OAUTH_HTTP_CHALLENGE');
  assert.match(job.message, /已自动重试一次/); assert.equal(f.attempts(), 2);
  assert.equal(f.store.jobs.size, 1);
  assert.equal(f.calls.filter(([name]) => ['exchangeCode', 'createOAuthAccount'].includes(name)).length, 0);
});

for (const change of ['proxy', 'groups', 'target']) {
  test(`configuration drift in ${change} during the wait stops before a second authorization transaction`, async () => {
    const f = retryFixture({ serviceOptions: { retryWait: async () => {
      if (change === 'proxy') f.proxy.host = 'changed.invalid';
      if (change === 'groups') f.ctx.groups = [];
      if (change === 'target') f.site.url = 'https://changed.invalid';
    } } });
    const job = await run(f);
    assert.notEqual(job.status, 'succeeded'); assert.equal(f.sessions.length, 1); assert.equal(f.attempts(), 1);
    assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 0);
  });
}

test('closing during retry wait cancels, retains account lock until completion and never starts a new login', async () => {
  let waiting;
  const reachedWait = new Promise(resolve => { waiting = resolve; });
  const f = retryFixture({ serviceOptions: { retryWait: async (_ms, signal) => {
    waiting(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } } });
  const accepted = await f.service.submit({ ...INPUT, requestId: randomUUID() });
  await reachedWait;
  assert.equal((await f.service.get(accepted.id)).status, 'running');
  await assert.rejects(f.service.submit({ ...INPUT, requestId: randomUUID() }), { code: 'ACCOUNT_BUSY' });
  await f.service.close();
  const job = await f.service.get(accepted.id);
  assert.equal(job.errorCode, 'TASK_INTERRUPTED'); assert.equal(f.attempts(), 1); assert.equal(f.sessions.length, 1);
});

test('a lost lease before second preparation prevents both auth generation and login', async () => {
  const f = retryFixture({ serviceOptions: { retryWait: async () => {
    const update = f.store.update.bind(f.store);
    f.store.update = async (id, owner, patch) => {
      if (patch.status === 'running') throw onboardingError('LEASE_LOST', '任务租约已失效', 409);
      return update(id, owner, patch);
    };
  } } });
  const job = await run(f);
  assert.equal(job.errorCode, 'LEASE_LOST'); assert.equal(f.sessions.length, 1); assert.equal(f.attempts(), 1);
});

test('a challenge-labelled token exchange failure must not re-enter login', async () => {
  const f = retryFixture();
  f.client.exchangeCode = async () => { f.calls.push(['exchange-failed']); throw httpChallenge(); };
  const job = await run(f);
  assert.equal(job.errorCode, 'OAUTH_HTTP_CHALLENGE'); assert.equal(f.attempts(), 2); assert.equal(f.sessions.length, 2);
  assert.equal(f.calls.filter(([name]) => name === 'exchange-failed').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 0);
});

test('challenge-labelled auth-url preparation failure is not a login retry', async () => {
  const f = retryFixture(); let calls = 0;
  f.client.generateAuthUrl = async () => { calls += 1; throw httpChallenge(); };
  const job = await run(f);
  assert.equal(job.errorCode, 'OAUTH_HTTP_CHALLENGE'); assert.equal(f.attempts(), 0); assert.equal(calls, 1);
});

test('real Python challenge starts a new worker and fresh warmup before a single exchange with the second session', async () => {
  let spawned = 0; let prepared = 0; const stages = []; const children = [];
  const f = fixture({ serviceOptions: { retryWait: async () => {
    assert.ok(children[0].exitCode !== null || children[0].signalCode !== null, 'old worker is reaped before retry');
  } }, login: async options => loginOpenAI({ ...options, email: 'fixture@example.test',
    onStage: async stage => { stages.push([spawned, stage]); await options.onStage(stage); },
    spawnWorker(command, args, spawnOptions) {
      spawned++;
      const child = spawn(command, [args[0], fileURLToPath(new URL('./fixtures/oauth-http-flow.py', import.meta.url))], spawnOptions);
      children.push(child); return child;
    },
  }) });
  f.client.generateAuthUrl = async () => {
    prepared++;
    return { sessionId: `fresh-session-${prepared}`, authUrl: `https://auth.openai.com/oauth/authorize?${new URLSearchParams({
      response_type: 'code', state: 'sub2-state', redirect_uri: 'http://localhost:1455/auth/callback',
      workspace_fixture: prepared === 1 ? 'challenge-authorize' : '',
    })}` };
  };
  const job = await run(f, { proxyId: null });
  assert.equal(job.status, 'succeeded'); assert.equal(spawned, 2); assert.equal(f.store.jobs.size, 1);
  assert.deepEqual(stages.filter(([, stage]) => stage === 'warmup'), [[1, 'warmup'], [2, 'warmup']]);
  assert.equal(f.calls.find(([name]) => name === 'exchangeCode')[1].sessionId, 'fresh-session-2');
  assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, 1);
  const challenge = f.logs.find(([, event]) => event.code === 'OAUTH_HTTP_CHALLENGE')[1];
  assert.deepEqual(challenge.challenge, { endpoint: 'authorize', status: 403 });
  for (const secret of ['UPSTREAM-PRIVATE-BODY', 'sub2-state', INPUT.password, SECRET]) assert.ok(!JSON.stringify(f.logs).includes(secret));
});

test('ambiguous push after a successful retry stays uncertain and is never automatically repeated', async () => {
  const f = retryFixture(); let pushes = 0;
  f.client.createOAuthAccount = async () => { pushes++; throw httpChallenge(); };
  const job = await run(f);
  assert.equal(job.status, 'uncertain'); assert.equal(job.errorCode, 'WRITE_UNCERTAIN');
  assert.equal(pushes, 1); assert.equal(f.attempts(), 2); assert.equal(f.sessions.length, 2);
  assert.match(job.message, /先对账/); assert.match(job.message, /已自动重试一次/);
});

test('heartbeat loss while waiting aborts the retry before a second transaction', async () => {
  const f = retryFixture({ serviceOptions: { heartbeatMs: 5, retryWait: async (_ms, signal) => {
    f.store.heartbeat = async () => false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('heartbeat failed to cancel retry')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  } } });
  const job = await run(f);
  assert.equal(job.errorCode, 'TASK_INTERRUPTED'); assert.equal(f.attempts(), 1); assert.equal(f.sessions.length, 1);
});

for (const [mode, expected] of [
  ['help-link', 'succeeded'], ['manual-widget', 'OAUTH_VERIFICATION_REQUIRED'], ['bad-password-widget', 'OAUTH_INVALID_CREDENTIALS'],
]) {
  test(`real Python ${mode} is never mistaken for a retryable access challenge`, async () => {
    let spawned = 0; let prepared = 0;
    const f = fixture({ serviceOptions: { retryWait: async () => assert.fail('must not enter automatic retry') },
      login: options => loginOpenAI({ ...options, email: 'fixture@example.test',
        spawnWorker(command, args, spawnOptions) {
          spawned++;
          return spawn(command, [args[0], fileURLToPath(new URL('./fixtures/oauth-http-flow.py', import.meta.url))], spawnOptions);
        },
      }),
    });
    f.client.generateAuthUrl = async () => {
      prepared++;
      return { sessionId: 'original-only-session', authUrl: `https://auth.openai.com/oauth/authorize?${new URLSearchParams({
        response_type: 'code', state: 'sub2-state', redirect_uri: 'http://localhost:1455/auth/callback', workspace_fixture: mode,
      })}` };
    };
    const job = await run(f, { proxyId: null });
    assert.equal(expected === 'succeeded' ? job.status : job.errorCode, expected);
    assert.equal(prepared, 1); assert.equal(spawned, 1); assert.equal(f.store.jobs.size, 1);
    assert.equal(f.logs.filter(([, event]) => event.code === 'OAUTH_HTTP_CHALLENGE').length, 0);
    assert.equal(f.calls.filter(([name]) => name === 'createOAuthAccount').length, expected === 'succeeded' ? 1 : 0);
  });
}
