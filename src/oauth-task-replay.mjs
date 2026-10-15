import { normalizeImportOptions } from './oauth-import-options.mjs';
import { createHash } from 'node:crypto';
import { onboardingError } from './oauth-onboarding-store.mjs';
import { ACTIVE_TASK_STATES } from './oauth-task-history-store.mjs';
import { prepareOAuthBatch, publicOnboardingBatch } from './oauth-onboarding-batch.mjs';

/** Explicit replay is a new admission, not a retry of the original external write. */
export function createOAuthTaskReplay({ store, vault, validateMetadata, resolveSite, resolveProxy, sameProxy,
  verifyGroups, verifyImportCapability, clientFactory, ownerId, queue, isClosing }) {
  return async function replay(kind, sourceId, requestId) {
    const fingerprint = createHash('sha256').update(`oauth-rerun:${kind}:${sourceId}`).digest('hex');
    const previous = await store.getBatch(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw onboardingError('IDEMPOTENCY_CONFLICT', '此提交编号已用于其他操作', 409);
      return publicOnboardingBatch(previous);
    }
    vault.assertReady();
    const source = kind === 'batch' ? await store.getBatch(sourceId) : await store.get(sourceId);
    if (!source) throw onboardingError('JOB_NOT_FOUND', '原任务不存在', 404);
    const jobs = kind === 'batch' ? source.jobs : [source];
    if (!jobs.length || jobs.some((job) => !job.credentialStored)) throw onboardingError('LEGACY_TASK_READ_ONLY', '旧任务未保存凭据，仅支持查看', 409);
    if (jobs.some((job) => ACTIVE_TASK_STATES.includes(job.status))) throw onboardingError('ACCOUNT_BUSY', '任务仍在进行中，不能重跑', 409);
    const secrets = [];
    try {
      for (const job of jobs) secrets.push(vault.open(job, await store.getJobEnvelope(job.id)));
      const first = jobs[0];
      const site = await resolveSite(first.mySiteId, first.targetUrl);
      const proxy = await resolveProxy(first.proxyId);
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (job.mySiteId !== first.mySiteId || job.targetUrl !== first.targetUrl || job.proxyId !== first.proxyId
            || JSON.stringify(job.groupIds) !== JSON.stringify(first.groupIds)
            || JSON.stringify(normalizeImportOptions(first.importOptions)) !== JSON.stringify(normalizeImportOptions(job.importOptions))) {
          throw onboardingError('BATCH_SNAPSHOT_MISMATCH', '原批次配置不一致，不能整批重跑', 409);
        }
        const snapshot = secrets[i].proxySnapshot;
        if (Boolean(proxy) !== Boolean(snapshot) || (proxy && !sameProxy(proxy, snapshot))) throw onboardingError('PROXY_CHANGED', '原代理配置已变化，不能沿用原任务重跑', 409);
      }
      const client = clientFactory({ baseUrl: site.url, adminKey: site.adminKey });
      await verifyGroups(client, first.groupIds);
      await verifyImportCapability(client, first.importOptions);
      const prepared = prepareOAuthBatch({ requestId, mySiteId: first.mySiteId, proxyId: first.proxyId,
        groupIds: first.groupIds, importOptions: first.importOptions, accounts: jobs.map(({ email }) => ({ email })) }, validateMetadata);
      prepared.fingerprint = fingerprint;
      prepared.sourceBatchId = kind === 'batch' ? source.id : first.batchId ?? first.id;
      prepared.targetUrl = first.targetUrl;
      prepared.ownerId = ownerId;
      prepared.jobs = prepared.jobs.map((job, index) => {
        const metadata = { ...job, targetUrl: first.targetUrl, accountName: jobs[index].accountName,
          sourceJobId: jobs[index].id };
        return { ...metadata, envelope: vault.seal(metadata, secrets[index]) };
      });
      if (isClosing()) throw onboardingError('SHUTTING_DOWN', '服务正在重启，请稍后再试', 503);
      const { batch, created } = await store.createBatch(prepared);
      if (created) {
        const byId = new Map(prepared.jobs.map((job, index) => [job.id, secrets[index]]));
        for (const job of batch.jobs) queue.enqueue(job, { ...byId.get(job.id) });
      }
      return publicOnboardingBatch(batch);
    } finally { for (const secret of secrets) { secret.password = ''; secret.totpSecret = ''; secret.proxySnapshot = null; } }
  };
}
