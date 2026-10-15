import { readOAuthExecutionSettings } from './oauth-execution-settings.mjs';
import { createOAuthTaskHistoryStore, insertOAuthJobSecret } from './oauth-task-history-store.mjs';
import { onboardingError } from './oauth-onboarding-store.mjs';
import { defaultImportOptions, normalizeImportOptions } from './oauth-import-options.mjs';

export async function createOAuthBatchTables(pool) {
  await pool.query(`alter table oauth_onboarding_jobs
    add column if not exists credential_stored boolean not null default false,
    add column if not exists account_name text not null default '',
    add column if not exists source_job_id uuid,
    add column if not exists started_at timestamptz,
    add column if not exists finished_at timestamptz,
    add column if not exists batch_id uuid,
    add column if not exists import_options jsonb,
    add column if not exists creation_key text not null default ''`);
  await pool.query(`create table if not exists oauth_onboarding_batches (
    id uuid primary key, fingerprint text not null, my_site_id uuid not null,
    created_at timestamptz not null default now()
  )`);
  await pool.query('alter table oauth_onboarding_batches add column if not exists source_batch_id uuid');
  await pool.query(`create table if not exists oauth_onboarding_job_secrets (job_id uuid primary key references oauth_onboarding_jobs(id) on delete cascade, envelope text not null)`);
  await pool.query('create index if not exists oauth_onboarding_batch_jobs on oauth_onboarding_jobs(batch_id)');
  await pool.query(`create table if not exists oauth_import_preferences (
    my_site_id uuid primary key, group_ids bigint[] not null, import_options jsonb not null,
    updated_at timestamptz not null default now()
  )`);
}

/** Batch admission and preferences commit together; only encrypted credentials enter this repository. */
export function createOAuthBatchStore(pool, { leaseMs, maxQueued, expireStale, normalize }) {
  const lock = (client) => client.query("select pg_advisory_xact_lock(hashtextextended('oauth-onboarding-admission',0))");
  async function getBatch(id, client = pool) {
    const row = (await client.query('select * from oauth_onboarding_batches where id=$1', [id])).rows[0];
    const jobs = (await client.query('select * from oauth_onboarding_jobs where batch_id=$1 or (batch_id is null and id=$1) order by created_at,id', [id])).rows.map(normalize);
    if (!row && !jobs.length) return null;
    return { id, fingerprint: row?.fingerprint ?? jobs[0].fingerprint, createdAt: row?.created_at?.toISOString() ?? jobs[0]?.createdAt, sourceBatchId: row?.source_batch_id ?? null, jobs };
  }
  return {
    getBatch,
    ...createOAuthTaskHistoryStore(pool, { normalize, getBatch }),
    async getImportPreferences(mySiteId) {
      const row = (await pool.query('select group_ids,import_options from oauth_import_preferences where my_site_id=$1', [mySiteId])).rows[0];
      return row ? { groupIds: row.group_ids.map(Number), importOptions: normalizeImportOptions(row.import_options) }
        : { groupIds: [], importOptions: defaultImportOptions() };
    },
    async createBatch(input) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await lock(client);
        await expireStale(client);
        const previous = await getBatch(input.id, client);
        if (previous) {
          if (previous.fingerprint !== input.fingerprint) throw onboardingError('IDEMPOTENCY_CONFLICT', '此提交编号已用于不同的账号或选项', 409);
          await client.query('commit');
          return { batch: previous, created: false };
        }
        const options = normalizeImportOptions(input.importOptions);
        const duplicate = (await client.query(`select id from oauth_onboarding_jobs where my_site_id=$1 and email=any($2::text[])
          and (status in ('queued','running','pushing') or (status='uncertain' and not $3)) limit 1`, [input.mySiteId, input.jobs.map((job) => job.email), Boolean(input.sourceBatchId)])).rows[0];
        if (duplicate) throw onboardingError('ACCOUNT_BUSY', '本批次有账号已有进行中或结果不明的任务，请先核实记录', 409);
        const count = Number((await client.query("select count(*) from oauth_onboarding_jobs where status in ('queued','running','pushing')")).rows[0].count);
        if (count + input.jobs.length > maxQueued) throw onboardingError('CAPACITY', '后台队列已满，请等待当前任务完成再提交', 429);
        await client.query('insert into oauth_onboarding_batches(id,fingerprint,my_site_id,source_batch_id) values($1,$2,$3,$4)', [input.id, input.fingerprint, input.mySiteId, input.sourceBatchId ?? null]);
        const jobs = [];
        for (const job of input.jobs) {
          const row = (await client.query(`insert into oauth_onboarding_jobs
            (id,fingerprint,my_site_id,target_url,email,proxy_id,group_ids,owner_id,lease_until,status,batch_id,import_options,creation_key,credential_stored,account_name,source_job_id)
            values($1,$2,$3,$4,$5,$6,$7,$8,now()+$9*interval '1 millisecond','queued',$10,$11::jsonb,$12,$13,$14,$15) returning *`,
          [job.id, job.fingerprint, input.mySiteId, input.targetUrl, job.email, input.proxyId, input.groupIds, input.ownerId, leaseMs, input.id, JSON.stringify(options), `oauth-account-${job.id}`, Boolean(job.envelope), job.accountName ?? job.email, job.sourceJobId ?? null])).rows[0];
          await insertOAuthJobSecret(client, job.id, job.envelope);
          jobs.push(normalize(row));
        }
        if (!input.sourceBatchId) await client.query(`insert into oauth_import_preferences(my_site_id,group_ids,import_options) values($1,$2,$3::jsonb)
          on conflict(my_site_id) do update set group_ids=excluded.group_ids,import_options=excluded.import_options,updated_at=now()`,
        [input.mySiteId, input.groupIds, JSON.stringify(options)]);
        await client.query('commit');
        return { batch: { id: input.id, fingerprint: input.fingerprint, sourceBatchId: input.sourceBatchId ?? null, jobs }, created: true };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally { client.release(); }
    },
    async claimQueued(id, ownerId) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await lock(client);
        await expireStale(client);
        const job = normalize((await client.query('select * from oauth_onboarding_jobs where id=$1 for update', [id])).rows[0]);
        if (!job || job.ownerId !== ownerId || job.status !== 'queued') throw onboardingError('LEASE_LOST', '排队任务已中断', 409);
        // Legacy submissions start immediately, so their queued rows also reserve execution slots.
        const count = Number((await client.query(`select count(*) from oauth_onboarding_jobs
          where status in ('running','pushing') or (status='queued' and batch_id is null)`)).rows[0].count);
        const { concurrency } = await readOAuthExecutionSettings(client);
        if (count >= concurrency) { await client.query('commit'); return null; }
        const row = (await client.query(`update oauth_onboarding_jobs set status='running',started_at=coalesce(started_at,now()),updated_at=now()
          where id=$1 and owner_id=$2 and lease_until>now() returning *`, [id, ownerId])).rows[0];
        if (!row) throw onboardingError('LEASE_LOST', '排队任务已中断', 409);
        await client.query('commit');
        return normalize(row);
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },
  };
}
