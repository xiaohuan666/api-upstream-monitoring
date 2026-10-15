import { createOAuthCredentialVault } from '../src/oauth-credential-vault.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createOAuthOnboardingTables, createOAuthOnboardingStore, onboardingFingerprint } from '../src/oauth-onboarding-store.mjs';
import { createOAuthOnboardingService } from '../src/oauth-onboarding.mjs';
import { defaultImportOptions } from '../src/oauth-import-options.mjs';
import { createMySitesTables, createMySiteProxyRepository } from '../src/my-sites.mjs';

const connectionString = process.env.OAUTH_ONBOARDING_TEST_DATABASE_URL;
const pgtest = (name, fn) => test(name, { skip: !connectionString, timeout: 20_000 }, fn);
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const accounts = (n) => Array.from({ length: n }, (_, i) => ({ email: `batch-${i}@example.test`, password: ` test-password-${i} `, totpSecret: SECRET }));
async function fixture(t, overrides = {}) {
  const admin = new Pool({ connectionString });
  const schema = `batch_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public`, ...overrides.poolOptions });
  await createOAuthOnboardingTables(pool);
  const store = createOAuthOnboardingStore(pool, overrides.storeOptions);
  if (overrides.concurrency) await store.saveExecutionSettings({ concurrency: overrides.concurrency });
  const site = { id: randomUUID(), name: 'test', type: 'sub2api', url: 'https://sub.example.test/', adminKey: 'test-admin-key' };
  const ctx = { pool, store, site, accounts: [], pushes: [], logs: [], current: 0, peak: 0, loginCount: 0 };
  const client = {
    async listGroups() { return [{ id: 1, name: 'test', platform: 'openai', status: 'active' }]; },
    async importCapabilities() { return { atomicSchedulable: overrides.capable !== false, atomicProtection: overrides.protectionCapable !== false }; },
    async listAccounts() { return ctx.accounts; },
    async generateAuthUrl() { return { authUrl: 'https://auth.example.test/', sessionId: 'test' }; },
    async exchangeCode({ code }) { return { access_token: 'test-access', refresh_token: 'test-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600, email: code, chatgpt_account_id: `workspace-${code}`, chatgpt_user_id: `user-${code}` }; },
    async createOAuthAccount(input) {
      ctx.pushes.push(input);
      const o = input.importOptions;
      const account = { id: ctx.accounts.length + 1, platform: 'openai', type: 'oauth', name: input.name,
        credentials: { ...input.credentials, model_mapping: Object.fromEntries(o.models.map((m) => [m, m])) },
        extra: { anti_degradation: o.accountProtection, email: input.name, oauth_onboarding_creation_key: input.creationKey, codex_fingerprint_mode: o.fingerprintMode, openai_oauth_responses_websockets_v2_mode: o.wsMode,
          openai_oauth_responses_websockets_v2_enabled: o.wsMode !== 'off' },
        group_ids: input.groupIds, proxy_id: input.proxyId, concurrency: o.concurrency, load_factor: o.loadFactor,
        priority: o.priority, rate_multiplier: o.rateMultiplier, schedulable: o.schedulable, auto_pause_on_expired: o.autoPauseOnExpired };
      if (o.planType) account.credentials.plan_type = o.planType;
      if (overrides.protectionOverwrite) { account.extra.anti_degradation = true; account.extra.codex_fingerprint_mode = 'session'; }
      ctx.accounts.push(account);
      if (overrides.lostResponse) throw new Error('response lost');
      return overrides.mismatch ? { ...account, schedulable: !o.schedulable } : account;
    },
  };
  ctx.client = client;
  const services = [];
  ctx.makeService = (changes = {}) => {
    const service = createOAuthOnboardingService({ credentialVault: createOAuthCredentialVault({ key: Buffer.alloc(32, 7).toString('base64') }), store: createOAuthOnboardingStore(pool, overrides.storeOptions),
      mySiteRepository: { async getMySiteById() { return site; } }, proxyRepository: {}, mySiteProxyRepository: {},
      clientFactory: () => client, heartbeatMs: 50,
      logger: { info(...args) { ctx.logs.push(args); }, warn(...args) { ctx.logs.push(args); } },
      async login({ email, signal }) {
        ctx.loginCount++; ctx.current++; ctx.peak = Math.max(ctx.peak, ctx.current);
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, overrides.loginDelay ?? 30);
            signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('stopped'), { safe: true, code: 'TASK_INTERRUPTED' })); }, { once: true });
            if (signal.aborted) { clearTimeout(timer); reject(new Error('stopped')); }
          });
          return { code: email, state: 'test-state', redirectUri: 'http://localhost:1455/auth/callback' };
        } finally { ctx.current--; }
      }, ...changes });
    services.push(service); return service;
  };
  ctx.service = ctx.makeService();
  ctx.input = (n = 3, extra = {}) => ({ requestId: randomUUID(), mySiteId: site.id, proxyId: null, groupIds: [1], importOptions: defaultImportOptions(), accounts: accounts(n), ...extra });
  t.after(async () => {
    await Promise.all(services.map((s) => s.close()));
    await pool.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end();
  });
  return ctx;
}

pgtest('batch accepts accounts and respects configured two-slot limit, persists options without secrets', async (t) => {
  const f = await fixture(t, { concurrency: 2 });
  const input = f.input(5); input.importOptions.schedulable = false;
  const batch = await f.service.submitBatch(input);
  assert.equal(batch.jobs.length, 5);
  await f.service.waitForIdle();
  assert.ok(f.peak <= 2);
  assert.equal(f.pushes.length, 5);
  assert.ok((await f.service.getBatch(batch.id)).jobs.every((job) => job.status === 'succeeded'));
  assert.deepEqual((await f.service.preferences(f.site.id)).preferences, { groupIds: [1], importOptions: input.importOptions });
  const dump = JSON.stringify((await f.pool.query('select row_to_json(j) as job from oauth_onboarding_jobs j')).rows)
    + JSON.stringify((await f.pool.query('select * from oauth_import_preferences')).rows) + JSON.stringify(f.logs);
  for (const secret of ['test-password', SECRET, 'test-access', 'test-refresh']) assert.equal(dump.includes(secret), false);
});

pgtest('batch replay is stable, option changes conflict, and lookup returns every member beyond recent list', async (t) => {
  const f = await fixture(t);
  const input = f.input(3);
  const [first, replay] = await Promise.all([f.service.submitBatch(input), f.service.submitBatch(input)]);
  assert.deepEqual(first.jobs.map((j) => j.id).sort(), replay.jobs.map((j) => j.id).sort());
  await assert.rejects(f.service.submitBatch({ ...input, importOptions: { ...input.importOptions, concurrency: 2 } }), { code: 'IDEMPOTENCY_CONFLICT' });
  await f.service.waitForIdle(); assert.equal(f.pushes.length, 3);
  await f.pool.query('delete from oauth_import_preferences');
  await f.service.submitBatch(input);
  assert.equal((await f.pool.query('select count(*) from oauth_import_preferences')).rows[0].count, '0');
});

pgtest('atomic disabled scheduling is capability-gated before login, admission and preference save', async (t) => {
  const f = await fixture(t, { capable: false });
  const input = f.input(1); input.importOptions.schedulable = false;
  await assert.rejects(f.service.submitBatch(input), { code: 'ATOMIC_SCHEDULABLE_UNSUPPORTED' });
  assert.equal(f.loginCount, 0);
  assert.equal((await f.store.list()).length, 0);
  assert.equal((await f.pool.query('select count(*) from oauth_import_preferences')).rows[0].count, '0');
});

pgtest('batch validates every row, duplicates and queue bound before creating any jobs', async (t) => {
  const f = await fixture(t, { storeOptions: { maxQueued: 3 } });
  const input = f.input(3); input.accounts[2].totpSecret = 'bad';
  await assert.rejects(f.service.submitBatch(input));
  await assert.rejects(f.service.submitBatch(f.input(2, { accounts: [accounts(1)[0], accounts(1)[0]] })), { code: 'DUPLICATE_BATCH_ACCOUNT' });
  await assert.rejects(f.service.submitBatch(f.input(31)), { code: 'INVALID_BATCH' });
  await assert.rejects(f.service.submitBatch(f.input(4)), { code: 'CAPACITY' });
  assert.equal((await f.store.list()).length, 0);
  assert.equal((await f.pool.query('select count(*) from oauth_onboarding_batches')).rows[0].count, '0');
});

pgtest('separate process queues share execution slots and busy-email exclusion', async (t) => {
  const f = await fixture(t, { loginDelay: 80, concurrency: 2 }); const other = f.makeService();
  const input = f.input(3); await f.service.submitBatch(input);
  await assert.rejects(other.submitBatch({ ...input, requestId: randomUUID() }), { code: 'ACCOUNT_BUSY' });
  await other.submitBatch(f.input(3, { accounts: accounts(3).map((a) => ({ ...a, email: `other-${a.email}` })) }));
  await Promise.all([f.service.waitForIdle(), other.waitForIdle()]);
  assert.equal(f.pushes.length, 6); assert.ok(f.peak <= 2);
});

pgtest('shutdown interrupts queued credentials and active jobs without a silent requeue', async (t) => {
  const f = await fixture(t, { loginDelay: 1000 });
  const batch = await f.service.submitBatch(f.input(5));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await f.service.close();
  const jobs = (await f.service.getBatch(batch.id)).jobs;
  assert.ok(jobs.every((j) => j.status === 'needs_attention'));
  assert.equal(f.pushes.length, 0);
});

pgtest('option mismatch stays uncertain; reconciliation checks real options not just identity', async (t) => {
  const f = await fixture(t, { mismatch: true });
  const batch = await f.service.submitBatch(f.input(1)); await f.service.waitForIdle();
  const job = (await f.service.getBatch(batch.id)).jobs[0]; assert.equal(job.status, 'uncertain');
  f.accounts[0].concurrency = 999;
  await assert.rejects(f.service.reconcile(job.id), { code: 'RECONCILE_UNRESOLVED' });
  f.accounts[0].concurrency = 50;
  assert.equal((await f.service.reconcile(job.id)).status, 'succeeded');
});

pgtest('lost creation response is reconciled read-only with the persisted option snapshot', async (t) => {
  const f = await fixture(t, { lostResponse: true });
  const batch = await f.service.submitBatch(f.input(1)); await f.service.waitForIdle();
  const job = (await f.service.getBatch(batch.id)).jobs[0]; assert.equal(job.status, 'uncertain');
  assert.equal((await f.service.reconcile(job.id)).status, 'succeeded'); assert.equal(f.pushes.length, 1);
});

pgtest('preferences survive a new service and remain isolated by target; stale groups reject import', async (t) => {
  const f = await fixture(t);
  const input = f.input(1); input.importOptions.concurrency = 12;
  await f.service.submitBatch(input); await f.service.waitForIdle();
  assert.equal((await f.makeService().preferences(f.site.id)).preferences.importOptions.concurrency, 12);
  assert.deepEqual((await f.store.getImportPreferences(randomUUID())).groupIds, []);
  await assert.rejects(f.service.submitBatch(f.input(1, { groupIds: [999] })), { code: 'GROUP_UNAVAILABLE' });
  assert.equal((await f.store.getImportPreferences(f.site.id)).importOptions.concurrency, 12);
});

pgtest('queued leases renew during long waits; crash expiry remains needs_attention', async (t) => {
  const f = await fixture(t, { loginDelay: 350, concurrency: 1, storeOptions: { leaseMs: 250 } });
  const batch = await f.service.submitBatch(f.input(3));
  await f.service.waitForIdle();
  assert.ok((await f.service.getBatch(batch.id)).jobs.every((job) => job.status === 'succeeded'));
  await f.pool.query("update oauth_onboarding_jobs set status='queued',lease_until=now()-interval '1 second' where id=$1", [batch.jobs[0].id]);
  await f.store.expireStale();
  assert.equal((await f.store.get(batch.jobs[0].id)).status, 'needs_attention');
});


pgtest('unrepresentable multiplier is rejected before login, jobs and preference persistence', async (t) => {
  const f = await fixture(t);
  const input = f.input(1); input.importOptions.rateMultiplier = 1.23456;
  await assert.rejects(f.service.submitBatch(input), { code: 'INVALID_IMPORT_OPTIONS' });
  assert.equal(f.loginCount, 0); assert.equal(f.pushes.length, 0);
  assert.equal((await f.store.list()).length, 0);
  assert.equal((await f.pool.query('select count(*) from oauth_import_preferences')).rows[0].count, '0');
});

pgtest('sixty active jobs stay reachable through attention pagination and durable batch lookup', async (t) => {
  const f = await fixture(t, { loginDelay: 10000 });
  const first = await f.service.submitBatch(f.input(30));
  const second = await f.service.submitBatch(f.input(30, { accounts: accounts(30).map((a) => ({ ...a, email: `new-${a.email}` })) }));
  const page1 = await f.service.listPage({ scope: 'attention' }); assert.equal(page1.jobs.length, 30); assert.ok(page1.nextCursor);
  const page2 = await f.service.listPage({ scope: 'attention', before: page1.nextCursor }); assert.equal(page2.jobs.length, 30); assert.equal(page2.nextCursor, null);
  assert.equal(new Set([...page1.jobs, ...page2.jobs].map((j) => j.id)).size, 60);
  assert.equal((await f.service.getBatch(first.id)).jobs.length, 30);
  assert.equal((await f.service.getBatch(second.id)).jobs.length, 30);
  await f.pool.query("update oauth_onboarding_jobs set status='uncertain' where id=$1", [first.jobs[29].id]);
  assert.equal((await f.service.getBatch(first.id)).jobs.find((j) => j.id === first.jobs[29].id).status, 'uncertain');
  await assert.rejects(f.service.listPage({ scope: 'all', before: 'wrong' }), { code: 'INVALID_PAGE' });
});


pgtest('repeated remote email and identity create new accounts but retrying one request still creates once', async (t) => {
  const f = await fixture(t);
  const firstInput = f.input(1); const first = await f.service.submitBatch(firstInput); await f.service.waitForIdle();
  const secondInput = f.input(1); const second = await f.service.submitBatch(secondInput); await f.service.waitForIdle();
  assert.equal(f.accounts.length, 2);
  assert.notEqual(f.accounts[0].extra.oauth_onboarding_creation_key, f.accounts[1].extra.oauth_onboarding_creation_key);
  assert.equal((await f.service.getBatch(first.id)).jobs[0].status, 'succeeded');
  assert.equal((await f.service.getBatch(second.id)).jobs[0].status, 'succeeded');
  await f.service.submitBatch(secondInput); await f.service.waitForIdle(); assert.equal(f.accounts.length, 2);
});

pgtest('read-only reconciliation selects only this creation marker, never an existing identical account', async (t) => {
  const f = await fixture(t, { lostResponse: true });
  const batch = await f.service.submitBatch(f.input(1)); await f.service.waitForIdle();
  const job = (await f.service.getBatch(batch.id)).jobs[0]; assert.equal(job.status, 'uncertain');
  const created = structuredClone(f.accounts[0]);
  f.accounts[0].extra.oauth_onboarding_creation_key = 'another-import-marker';
  await assert.rejects(f.service.reconcile(job.id), { code: 'RECONCILE_UNRESOLVED' });
  f.accounts.push({ ...created, id: 2 });
  assert.equal((await f.service.reconcile(job.id)).remoteAccountId, 2);
  assert.equal(f.pushes.length, 1);
});

pgtest('account protection opt-out is capability-gated before login and any database admission', async (t) => {
  const f = await fixture(t, { protectionCapable: false });
  await assert.rejects(f.service.submitBatch(f.input(1)), { code: 'ATOMIC_PROTECTION_UNSUPPORTED' });
  assert.equal(f.loginCount, 0);
  assert.equal((await f.store.list()).length, 0);
  assert.equal((await f.pool.query('select count(*) from oauth_import_preferences')).rows[0].count, '0');
});

pgtest('old persisted preferences acquire opt-out default without changing explicit fingerprint selection', async (t) => {
  const f = await fixture(t);
  const options = { ...defaultImportOptions(), fingerprintMode: 'full' }; delete options.accountProtection;
  await f.pool.query('insert into oauth_import_preferences(my_site_id,group_ids,import_options) values($1,$2,$3)', [f.site.id, [1], options]);
  const restored = await f.service.preferences(f.site.id);
  assert.equal(restored.preferences.importOptions.accountProtection, false);
  assert.equal(restored.preferences.importOptions.fingerprintMode, 'full');
  assert.equal(restored.capabilities.atomicProtection, true);
});

pgtest('replaying a historical pre-protection request retains its original fingerprint without accepting changed options', async (t) => {
  const f = await fixture(t);
  const input = f.input(1);
  const batch = await f.service.submitBatch(input); await f.service.waitForIdle();
  const job = await f.store.get(batch.jobs[0].id);
  delete job.importOptions.accountProtection;
  delete input.importOptions.accountProtection;
  // Original fingerprints were computed before JSONB reordered keys on persistence.
  const oldJobFingerprint = onboardingFingerprint({ ...job, importOptions: input.importOptions });
  const oldBatchFingerprint = createHash('sha256').update(JSON.stringify([oldJobFingerprint])).digest('hex');
  await f.pool.query('update oauth_onboarding_jobs set import_options=$1,fingerprint=$2 where id=$3', [job.importOptions, oldJobFingerprint, job.id]);
  await f.pool.query('update oauth_onboarding_batches set fingerprint=$1 where id=$2', [oldBatchFingerprint, batch.id]);
  const replay = await f.service.submitBatch(input);
  assert.equal(replay.id, batch.id);
  assert.equal(f.loginCount, 1); assert.equal(f.pushes.length, 1);
  await assert.rejects(f.service.submitBatch({ ...input, importOptions: { ...input.importOptions, concurrency: 2 } }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.service.submitBatch({ ...input, importOptions: { ...input.importOptions, accountProtection: false } }), { code: 'IDEMPOTENCY_CONFLICT' });
});

pgtest('a target that overwrites disabled protection or device mode is never reported as successful', async (t) => {
  const f = await fixture(t, { protectionOverwrite: true });
  const batch = await f.service.submitBatch(f.input(1)); await f.service.waitForIdle();
  assert.equal((await f.service.getBatch(batch.id)).jobs[0].status, 'uncertain');
  await assert.rejects(f.service.reconcile(batch.jobs[0].id), { code: 'RECONCILE_UNRESOLVED' });
  assert.equal((await f.service.getBatch(batch.id)).jobs[0].status, 'uncertain');
  assert.equal(f.pushes.length, 1);
});

pgtest('new credentials are atomically encrypted and survive service recreation for single/batch reruns', async (t) => {
  const f = await fixture(t);
  const input = f.input(2);
  const batch = await f.service.submitBatch(input);
  await f.service.waitForIdle();
  const stored = (await f.pool.query('select * from oauth_onboarding_job_secrets')).rows;
  assert.equal(stored.length, 2);
  const dump = JSON.stringify(stored);
  for (const secret of ['test-password', SECRET, 'test-admin-key']) assert.equal(dump.includes(secret), false);
  const jobs = (await f.service.getBatch(batch.id)).jobs;
  assert.ok(jobs.every(j => j.canRerun && j.accountName === j.email && j.startedAt && j.finishedAt));
  const service = f.makeService();
  const requestId = randomUUID();
  const [rerun, duplicate] = await Promise.all([service.rerunBatch(batch.id, { requestId }), service.rerunBatch(batch.id, { requestId })]);
  assert.equal(rerun.id, duplicate.id);
  await service.waitForIdle();
  assert.equal(f.pushes.length, 4);
  assert.equal(rerun.sourceBatchId, batch.id);
  assert.deepEqual(new Set(rerun.jobs.map(j => j.sourceJobId)), new Set(jobs.map(j => j.id)));
  assert.ok(rerun.jobs.every(j => !jobs.some(old => old.id === j.id)));
  await assert.rejects(service.rerunJob(jobs[0].id, { requestId }), { code: 'IDEMPOTENCY_CONFLICT' });
  f.accounts.splice(0); // The remote old account's lifetime has no bearing on replay.
  const single = await service.rerunJob(jobs[0].id, { requestId: randomUUID() });
  await service.waitForIdle();
  assert.equal(single.jobs.length, 1);
  assert.equal(f.pushes.length, 5);
  assert.equal((await f.service.getBatch(batch.id)).jobs[0].remoteAccountId, jobs[0].remoteAccountId);
  assert.equal(new Set(f.pushes.map(p => p.creationKey)).size, 5);
  assert.deepEqual((await f.service.preferences(f.site.id)).preferences.importOptions, input.importOptions);
});

pgtest('legacy tasks remain visible and read-only; new single entry receives full snapshot and encryption', async (t) => {
  const f = await fixture(t);
  const input = f.input(1);
  const account = input.accounts[0];
  const job = await f.service.submit({ ...input, ...account });
  await f.service.waitForIdle();
  assert.equal(job.id, input.requestId);
  const batch = await f.service.getBatch(job.id);
  assert.equal(batch.jobs.length, 1);
  assert.equal(batch.canRerun, true);
  assert.equal(batch.jobs[0].importOptions.accountProtection, false);
  assert.equal(batch.jobs[0].importOptions.fingerprintMode, 'device');
  const rerun = await f.service.rerunJob(job.id, { requestId: randomUUID() });
  await f.service.waitForIdle();
  assert.equal((await f.service.getBatch(rerun.id)).jobs[0].status, 'succeeded');
  await f.pool.query('delete from oauth_onboarding_job_secrets where job_id=$1', [job.id]);
  await f.pool.query('update oauth_onboarding_jobs set credential_stored=false,batch_id=null where id=$1', [job.id]);
  await f.pool.query('delete from oauth_onboarding_batches where id=$1', [job.id]);
  const old = await f.service.getBatch(job.id);
  assert.equal(old.legacy, true);
  assert.equal(old.canRerun, false);
  assert.equal(old.jobs[0].canRerun, false);
  await assert.rejects(f.service.rerunJob(job.id, { requestId: randomUUID() }), { code: 'LEGACY_TASK_READ_ONLY' });
  assert.ok((await f.service.listBatches()).batches.some(b => b.id === job.id && b.legacy));
});

pgtest('missing/wrong vault key and corrupted metadata fail closed without admission or external login', async (t) => {
  const f = await fixture(t);
  const unavailable = f.makeService({ credentialVault: createOAuthCredentialVault({ key: '' }) });
  await assert.rejects(unavailable.submitBatch(f.input(1)), { code: 'CREDENTIAL_KEY_UNAVAILABLE' });
  assert.equal((await f.pool.query('select count(*) from oauth_onboarding_jobs')).rows[0].count, '0');
  const batch = await f.service.submitBatch(f.input(2)); await f.service.waitForIdle();
  assert.equal((await unavailable.getBatch(batch.id)).jobs.length, 2);
  const wrong = f.makeService({ credentialVault: createOAuthCredentialVault({ key: Buffer.alloc(32, 9).toString('base64') }) });
  await assert.rejects(wrong.rerunBatch(batch.id, { requestId: randomUUID() }), { code: 'CREDENTIALS_UNAVAILABLE' });
  await f.pool.query('update oauth_onboarding_jobs set account_name=$2 where id=$1', [batch.jobs[1].id, 'tampered']);
  await assert.rejects(f.service.rerunBatch(batch.id, { requestId: randomUUID() }), { code: 'CREDENTIALS_UNAVAILABLE' });
  assert.equal(f.loginCount, 2);
  assert.equal((await f.pool.query('select count(*) from oauth_onboarding_batches')).rows[0].count, '1');
});

pgtest('credential insert failure rolls back every job, batch and preference', async (t) => {
  const f = await fixture(t);
  await f.pool.query(`alter table oauth_onboarding_job_secrets add constraint refuse_secret check (false)`);
  await assert.rejects(f.service.submitBatch(f.input(2)));
  for (const table of ['oauth_onboarding_jobs', 'oauth_onboarding_batches', 'oauth_onboarding_job_secrets', 'oauth_import_preferences']) {
    assert.equal((await f.pool.query(`select count(*) from ${table}`)).rows[0].count, '0');
  }
  assert.equal(f.loginCount, 0);
});

pgtest('explicit uncertain rerun is new admission while ordinary import and active replay stay blocked', async (t) => {
  const f = await fixture(t, { lostResponse: true, loginDelay: 50 });
  const input = f.input(1);
  const batch = await f.service.submitBatch(input); await f.service.waitForIdle();
  assert.equal((await f.service.getBatch(batch.id)).jobs[0].status, 'uncertain');
  await assert.rejects(f.service.submitBatch({ ...input, requestId: randomUUID() }), { code: 'ACCOUNT_BUSY' });
  const requestId = randomUUID();
  const rerun = await f.service.rerunBatch(batch.id, { requestId });
  await assert.rejects(f.service.rerunJob(rerun.jobs[0].id, { requestId: randomUUID() }), { code: 'ACCOUNT_BUSY' });
  await assert.rejects(f.service.rerunBatch(batch.id, { requestId: randomUUID() }), { code: 'ACCOUNT_BUSY' });
  await f.service.waitForIdle();
  assert.equal(f.pushes.length, 2);
  assert.equal((await f.service.getBatch(batch.id)).jobs[0].status, 'uncertain');
  assert.equal((await f.service.rerunBatch(batch.id, { requestId })).id, rerun.id);
  assert.equal(f.pushes.length, 2);
});

pgtest('batch history literal email search, member filtering and stable pagination include old records', async (t) => {
  const f = await fixture(t);
  const input = f.input(2);
  input.accounts[0].email = 'name_100%@example.test';
  const batch = await f.service.submitBatch(input); await f.service.waitForIdle();
  const page = await f.service.listBatches({ email: '100%' });
  assert.equal(page.batches.length, 1);
  assert.equal(page.batches[0].total, 2);
  assert.equal(page.batches[0].matchedCount, 1);
  assert.equal((await f.service.getBatch(batch.id, { email: '100%' })).jobs.length, 1);
  assert.equal((await f.service.listBatches({ email: 'NO-MATCH' })).batches.length, 0);
  assert.equal((await f.service.listBatches({ email: '_100%' })).batches.length, 1);
  // Equal timestamp rows prove the UUID tie-breaker, without starting extra account logins.
  for (let i = 0; i < 32; i++) {
    const id = randomUUID();
    await f.pool.query(`insert into oauth_onboarding_jobs(id,fingerprint,my_site_id,target_url,email,group_ids,status,owner_id,lease_until,created_at)
      values($1,'legacy',$2,'https://sub.example.test/',$3,'{1}','failed',$4,now(), '2026-01-01')`, [id, f.site.id, `old-${i}@example.test`, randomUUID()]);
  }
  const first = await f.service.listBatches();
  const second = await f.service.listBatches({ before: first.nextCursor });
  assert.equal(first.batches.length, 30); assert.equal(second.batches.length, 3);
  assert.equal(new Set([...first.batches, ...second.batches].map(b => b.id)).size, 33);
  assert.equal(second.nextCursor, null);
});

pgtest('rerun rejects changed target or groups and leaves saved import preferences untouched', async (t) => {
  const f = await fixture(t);
  const batch = await f.service.submitBatch(f.input(1)); await f.service.waitForIdle();
  f.site.url = 'https://other.example.test/';
  await assert.rejects(f.service.rerunBatch(batch.id, { requestId: randomUUID() }), { code: 'TARGET_CHANGED' });
  f.site.url = 'https://sub.example.test/';
  const broken = f.makeService({ clientFactory: () => ({ async listGroups() { return []; } }) });
  await assert.rejects(broken.rerunBatch(batch.id, { requestId: randomUUID() }), { code: 'GROUP_UNAVAILABLE' });
  const preferences = { ...defaultImportOptions(), concurrency: 111 };
  await f.pool.query('update oauth_import_preferences set import_options=$1::jsonb', [JSON.stringify(preferences)]);
  await f.service.rerunBatch(batch.id, { requestId: randomUUID() }); await f.service.waitForIdle();
  assert.equal((await f.service.preferences(f.site.id)).preferences.importOptions.concurrency, 111);
  assert.equal(f.pushes.at(-1).importOptions.concurrency, 50);
});

pgtest('rerun rejects changed proxy snapshot and still enforces workspace/user active seat exclusion', async (t) => {
  const f = await fixture(t);
  const batch = await f.service.submitBatch(f.input(1)); await f.service.waitForIdle();
  const job = await f.store.get(batch.jobs[0].id);
  const vault = createOAuthCredentialVault({ key: Buffer.alloc(32, 7).toString('base64') });
  const payload = vault.open(job, await f.store.getJobEnvelope(job.id));
  const proxyId = randomUUID();
  const snapshot = { protocol: 'http', host: 'proxy.example.test', port: 7897, username: 'fixture-user', password: 'fixture-proxy-secret' };
  const changed = { ...job, proxyId };
  await f.pool.query('update oauth_onboarding_jobs set proxy_id=$2 where id=$1', [job.id, proxyId]);
  await f.pool.query('update oauth_onboarding_job_secrets set envelope=$2 where job_id=$1', [job.id, vault.seal(changed, { ...payload, proxySnapshot: snapshot })]);
  const replayService = f.makeService({ proxyRepository: { async getProxyById() { return { ...snapshot, id: proxyId, status: 'active', password: 'changed-secret' }; } } });
  await assert.rejects(replayService.rerunJob(job.id, { requestId: randomUUID() }), { code: 'PROXY_CHANGED' });
  assert.equal(f.loginCount, 1);
  // Revert only this synthetic record; lock behavior is tested against a different email on the same seat.
  await f.pool.query('update oauth_onboarding_jobs set proxy_id=null where id=$1', [job.id]);
  await f.pool.query('update oauth_onboarding_job_secrets set envelope=$2 where job_id=$1', [job.id, vault.seal(job, payload)]);
  const busyId = randomUUID();
  const busyOwner = randomUUID();
  await f.pool.query(`insert into oauth_onboarding_jobs(id,fingerprint,my_site_id,target_url,email,group_ids,status,owner_id,lease_until,chatgpt_account_id,chatgpt_user_id)
    values($1,'busy',$2,$3,'other-seat-email@example.test','{1}','running',$4,now()+interval '5 minutes',$5,$6)`,
  [busyId, f.site.id, job.targetUrl, busyOwner, job.chatgptAccountId, job.chatgptUserId]);
  const replay = await f.service.rerunJob(job.id, { requestId: randomUUID() }); await f.service.waitForIdle();
  assert.equal((await f.service.get(replay.jobs[0].id)).errorCode, 'ACCOUNT_BUSY');
  assert.equal(f.pushes.length, 1);
});

pgtest('ordinary admission on a new email cannot bypass an uncertain workspace/user seat', async (t) => {
  const f = await fixture(t);
  const input = f.input(1);
  const batch = await f.service.submitBatch(input); await f.service.waitForIdle();
  const job = await f.store.get(batch.jobs[0].id);
  await f.pool.query("update oauth_onboarding_jobs set status='uncertain' where id=$1", [job.id]);
  const candidateId = randomUUID(); const ownerId = randomUUID();
  await f.store.create({ id: candidateId, fingerprint: 'seat-candidate', mySiteId: f.site.id, targetUrl: job.targetUrl,
    email: 'different@example.test', proxyId: null, groupIds: [1], ownerId });
  await assert.rejects(f.store.update(candidateId, ownerId, { chatgptAccountId: job.chatgptAccountId, chatgptUserId: job.chatgptUserId }), { code: 'ACCOUNT_BUSY' });
});

pgtest('single admission gates capability and default snapshot without weakening historical request replay', async (t) => {
  const incapable = await fixture(t, { protectionCapable: false });
  const rejected = incapable.input(1);
  await assert.rejects(incapable.service.submit({ ...rejected, ...rejected.accounts[0], importOptions: undefined }), { code: 'ATOMIC_PROTECTION_UNSUPPORTED' });
  assert.equal(incapable.loginCount, 0);
  assert.equal((await incapable.pool.query('select count(*) from oauth_onboarding_jobs')).rows[0].count, '0');
  const f = await fixture(t);
  const input = f.input(1);
  const submitted = await f.service.submit({ ...input, ...input.accounts[0], importOptions: undefined });
  await f.service.waitForIdle();
  assert.equal((await f.service.get(submitted.id)).status, 'succeeded');
  await f.service.rerunJob(submitted.id, { requestId: randomUUID() }); await f.service.waitForIdle();
  assert.equal(f.pushes.length, 2);
  const noKey = f.makeService({ credentialVault: createOAuthCredentialVault({ key: '' }) });
  const replay = await noKey.submit({ ...input, ...input.accounts[0], password: undefined, totpSecret: undefined, importOptions: undefined });
  assert.equal(replay.id, submitted.id);
});

pgtest('request ID cannot be reused across batch, single and explicit rerun operations', async (t) => {
  const f = await fixture(t);
  const input = f.input(1);
  const batch = await f.service.submitBatch(input); await f.service.waitForIdle();
  await assert.rejects(f.service.submit({ ...input, ...input.accounts[0] }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.service.rerunBatch(batch.id, { requestId: batch.id }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.pushes.length, 1);
});

pgtest('automatic challenge retry retains one durable batch/job/secret and identity lease; no intermediate terminal result', async (t) => {
  const f = await fixture(t);
  let waiting; let resume;
  const reachedWait = new Promise(resolve => { waiting = resolve; });
  const continueRetry = new Promise(resolve => { resume = resolve; });
  let attempts = 0; const sessionIds = []; const exchanged = [];
  f.client.generateAuthUrl = async () => {
    const sessionId = `session-${sessionIds.length + 1}`; sessionIds.push(sessionId);
    return { sessionId, authUrl: `https://auth.example.test/${sessionId}` };
  };
  const exchange = f.client.exchangeCode;
  f.client.exchangeCode = async (input) => { exchanged.push(input.sessionId); return exchange(input); };
  const service = f.makeService({
    async login({ email, onStage }) {
      attempts++; await onStage('authorizing');
      if (attempts === 1) throw Object.assign(new Error('访问挑战'), { safe: true, needsAttention: true, code: 'OAUTH_HTTP_CHALLENGE' });
      return { code: email, state: 'new-state', redirectUri: 'http://localhost:1455/auth/callback' };
    },
    async retryWait() { waiting(); await continueRetry; },
  });
  const submitted = await service.submitBatch(f.input(1));
  try {
    await reachedWait;
    const row = await f.store.get(submitted.jobs[0].id);
    assert.equal(row.status, 'running'); assert.equal(row.stage, 'retry_wait');
    assert.equal(row.finishedAt, null);
    const { startedAt, ownerId, creationKey } = row;
    assert.equal((await f.pool.query('select count(*)::int as n from oauth_onboarding_jobs')).rows[0].n, 1);
    assert.equal((await f.pool.query('select count(*)::int as n from oauth_onboarding_batches')).rows[0].n, 1);
    assert.equal((await f.pool.query('select count(*)::int as n from oauth_onboarding_job_secrets')).rows[0].n, 1);
    await assert.rejects(f.service.submitBatch(f.input(1)), { code: 'ACCOUNT_BUSY' });
    resume(); await service.waitForIdle();
    const final = await f.store.get(row.id);
    assert.equal(final.status, 'succeeded'); assert.equal(final.ownerId, ownerId);
    assert.equal(final.startedAt, startedAt); assert.equal(final.creationKey, creationKey);
    assert.equal(final.batchId, submitted.id); assert.ok(final.finishedAt);
    assert.deepEqual(sessionIds, ['session-1', 'session-2']); assert.deepEqual(exchanged, ['session-2']);
    assert.equal(f.pushes.length, 1); assert.equal(attempts, 2);
    assert.equal((await f.pool.query('select count(*)::int as n from oauth_onboarding_jobs')).rows[0].n, 1);
    const replay = await service.getBatch(submitted.id);
    assert.equal(replay.jobs.length, 1); assert.equal(replay.jobs[0].id, row.id);
  } finally { resume(); }
});

pgtest('lease expiry during challenge wait is not revived by a retry or a newly constructed service', async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  const service = f.makeService({ heartbeatMs: 60_000,
    async login() { attempts++; throw Object.assign(new Error('访问挑战'), { safe: true, needsAttention: true, code: 'OAUTH_HTTP_CHALLENGE' }); },
    async retryWait() { await f.pool.query("update oauth_onboarding_jobs set lease_until=now()-interval '1 second'"); },
  });
  const submitted = await service.submitBatch(f.input(1));
  await service.waitForIdle();
  await f.store.expireStale();
  const job = await f.store.get(submitted.jobs[0].id);
  assert.equal(attempts, 1); assert.equal(f.pushes.length, 0);
  assert.equal(job.status, 'needs_attention');
  const fresh = f.makeService(); await fresh.waitForIdle();
  assert.equal((await fresh.getBatch(submitted.id)).jobs[0].status, 'needs_attention');
  assert.equal(f.loginCount, 0);
});

async function eventually(check, message) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function controlledLogin() {
  const active = new Map();
  const started = [];
  let peak = 0;
  return {
    active, started, get peak() { return peak; },
    async login({ email, signal }) {
      await new Promise((resolve, reject) => {
        const finish = () => { signal.removeEventListener('abort', abort); active.delete(email); resolve(); };
        const abort = () => { active.delete(email); reject(Object.assign(new Error('stopped'), { safe: true, code: 'TASK_INTERRUPTED' })); };
        active.set(email, finish); started.push(email); peak = Math.max(peak, active.size);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return { code: email, state: 'test-state', redirectUri: 'http://localhost:1455/auth/callback' };
    },
    releaseOne() { active.values().next().value?.(); },
    releaseAll() { for (const release of [...active.values()]) release(); },
  };
}

pgtest('default five slots execute concurrently across batches and independent services, not five per batch', async (t) => {
  const f = await fixture(t);
  const control = controlledLogin();
  const first = f.makeService({ login: control.login });
  const second = f.makeService({ login: control.login });
  await Promise.all([
    first.submitBatch(f.input(6)),
    second.submitBatch(f.input(6, { accounts: accounts(6).map(a => ({ ...a, email: `other-${a.email}` })) })),
  ]);
  await eventually(() => control.active.size === 5, 'default must actually start five logins');
  assert.equal(Number((await f.pool.query("select count(*) from oauth_onboarding_jobs where status='running'")).rows[0].count), 5);
  await eventually(() => { control.releaseAll(); return f.pushes.length === 12; }, 'both batches finish');
  await Promise.all([first.waitForIdle(), second.waitForIdle()]);
  assert.equal(control.started.length, 12);
  assert.equal(control.peak, 5);
});

pgtest('raising and lowering concurrency changes existing queued work online without interrupting running accounts', async (t) => {
  const f = await fixture(t, { concurrency: 1 });
  const control = controlledLogin();
  const service = f.makeService({ login: control.login });
  const batch = await service.submitBatch(f.input(8));
  await eventually(() => control.active.size === 1, 'initial one-slot setting');
  const otherStore = createOAuthOnboardingStore(f.pool);
  await otherStore.saveExecutionSettings({ concurrency: 5 });
  await eventually(() => control.active.size === 5, 'raised limit must start already queued accounts');
  await otherStore.saveExecutionSettings({ concurrency: 2 });
  // Explicit claim attempts prove the lower limit, without relying on absence during a sleep.
  let rows = (await f.pool.query("select id,owner_id from oauth_onboarding_jobs where batch_id=$1 and status='queued' order by created_at,id", [batch.id])).rows;
  assert.equal(rows.length, 3);
  assert.equal(await otherStore.claimQueued(rows[0].id, rows[0].owner_id), null);
  assert.equal(control.active.size, 5, 'saving a lower limit never aborts active login');
  for (let i = 0; i < 3; i++) {
    control.releaseOne();
    await eventually(() => f.pushes.length === i + 1, 'released account completes');
    await eventually(async () => Number((await f.pool.query("select count(*) from oauth_onboarding_jobs where status in ('running','pushing')")).rows[0].count) === 4 - i, 'completed task frees its slot');
    assert.equal(await otherStore.claimQueued(rows[0].id, rows[0].owner_id), null);
  }
  assert.equal(control.started.length, 5, 'no replacement starts while running count is at or above two');
  control.releaseOne();
  await eventually(() => control.started.length === 6 && control.active.size === 2, 'next queued account starts once running count drops below two');
  await eventually(() => { control.releaseAll(); return f.pushes.length === 8; }, 'resized batch finishes');
  await service.waitForIdle();
  assert.ok((await service.getBatch(batch.id)).jobs.every(j => j.status === 'succeeded'));
  await service.close();
  await assert.rejects(service.saveExecutionSettings({ concurrency: 3 }), { code: 'SHUTTING_DOWN' });
});

pgtest('queued batches do not consume direct slots, but direct and batch execution share the configured limit', async (t) => {
  const f = await fixture(t, { concurrency: 1 });
  const ownerId = randomUUID();
  const batchInput = { id: randomUUID(), fingerprint: 'test-batch', mySiteId: f.site.id, targetUrl: f.site.url,
    proxyId: null, groupIds: [1], ownerId, importOptions: defaultImportOptions(),
    jobs: accounts(3).map(a => ({ id: randomUUID(), email: a.email, fingerprint: a.email })) };
  const vault = createOAuthCredentialVault({ key: Buffer.alloc(32, 7).toString('base64') });
  for (const job of batchInput.jobs) job.envelope = vault.seal({ ...batchInput, ...job }, { password: 'test-only' });
  const { batch } = await f.store.createBatch(batchInput);
  const directInput = { id: randomUUID(), mySiteId: f.site.id, email: 'direct@example.test', proxyId: null,
    groupIds: [1], targetUrl: f.site.url, ownerId: randomUUID() };
  directInput.fingerprint = onboardingFingerprint(directInput);
  await f.store.create(directInput);
  assert.equal(await f.store.claimQueued(batch.jobs[0].id, ownerId), null);
  await f.store.saveExecutionSettings({ concurrency: 2 });
  assert.equal((await f.store.claimQueued(batch.jobs[0].id, ownerId)).status, 'running');
  assert.equal(await f.store.claimQueued(batch.jobs[1].id, ownerId), null);
  await f.pool.query('delete from oauth_onboarding_settings');
  await assert.rejects(f.store.claimQueued(batch.jobs[1].id, ownerId), { code: 'OAUTH_SETTINGS_UNAVAILABLE' });
  assert.equal((await f.store.get(batch.jobs[1].id)).status, 'queued');
});

pgtest('challenge retry wait retains its configured execution slot and does not admit another account', async (t) => {
  const f = await fixture(t, { concurrency: 1 });
  let reachedWait; let resume;
  const waiting = new Promise(resolve => { reachedWait = resolve; });
  const continued = new Promise(resolve => { resume = resolve; });
  const attempts = new Map();
  const service = f.makeService({
    async login({ email }) {
      attempts.set(email, (attempts.get(email) ?? 0) + 1);
      if (email === 'batch-0@example.test' && attempts.get(email) === 1) {
        throw Object.assign(new Error('访问挑战'), { safe: true, needsAttention: true, code: 'OAUTH_HTTP_CHALLENGE' });
      }
      return { code: email, state: 'state', redirectUri: 'http://localhost:1455/auth/callback' };
    },
    async retryWait() { reachedWait(); await continued; },
  });
  const batch = await service.submitBatch(f.input(2));
  try {
    await waiting;
    const held = await f.store.get(batch.jobs[0].id);
    const queued = await f.store.get(batch.jobs[1].id);
    assert.equal(held.stage, 'retry_wait');
    assert.equal(queued.status, 'queued');
    assert.equal(await f.store.claimQueued(queued.id, queued.ownerId), null);
    assert.equal(attempts.has(queued.email), false);
  } finally { resume(); }
  await service.waitForIdle();
  assert.equal(attempts.get('batch-0@example.test'), 2);
  assert.equal(f.pushes.length, 2);
  assert.equal((await service.getBatch(batch.id)).jobs.length, 2);
});

pgtest('explicit rerun uses the current execution limit rather than the original batch settings', async (t) => {
  const f = await fixture(t);
  const original = await f.service.submitBatch(f.input(3));
  await f.service.waitForIdle();
  await f.store.saveExecutionSettings({ concurrency: 1 });
  const control = controlledLogin();
  const service = f.makeService({ login: control.login });
  const replay = await service.rerunBatch(original.id, { requestId: randomUUID() });
  await eventually(() => control.active.size === 1, 'rerun starts with current one-slot setting');
  const rows = (await f.pool.query("select id,owner_id from oauth_onboarding_jobs where batch_id=$1 and status='queued'", [replay.id])).rows;
  assert.equal(rows.length, 2);
  assert.equal(await f.store.claimQueued(rows[0].id, rows[0].owner_id), null);
  await eventually(() => { control.releaseAll(); return f.pushes.length === 6; }, 'rerun finishes');
  await service.waitForIdle();
  assert.equal(control.peak, 1);
  assert.equal(replay.sourceBatchId, original.id);
});

for (const concurrency of [10, 20]) {
  pgtest(`${concurrency} same-proxy accounts share one mapping without exhausting the default ten-connection pool`, async (t) => {
    const f = await fixture(t, { concurrency, poolOptions: { max: 10, connectionTimeoutMillis: 2000, statement_timeout: 2000 } });
    await f.pool.query(`create table upstream_sites(id uuid primary key);
      create table proxies(id uuid primary key);
      create function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$`);
    await createMySitesTables(f.pool);
    const proxy = { id: randomUUID(), status: 'active', protocol: 'http', host: 'proxy.example.test', port: 7897, username: '', password: '' };
    await f.pool.query('insert into proxies(id) values($1)', [proxy.id]);
    await f.pool.query('insert into my_sites(id,name,url) values($1,$2,$3)', [f.site.id, f.site.name, f.site.url]);
    const mapping = createMySiteProxyRepository(f.pool);
    let releaseProxy; let enteredProxy;
    const proxyGate = new Promise(resolve => { releaseProxy = resolve; });
    const proxyStarted = new Promise(resolve => { enteredProxy = resolve; });
    let creates = 0; let lockAttempts = 0;
    const remote = { ...proxy, id: 42 };
    f.client.listProxies = async () => [];
    f.client.getProxy = async () => remote;
    f.client.createProxy = async () => { creates++; enteredProxy(); await proxyGate; return remote; };
    const control = controlledLogin();
    const make = () => {
      const store = createOAuthOnboardingStore(f.pool);
      return f.makeService({ store: { ...store, withProxyLock(...args) { lockAttempts++; return store.withProxyLock(...args); } },
        proxyRepository: { async getProxyById() { return proxy; } }, mySiteProxyRepository: mapping, login: control.login });
    };
    const first = make(); const second = make();
    const half = concurrency / 2;
    const batches = await Promise.all([
      first.submitBatch(f.input(half, { proxyId: proxy.id })),
      second.submitBatch(f.input(half, { proxyId: proxy.id, accounts: accounts(half).map(a => ({ ...a, email: `other-${a.email}` })) })),
    ]);
    try {
      await proxyStarted;
      await eventually(() => lockAttempts === concurrency, 'all tasks enter the shared mapping boundary');
      // The remote call is held: a blocking lock waiter must not occupy the business pool.
      assert.deepEqual(await f.store.getExecutionSettings(), { concurrency });
      await f.store.saveExecutionSettings({ concurrency });
      assert.equal(creates, 1);
    } finally { releaseProxy(); }
    await eventually(() => control.active.size === concurrency, 'all configured accounts reach login without a nested pool checkout deadlock');
    assert.equal(creates, 1);
    assert.equal((await mapping.listLinks({ mySiteId: f.site.id, proxyId: proxy.id })).length, 1);
    control.releaseAll();
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);
    for (const batch of batches) assert.ok((await first.getBatch(batch.id)).jobs.every(j => j.status === 'succeeded'));
    assert.equal(f.pushes.length, concurrency);
  });
}
