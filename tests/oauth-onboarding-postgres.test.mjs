import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createOAuthOnboardingTables, createOAuthOnboardingStore, onboardingFingerprint } from '../src/oauth-onboarding-store.mjs';

import { createOAuthOnboardingService } from '../src/oauth-onboarding.mjs';

const connectionString = process.env.OAUTH_ONBOARDING_TEST_DATABASE_URL;
const input = (overrides = {}) => {
  const value = { id: randomUUID(), mySiteId: randomUUID(), email: 'user@example.test', proxyId: null, groupIds: [1, 2], targetUrl: 'https://sub.example.test/', ownerId: randomUUID(), ...overrides };
  return { ...value, fingerprint: onboardingFingerprint(value) };
};

async function fixture(t, options = {}) {
  const schema = `oauth_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public`, ...options.poolOptions });
  t.after(async () => { await pool.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
  await createOAuthOnboardingTables(pool);
  const store = createOAuthOnboardingStore(pool, options);
  if (options.concurrency) await store.saveExecutionSettings({ concurrency: options.concurrency });
  return { pool, store };
}

const pgtest = (name, fn) => test(name, { skip: !connectionString, timeout: 15_000 }, fn);

pgtest('OAuth migration is idempotent, persists metadata only and retains evidence without foreign-key cascades', async (t) => {
  const { pool, store } = await fixture(t);
  await createOAuthOnboardingTables(pool);
  const value = input();
  await store.create(value);
  const row = await store.get(value.id);
  assert.equal(row.email, value.email);
  assert.deepEqual(row.groupIds, [1, 2]);
  const columns = (await pool.query("select column_name from information_schema.columns where table_schema=current_schema() and table_name='oauth_onboarding_jobs'")).rows.map((row) => row.column_name);
  assert.ok(!columns.some((name) => /password|token|totp|secret|credentials/i.test(name)));
  assert.equal((await store.list()).length, 1);
});

pgtest('admission is globally serialized: identical request replays, changed payload conflicts', async (t) => {
  const { store } = await fixture(t);
  const value = input();
  const results = await Promise.all([store.create(value), store.create(value)]);
  assert.equal(results.filter((result) => result.created).length, 1);
  await assert.rejects(store.create({ ...value, fingerprint: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

pgtest('same account across processes is excluded while distinct accounts respect global capacity', async (t) => {
  const { pool, store } = await fixture(t, { concurrency: 2 });
  const otherProcess = createOAuthOnboardingStore(pool);
  const first = input();
  const second = input({ mySiteId: first.mySiteId });
  const results = await Promise.allSettled([store.create(first), otherProcess.create(second)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'ACCOUNT_BUSY');
  await store.create(input());
  await assert.rejects(store.create(input()), { code: 'CAPACITY' });
});

pgtest('lease checks reject stale/wrong owners, and startup recovery leaves live tasks alone', async (t) => {
  const { pool, store } = await fixture(t);
  const value = input();
  await store.create(value);
  await store.expireStale();
  assert.equal((await store.get(value.id)).status, 'queued');
  assert.equal(await store.heartbeat(value.id, randomUUID()), false);
  await assert.rejects(store.update(value.id, randomUUID(), { stage: 'totp' }), { code: 'LEASE_LOST' });
  await pool.query("update oauth_onboarding_jobs set lease_until=now()-interval '1 second' where id=$1", [value.id]);
  assert.equal(await store.heartbeat(value.id, value.ownerId), false);
  await assert.rejects(store.update(value.id, value.ownerId, { status: 'pushing' }), { code: 'LEASE_LOST' });
  await store.expireStale();
  assert.equal((await store.get(value.id)).status, 'needs_attention');
});

pgtest('expired pushing tasks stay uncertain and lock identity until reconciliation', async (t) => {
  const { pool, store } = await fixture(t);
  const value = input();
  await store.create(value);
  await store.update(value.id, value.ownerId, { status: 'pushing', stage: 'pushing', remoteProxyId: 51 });
  await pool.query("update oauth_onboarding_jobs set lease_until=now()-interval '1 second' where id=$1", [value.id]);
  await store.expireStale();
  assert.equal((await store.get(value.id)).status, 'uncertain');
  await assert.rejects(store.create(input({ mySiteId: value.mySiteId })), { code: 'ACCOUNT_BUSY' });
  const reconciled = await store.reconcileSuccess(value.id, 99);
  assert.equal(reconciled.status, 'succeeded');
  assert.equal(reconciled.remoteAccountId, 99);
  assert.equal(reconciled.remoteProxyId, 51);
});

pgtest('proxy advisory locks serialize across clients and release after errors', async (t) => {
  const { pool, store } = await fixture(t);
  const other = createOAuthOnboardingStore(pool);
  const events = [];
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const first = store.withProxyLock('site', 'proxy', async () => { events.push('first'); entered(); await new Promise((resolve) => { release = resolve; }); throw new Error('expected'); });
  const firstResult = assert.rejects(first, /expected/);
  await started;
  const second = other.withProxyLock('site', 'proxy', async () => { events.push('second'); });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(events, ['first']);
  release();
  await Promise.all([firstResult, second]);
  assert.deepEqual(events, ['first', 'second']);
});


pgtest('persisted OAuth seat excludes simultaneous aliases but allows distinct users in the same workspace', async (t) => {
  const { store } = await fixture(t, { concurrency: 3 });
  const a = input();
  const b = input({ mySiteId: a.mySiteId, email: 'alias@example.test' });
  await store.create(a); await store.create(b);
  await store.update(a.id, a.ownerId, { status: 'running', chatgptAccountId: 'workspace', chatgptUserId: 'user-a' });
  await assert.rejects(store.update(b.id, b.ownerId, { status: 'running', chatgptAccountId: 'workspace', chatgptUserId: 'user-a' }), { code: 'ACCOUNT_BUSY' });
  await store.update(b.id, b.ownerId, { status: 'running', chatgptAccountId: 'workspace', chatgptUserId: 'user-b' });
  assert.equal((await store.get(b.id)).chatgptUserId, 'user-b');
});

pgtest('identity migration preserves previously recorded uncertain jobs and leaves missing identity explicit', async (t) => {
  const { pool, store } = await fixture(t);
  const old = input(); await store.create(old);
  await store.update(old.id, old.ownerId, { status: 'uncertain' });
  await pool.query('drop index oauth_onboarding_active_seat_v2');
  await pool.query('alter table oauth_onboarding_jobs drop column chatgpt_account_id, drop column chatgpt_user_id');
  await createOAuthOnboardingTables(pool);
  const restored = await store.get(old.id);
  assert.equal(restored.status, 'uncertain');
  assert.equal(restored.email, old.email);
  assert.equal(restored.chatgptAccountId, '');
  assert.equal(restored.chatgptUserId, '');
});

pgtest('standalone stale recovery cannot remove an active seat during ordinary identity admission', async (t) => {
  const { pool } = await fixture(t);
  let armed = false, reachedCheck, releaseCheck, expiryPid;
  const checked = new Promise(resolve => { reachedCheck = resolve; });
  const barrier = new Promise(resolve => { releaseCheck = resolve; });
  let captureExpiry = false;
  const wrapped = {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      if (captureExpiry) expiryPid = client.processID;
      return { release: (...args) => client.release(...args), async query(sql, ...args) {
        const result = await client.query(sql, ...args);
        if (armed && sql.includes("and status='uncertain' and chatgpt_account_id")) {
          armed = false; reachedCheck(result.rowCount); await barrier;
        }
        return result;
      } };
    },
  };
  const store = createOAuthOnboardingStore(wrapped);
  await store.saveExecutionSettings({ concurrency: 4 });
  const first = input(); const second = input({ mySiteId: first.mySiteId, email: 'alias@example.test' });
  await store.create(first); await store.create(second);
  const identity = { chatgptAccountId: 'workspace', chatgptUserId: 'user' };
  await store.update(first.id, first.ownerId, { ...identity, status: 'pushing' });
  await pool.query("update oauth_onboarding_jobs set lease_until=now()-interval '1 second' where id=$1", [first.id]);
  armed = true;
  const binding = store.update(second.id, second.ownerId, { ...identity, status: 'running' });
  // Attach the rejection handler before releasing the barrier to avoid an unhandled rejection.
  const bindingResult = binding.then(() => null, error => error);
  assert.equal(await checked, 0);
  captureExpiry = true;
  let expired = false;
  const expiry = store.expireStale().then(() => { expired = true; });
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !expired; attempt++) {
      if (expiryPid) {
        const row = (await pool.query('select wait_event from pg_stat_activity where pid=$1', [expiryPid])).rows[0];
        if (row?.wait_event === 'advisory') { blocked = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(expired, false, 'stale recovery must not escape the identity admission lock');
    assert.equal(blocked, true, 'recovery waits on the same PostgreSQL advisory transaction lock');
    assert.equal((await store.get(first.id)).status, 'pushing');
  } finally { releaseCheck(); await Promise.allSettled([bindingResult, expiry]); }
  assert.equal((await bindingResult)?.code, 'ACCOUNT_BUSY');
  assert.equal((await store.get(first.id)).status, 'uncertain');
  assert.equal((await store.get(second.id)).chatgptAccountId, '');
  await assert.rejects(store.update(second.id, second.ownerId, identity), { code: 'ACCOUNT_BUSY' });
});


const SITE = '11111111-1111-4111-8111-111111111111';
const CURSOR = '22222222-2222-4222-8222-222222222222';
const STATES = ['queued', 'running', 'pushing', 'succeeded', 'failed', 'needs_attention', 'uncertain'];
async function databaseFixture(t) {
  const { pool, store } = await fixture(t);
  async function insert({ statuses = ['failed'], site = SITE, createdAt = '2026-10-07T00:00:00Z', legacy = false, emails = [] } = {}) {
    const id = randomUUID();
    if (!legacy) await pool.query('insert into oauth_onboarding_batches(id,fingerprint,my_site_id,created_at) values($1,$2,$3,$4)', [id, id, site, createdAt]);
    for (let i = 0; i < statuses.length; i++) {
      await pool.query(`insert into oauth_onboarding_jobs(id,fingerprint,my_site_id,target_url,email,group_ids,status,owner_id,lease_until,created_at,batch_id)
        values($1,$2,$3,'https://offline.example.test/',$4,'{1}',$5,$6,now()+interval '1 hour',$7,$8)`,
      [legacy ? id : randomUUID(), id, site, emails[i] ?? `${id}-${i}@example.test`, statuses[i], randomUUID(), createdAt, legacy ? null : id]);
    }
    return id;
  }
  return { pool, insert, service: createOAuthOnboardingService({ store, credentialVault: {}, mySiteRepository: {}, proxyRepository: {}, mySiteProxyRepository: {} }) };
}

pgtest('PostgreSQL filters full history before cursor pagination, including legacy rows and inclusive/exclusive time bounds', async (t) => {
  const f = await databaseFixture(t);
  const mixed = await f.insert({ statuses: ['succeeded', 'failed'], emails: ['literal%_@example.test', 'other@example.test'] });
  const legacy = await f.insert({ legacy: true, statuses: ['failed'], createdAt: '2026-10-01T00:00:00Z' });
  const until = await f.insert({ createdAt: '2026-10-08T00:00:00Z' });
  await f.insert({ site: CURSOR });
  await f.insert({ createdAt: '2026-09-30T23:59:59.999Z' });
  await f.insert({ statuses: ['succeeded'] });
  const query = { status: 'failed', mySiteId: SITE, createdFrom: '2026-10-01T00:00:00Z', createdBefore: '2026-10-08T00:00:00Z' };
  const result = await f.service.listBatches(query);
  assert.deepEqual(new Set(result.batches.map((batch) => batch.id)), new Set([mixed, legacy]));
  assert.equal(result.batches.find((batch) => batch.id === legacy).legacy, true);
  assert.equal(result.batches.some((batch) => batch.id === until), false);
  // Email and status both match the batch, not necessarily the same job; counts remain batch-wide.
  const searched = await f.service.listBatches({ ...query, email: 'literal%_' });
  assert.deepEqual(searched.batches.map((batch) => batch.id), [mixed]);
  assert.equal(searched.batches[0].matchedCount, 1);
  assert.deepEqual(searched.batches[0].statusCounts, { succeeded: 1, failed: 1 });
  assert.equal((await f.service.listBatches({ ...query, email: "%' OR true --" })).batches.length, 0);
  await f.pool.query('truncate oauth_onboarding_batches,oauth_onboarding_jobs,oauth_onboarding_job_secrets cascade');
  for (let i = 0; i < 36; i++) await f.insert({ statuses: ['succeeded'] });
  const matching = [];
  for (let i = 0; i < 33; i++) matching.push(await f.insert({ legacy: i % 2 === 0 }));
  const first = await f.service.listBatches({ status: 'failed', mySiteId: SITE });
  const second = await f.service.listBatches({ status: 'failed', mySiteId: SITE, before: first.nextCursor });
  assert.equal(first.batches.length, 30); assert.equal(second.batches.length, 3); assert.equal(second.nextCursor, null);
  const ids = [...first.batches, ...second.batches].map((batch) => batch.id);
  assert.equal(new Set(ids).size, 33); assert.deepEqual(new Set(ids), new Set(matching));
});

pgtest('PostgreSQL accepts every public status as a batch-presence filter without mutating live leases', async (t) => {
  const f = await databaseFixture(t);
  const ids = new Map();
  for (const status of STATES) ids.set(status, await f.insert({ statuses: [status] }));
  for (const status of STATES) {
    const result = await f.service.listBatches({ status });
    assert.deepEqual(result.batches.map((batch) => batch.id), [ids.get(status)]);
    assert.deepEqual(result.batches[0].statusCounts, { [status]: 1 });
  }
});

pgtest('execution settings initialize at five, persist across stores and survive repeated migration', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.getExecutionSettings(), { concurrency: 5 });
  await f.store.saveExecutionSettings({ concurrency: 7 });
  await createOAuthOnboardingTables(f.pool);
  assert.deepEqual(await createOAuthOnboardingStore(f.pool).getExecutionSettings(), { concurrency: 7 });
  for (const value of [0, 21]) await assert.rejects(f.pool.query('update oauth_onboarding_settings set concurrency=$1', [value]), { code: '23514' });
  await assert.rejects(f.pool.query('insert into oauth_onboarding_settings(singleton,concurrency) values(false,5)'), { code: '23514' });
});

pgtest('legacy direct admission shares default five slots and missing configuration fails closed', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) await f.store.create(input({ email: `direct-${i}@example.test` }));
  await assert.rejects(f.store.create(input()), { code: 'CAPACITY' });
  await f.store.saveExecutionSettings({ concurrency: 6 });
  await f.store.create(input());
  await f.pool.query('delete from oauth_onboarding_settings');
  await assert.rejects(f.store.create(input({ email: 'missing@example.test' })), { code: 'OAUTH_SETTINGS_UNAVAILABLE' });
});

pgtest('settings writes serialize with admission transactions using the same database lock', async (t) => {
  const f = await fixture(t);
  const blocker = await f.pool.connect();
  const { rows: [{ pid }] } = await blocker.query('select pg_backend_pid() as pid');
  let saving;
  try {
    await blocker.query('begin');
    await blocker.query("select pg_advisory_xact_lock(hashtextextended('oauth-onboarding-admission',0))");
    saving = f.store.saveExecutionSettings({ concurrency: 2 });
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < deadline) {
      const { rows } = await f.pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))', [pid]);
      if (rows.length) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, 'save must wait for the admission lock');
    assert.deepEqual(await f.store.getExecutionSettings(), { concurrency: 5 });
    await blocker.query('commit');
    await saving;
    assert.deepEqual(await f.store.getExecutionSettings(), { concurrency: 2 });
  } finally { await blocker.query('rollback'); blocker.release(); await saving; }
});

pgtest('direct admission cannot exceed the shared queue budget when execution slots remain', async (t) => {
  const f = await fixture(t, { maxQueued: 2 });
  await f.store.create(input({ email: 'budget-a@example.test' }));
  await f.store.create(input({ email: 'budget-b@example.test' }));
  await assert.rejects(f.store.create(input()), { code: 'CAPACITY' });
});

pgtest('proxy mapping I/O reuses its held connection even with twenty keys and a one-connection pool', async (t) => {
  const { createMySiteProxyRepository } = await import('../src/my-sites.mjs');
  const f = await fixture(t, { poolOptions: { max: 1, connectionTimeoutMillis: 1500 } });
  await f.pool.query(`create table my_site_proxies(id uuid default gen_random_uuid(),
    my_site_id uuid,proxy_id uuid,my_proxy_id text,created_at timestamptz default now(),updated_at timestamptz default now())`);
  const mapping = createMySiteProxyRepository(f.pool);
  const site = randomUUID();
  await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const proxy = randomUUID();
    await f.store.withProxyLock(site, proxy, async client => {
      assert.deepEqual(await mapping.listLinks({ mySiteId: site, proxyId: proxy }, client), []);
      await mapping.createLink({ mySiteId: site, proxyId: proxy, myProxyId: i + 1 }, client);
    });
  }));
  assert.equal((await mapping.listLinks({ mySiteId: site })).length, 20);
  assert.equal(f.pool.totalCount, 1);
});
