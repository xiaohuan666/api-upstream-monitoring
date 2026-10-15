import { onboardingError, publicOnboardingJob } from './oauth-onboarding-store.mjs';

export const ACTIVE_TASK_STATES = ['queued', 'running', 'pushing'];
export function summarizeOAuthBatch(batch, email = '') {
  const jobs = batch.jobs;
  const matched = jobs.filter((job) => job.email.toLowerCase().includes(email.toLowerCase()));
  return {
    id: batch.id, createdAt: batch.createdAt ?? jobs[0]?.createdAt,
    total: jobs.length, matchedCount: matched.length,
    statusCounts: jobs.reduce((counts, job) => { counts[job.status] = (counts[job.status] ?? 0) + 1; return counts; }, {}),
    canRerun: jobs.length > 0 && jobs.every((job) => job.credentialStored && !ACTIVE_TASK_STATES.includes(job.status)),
    legacy: jobs.some((job) => !job.credentialStored), sourceBatchId: batch.sourceBatchId ?? null,
  };
}
export function publicTaskBatch(batch, email = '') {
  return { ...summarizeOAuthBatch(batch, email), jobs: batch.jobs
    .filter((job) => job.email.toLowerCase().includes(email.toLowerCase())).map(publicOnboardingJob) };
}

/** The history query never joins the credential table. SQL substring search treats % and _ literally. */
export function createOAuthTaskHistoryStore(pool, { getBatch }) {
  return {
    async getJobEnvelope(id) {
      return (await pool.query('select envelope from oauth_onboarding_job_secrets where job_id=$1', [id])).rows[0]?.envelope ?? null;
    },
    async listBatches({ email = '', before = null, status = null, mySiteId = null, createdFrom = null, createdBefore = null } = {}) {
      const rows = (await pool.query(`with batches as (
        select id,created_at,my_site_id from oauth_onboarding_batches
        union all select id,created_at,my_site_id from oauth_onboarding_jobs where batch_id is null
      ) select b.id from batches b where
        ($1='' or exists(select 1 from oauth_onboarding_jobs j where coalesce(j.batch_id,j.id)=b.id and strpos(lower(j.email),lower($1))>0))
        and ($2::uuid is null or (b.created_at,b.id)<(select created_at,id from batches where id=$2))
        and ($3::text is null or exists(select 1 from oauth_onboarding_jobs j where coalesce(j.batch_id,j.id)=b.id and j.status=$3))
        and ($4::uuid is null or b.my_site_id=$4)
        and ($5::timestamptz is null or b.created_at >= $5)
        and ($6::timestamptz is null or b.created_at < $6)
        order by b.created_at desc,b.id desc limit 31`, [email, before, status, mySiteId, createdFrom, createdBefore])).rows;
      const batches = await Promise.all(rows.slice(0, 30).map(async (row) => summarizeOAuthBatch(await getBatch(row.id), email)));
      return { batches, nextCursor: rows.length > 30 ? batches.at(-1).id : null };
    },
  };
}

export async function insertOAuthJobSecret(client, jobId, envelope) {
  if (!envelope) throw onboardingError('CREDENTIALS_UNAVAILABLE', '新任务必须保存加密凭据', 503);
  await client.query('insert into oauth_onboarding_job_secrets(job_id,envelope) values($1,$2)', [jobId, envelope]);
}
