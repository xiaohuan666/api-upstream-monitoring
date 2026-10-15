import { publicTaskBatch } from './oauth-task-history-store.mjs';
import { createHash } from 'node:crypto';
import { onboardingError, onboardingFingerprint } from './oauth-onboarding-store.mjs';
import { normalizeImportOptions } from './oauth-import-options.mjs';

export const MAX_OAUTH_BATCH_ACCOUNTS = 30;
function jobId(batchId, index) {
  const hex = createHash('sha256').update(`oauth-batch:${batchId}:${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Metadata only: request secrets must not flow into fingerprints, jobs, or saved preferences. */
export function prepareOAuthBatch(input, validateMetadata, { legacyProtection = false } = {}) {
  if (!input || !Array.isArray(input.accounts) || !input.accounts.length || input.accounts.length > MAX_OAUTH_BATCH_ACCOUNTS) {
    throw onboardingError('INVALID_BATCH', '每批需包含1至30个有效账号');
  }
  const importOptions = normalizeImportOptions(input.importOptions);
  // Only existing pre-contract request replay may omit this field; never use this for new admission.
  if (legacyProtection) delete importOptions.accountProtection;
  const first = validateMetadata({ ...input, email: input.accounts[0]?.email });
  const seen = new Set();
  const jobs = input.accounts.map((account, index) => {
    if (!account || typeof account !== 'object' || Array.isArray(account)) throw onboardingError('INVALID_BATCH', '账号行格式无效');
    const metadata = validateMetadata({ requestId: jobId(first.id, index), mySiteId: first.mySiteId,
      proxyId: first.proxyId, groupIds: first.groupIds, email: account.email });
    if (seen.has(metadata.email)) throw onboardingError('DUPLICATE_BATCH_ACCOUNT', '本批次存在重复账号，请去重后再提交');
    seen.add(metadata.email);
    const job = { ...metadata, importOptions };
    return { ...job, fingerprint: onboardingFingerprint(job) };
  });
  const fingerprint = createHash('sha256').update(JSON.stringify(jobs.map((job) => job.fingerprint))).digest('hex');
  return { id: first.id, mySiteId: first.mySiteId, proxyId: first.proxyId, groupIds: first.groupIds, importOptions, fingerprint, jobs };
}

export const publicOnboardingBatch = publicTaskBatch;
