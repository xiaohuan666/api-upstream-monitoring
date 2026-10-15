import { withOAuthProxyLock } from './oauth-proxy-lock.mjs';
import { createOAuthExecutionSettingsTable, createOAuthExecutionSettingsStore, readOAuthExecutionSettings } from './oauth-execution-settings.mjs';
import { insertOAuthJobSecret } from './oauth-task-history-store.mjs';
import { createHash } from 'node:crypto';
import { createOAuthBatchStore, createOAuthBatchTables } from './oauth-onboarding-batch-store.mjs';

const ACTIVE = ['queued', 'running', 'pushing'];
export const OAUTH_JOB_STATES = [...ACTIVE, 'succeeded', 'failed', 'needs_attention', 'uncertain'];
const PATCH_COLUMNS = { status: 'status', stage: 'stage', errorCode: 'error_code', message: 'message', remoteAccountId: 'remote_account_id', remoteProxyId: 'remote_proxy_id', chatgptAccountId: 'chatgpt_account_id', chatgptUserId: 'chatgpt_user_id' };

export function onboardingError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, safe: true });
}

export function onboardingFingerprint(input) {
  // Secret changes must never turn an uncertain write into a new operation.
  return createHash('sha256').update(JSON.stringify({
    mySiteId: input.mySiteId, email: input.email, proxyId: input.proxyId,
    groupIds: [...input.groupIds].sort((a, b) => a - b),
    ...(input.importOptions ? { importOptions: input.importOptions } : {}),
  })).digest('hex');
}

export async function createOAuthOnboardingTables(pool) {
  await pool.query(`create table if not exists oauth_onboarding_jobs (
    id uuid primary key,
    fingerprint text not null,
    my_site_id uuid not null,
    target_url text not null,
    email text not null,
    proxy_id uuid,
    group_ids bigint[] not null,
    remote_proxy_id bigint,
    remote_account_id bigint,
    chatgpt_account_id text not null default '',
    chatgpt_user_id text not null default '',
    status text not null check (status in ('queued','running','pushing','succeeded','failed','needs_attention','uncertain')),
    stage text not null default 'validating',
    error_code text not null default '',
    message text not null default '',
    owner_id uuid not null,
    lease_until timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);
  await pool.query("alter table oauth_onboarding_jobs add column if not exists chatgpt_account_id text not null default '', add column if not exists chatgpt_user_id text not null default ''");
  await pool.query(`create unique index if not exists oauth_onboarding_active_seat_v2
    on oauth_onboarding_jobs (my_site_id, chatgpt_account_id, chatgpt_user_id)
    where status in ('queued','running','pushing') and chatgpt_account_id <> '' and chatgpt_user_id <> ''`);
  // No cascading FK: deleting a target must not erase evidence of a possibly committed remote write.
  await pool.query(`create unique index if not exists oauth_onboarding_active_identity_v2
    on oauth_onboarding_jobs (my_site_id, email)
    where status in ('queued','running','pushing')`);
  await pool.query('create index if not exists oauth_onboarding_recent on oauth_onboarding_jobs (created_at desc)');
  await createOAuthBatchTables(pool);
  await createOAuthExecutionSettingsTable(pool);
  await pool.query('drop index if exists oauth_onboarding_active_seat');
  await pool.query('drop index if exists oauth_onboarding_active_identity');
}

export function normalizeOnboardingRow(row) {
  if (!row) return null;
  const iso = (value) => value instanceof Date ? value.toISOString() : value;
  return {
    id: row.id, fingerprint: row.fingerprint, mySiteId: row.my_site_id, targetUrl: row.target_url,
    creationKey: row.creation_key ?? '', batchId: row.batch_id ?? null, importOptions: row.import_options ?? null,
    credentialStored: row.credential_stored === true, accountName: row.account_name || row.email,
    sourceJobId: row.source_job_id ?? null, startedAt: iso(row.started_at) ?? null, finishedAt: iso(row.finished_at) ?? null,
    email: row.email, proxyId: row.proxy_id, groupIds: row.group_ids.map(Number),
    chatgptAccountId: row.chatgpt_account_id, chatgptUserId: row.chatgpt_user_id,
    remoteProxyId: row.remote_proxy_id == null ? null : Number(row.remote_proxy_id),
    remoteAccountId: row.remote_account_id == null ? null : Number(row.remote_account_id),
    status: row.status, stage: row.stage, errorCode: row.error_code, message: row.message,
    ownerId: row.owner_id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

export function publicOnboardingJob(job) {
  if (!job) return null;
  const { id, batchId, importOptions, mySiteId, email, proxyId, groupIds, remoteAccountId, status, stage, errorCode, message, createdAt, updatedAt } = job;
  return { accountName: job.accountName || email, startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null,
    sourceJobId: job.sourceJobId ?? null, canRerun: job.credentialStored === true && !ACTIVE.includes(status),
    id, batchId, importOptions, mySiteId, email, proxyId, groupIds, remoteAccountId, status, stage, errorCode, message, createdAt, updatedAt };
}

export function createOAuthOnboardingStore(pool, { leaseMs = 120_000, maxQueued = 60 } = {}) {
  async function expireRows(client) {
    await client.query(`update oauth_onboarding_jobs set
      status = case when status = 'pushing' then 'uncertain' else 'needs_attention' end,
      error_code = case when status = 'pushing' then 'WRITE_UNCERTAIN' else 'TASK_INTERRUPTED' end,
      message = case when status = 'pushing' then '推送结果不明，请先对账，勿重复创建' when credential_stored then '任务已中断，可在入池任务中显式重跑' else '任务已中断，请重新输入凭据发起任务' end,
      updated_at = now(), finished_at = coalesce(finished_at,now())
      where status in ('queued','running','pushing') and lease_until < now()`);
  }
  async function expireStale(lockedClient = null) {
    // Removing a row from the active unique indexes is an admission decision too.
    // Reuse the caller's locked transaction; history reads need their own transaction.
    if (lockedClient) return expireRows(lockedClient);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtextextended('oauth-onboarding-admission',0))");
      await expireRows(client);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
  async function get(id) {
    return normalizeOnboardingRow((await pool.query('select * from oauth_onboarding_jobs where id = $1', [id])).rows[0]);
  }
  return {
    ...createOAuthExecutionSettingsStore(pool),
    ...createOAuthBatchStore(pool, { leaseMs, maxQueued, expireStale, normalize: normalizeOnboardingRow }),
    expireStale, get,
    async list() {
      await expireStale();
      return (await pool.query('select * from oauth_onboarding_jobs order by created_at desc limit 30')).rows.map(normalizeOnboardingRow);
    },
    async listPage({ scope = 'all', before = null } = {}) {
      await expireStale();
      const rows = (await pool.query(`select * from oauth_onboarding_jobs j
        where ($1='all' or status in ('queued','running','pushing','uncertain','needs_attention'))
        and ($2::uuid is null or (j.created_at,j.id) < (select created_at,id from oauth_onboarding_jobs where id=$2))
        order by created_at desc,id desc limit 31`, [scope, before])).rows;
      const jobs = rows.slice(0, 30).map(normalizeOnboardingRow);
      return { jobs, nextCursor: rows.length > 30 ? jobs.at(-1).id : null };
    },
    async create(input) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Serialize admission across processes, not the long-running browser work.
        await client.query("select pg_advisory_xact_lock(hashtextextended('oauth-onboarding-admission',0))");
        await expireStale(client);
        const previous = normalizeOnboardingRow((await client.query('select * from oauth_onboarding_jobs where id=$1', [input.id])).rows[0]);
        if (previous) {
          if (previous.fingerprint !== input.fingerprint) throw onboardingError('IDEMPOTENCY_CONFLICT', '此提交编号已用于不同的账号或选项', 409);
          await client.query('commit');
          return { job: previous, created: false };
        }
        if (input.envelope && (await client.query('select id from oauth_onboarding_batches where id=$1', [input.id])).rowCount) {
          throw onboardingError('IDEMPOTENCY_CONFLICT', '此提交编号已用于其他批次操作', 409);
        }
        const duplicate = (await client.query(`select id from oauth_onboarding_jobs where my_site_id=$1 and email=$2
          and status in ('queued','running','pushing','uncertain')`, [input.mySiteId, input.email])).rows[0];
        if (duplicate) throw onboardingError('ACCOUNT_BUSY', '该账号已有进行中或结果不明的任务，请查看记录并先对账', 409);
        const { concurrency } = await readOAuthExecutionSettings(client);
        // This compatibility endpoint reserves a slot and starts immediately;
        // ordinary batch-queued rows are not occupied execution slots.
        const counts = (await client.query(`select count(*) as total,
          count(*) filter (where status in ('running','pushing') or batch_id is null) as executing
          from oauth_onboarding_jobs where status in ('queued','running','pushing')`)).rows[0];
        if (Number(counts.total) >= maxQueued) throw onboardingError('CAPACITY', '后台队列已满，请等待当前任务完成再提交', 429);
        if (Number(counts.executing) >= concurrency) throw onboardingError('CAPACITY', '当前授权任务已满，请稍后重试', 429);
        if (input.envelope) await client.query('insert into oauth_onboarding_batches(id,fingerprint,my_site_id) values($1,$2,$3)', [input.id, input.fingerprint, input.mySiteId]);
        const result = await client.query(`insert into oauth_onboarding_jobs
          (id,fingerprint,my_site_id,target_url,email,proxy_id,group_ids,status,owner_id,lease_until,creation_key,batch_id,import_options,credential_stored,account_name)
          values ($1,$2,$3,$4,$5,$6,$7,case when $13 then 'running' else 'queued' end,$8,now()+$9*interval '1 millisecond',$10,$11,$12::jsonb,$13,$14) returning *`,
        [input.id, input.fingerprint, input.mySiteId, input.targetUrl, input.email, input.proxyId, input.groupIds, input.ownerId, leaseMs, `oauth-account-${input.id}`, input.envelope ? input.id : null, JSON.stringify(input.importOptions ?? null), Boolean(input.envelope), input.accountName ?? input.email]);
        if (input.envelope) await insertOAuthJobSecret(client, input.id, input.envelope);
        await client.query('commit');
        return { job: normalizeOnboardingRow(result.rows[0]), created: true };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally { client.release(); }
    },
    async heartbeat(id, ownerId) {
      const result = await pool.query(`update oauth_onboarding_jobs set lease_until=now()+$3*interval '1 millisecond'
        where id=$1 and owner_id=$2 and status in ('queued','running','pushing') and lease_until>now()`, [id, ownerId, leaseMs]);
      return result.rowCount === 1;
    },
    async update(id, ownerId, patch) {
      const entries = Object.entries(patch);
      if (!entries.length || entries.some(([key]) => !PATCH_COLUMNS[key]) || (patch.status && !OAUTH_JOB_STATES.includes(patch.status))) {
        throw new Error('Invalid onboarding patch');
      }
      const clauses = entries.map(([key], i) => `${PATCH_COLUMNS[key]}=$${i + 3}`);
      if (patch.status === 'running') clauses.push('started_at=coalesce(started_at,now())');
      if (patch.status && !ACTIVE.includes(patch.status)) clauses.push('finished_at=now()');
      let result;
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query("select pg_advisory_xact_lock(hashtextextended('oauth-onboarding-admission',0))");
        if (patch.chatgptAccountId || patch.chatgptUserId) {
          const current = normalizeOnboardingRow((await client.query('select * from oauth_onboarding_jobs where id=$1', [id])).rows[0]);
          if (current && !current.sourceJobId) {
            const duplicate = (await client.query(`select id from oauth_onboarding_jobs where id<>$1 and my_site_id=$2
              and status='uncertain' and chatgpt_account_id=$3 and chatgpt_user_id=$4 and chatgpt_account_id<>'' and chatgpt_user_id<>'' limit 1`,
            [id, current.mySiteId, patch.chatgptAccountId ?? current.chatgptAccountId, patch.chatgptUserId ?? current.chatgptUserId])).rows[0];
            if (duplicate) throw onboardingError('ACCOUNT_BUSY', '相同 OAuth 身份存在结果不明的任务，请先核实或显式重跑', 409);
          }
        }
        result = await client.query(`update oauth_onboarding_jobs set ${clauses.join(',')},updated_at=now()
          where id=$1 and owner_id=$2 and status in ('queued','running','pushing') and lease_until>now() returning *`, [id, ownerId, ...entries.map(([, value]) => value)]);
        if (!result.rowCount) throw onboardingError('LEASE_LOST', '任务已中断，请查看任务记录', 409);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        if (error.code === '23505') throw onboardingError('ACCOUNT_BUSY', '相同 OAuth 身份已有进行中的任务，请先核实', 409);
        throw error;
      } finally { client.release(); }
      return normalizeOnboardingRow(result.rows[0]);
    },
    async reconcileSuccess(id, accountId) {
      const result = await pool.query(`update oauth_onboarding_jobs set status='succeeded',stage='done',remote_account_id=$2,
        finished_at=coalesce(finished_at,now()),error_code='',message='已核实远端账号及分组、代理一致',updated_at=now() where id=$1 and status='uncertain' returning *`, [id, accountId]);
      return normalizeOnboardingRow(result.rows[0]) ?? await get(id);
    },
    withProxyLock: (mySiteId, proxyId, fn, options) => withOAuthProxyLock(pool, mySiteId, proxyId, fn, options),
  };
}
