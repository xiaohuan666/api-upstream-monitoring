import { OAUTH_EXECUTION_LIMITS, validateOAuthExecutionSettings } from './oauth-execution-settings.mjs';
import { createOAuthCredentialVault } from './oauth-credential-vault.mjs';
import { createOAuthTaskReplay } from './oauth-task-replay.mjs';
import { normalizeImportOptions } from './oauth-import-options.mjs';
import { readOAuthIdentity, compareOAuthIdentity, provesAccountEmail } from './oauth-account-identity.mjs';
import { accountMatchesImportOptions } from './oauth-import-options.mjs';
import { prepareOAuthBatch, publicOnboardingBatch } from './oauth-onboarding-batch.mjs';
import { createOAuthOnboardingQueue } from './oauth-onboarding-queue.mjs';
import { randomUUID } from 'node:crypto';
import { loginOpenAI, oauthLoginProxyOptions, sanitizeOAuthChallenge } from './oauth-login.mjs';
import { loginWithChallengeRetry } from './oauth-login-retry.mjs';
import { normalizeTotpSecret } from './oauth-totp.mjs';
import { createOAuthSub2Client, buildOAuthCredentials } from './oauth-sub2-client.mjs';
import { onboardingError, onboardingFingerprint, publicOnboardingJob } from './oauth-onboarding-store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_STAGES = new Set(['warmup', 'csrf', 'authorizing', 'email', 'password', 'totp', 'consent']);
const emailKey = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const isActiveProxy = (proxy, now) => proxy?.status === 'active' && (!proxy.expiresAt || Date.parse(proxy.expiresAt) > now);
const targetUrl = (site) => new URL(site.url).toString();

function validateMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || !UUID.test(input.requestId ?? '') || !UUID.test(input.mySiteId ?? '')
      || (input.proxyId != null && !UUID.test(input.proxyId))) {
    throw onboardingError('INVALID_INPUT', '请选择有效的目标站点、代理并使用有效提交编号');
  }
  const email = emailKey(input.email);
  if (email.length > 254 || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(email)) {
    throw onboardingError('INVALID_EMAIL', '请输入有效的账号邮箱');
  }
  if (!Array.isArray(input.groupIds) || !input.groupIds.length || input.groupIds.length > 100
      || input.groupIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(input.groupIds).size !== input.groupIds.length) {
    throw onboardingError('INVALID_GROUPS', '至少选择一个分组，分组编号必须有效且不重复');
  }
  return { id: input.requestId.toLowerCase(), mySiteId: input.mySiteId.toLowerCase(), email,
    proxyId: input.proxyId?.toLowerCase() ?? null, groupIds: [...input.groupIds].sort((a, b) => a - b) };
}

function proxySnapshot(proxy) {
  if (!proxy) return null;
  const { protocol, host, port, username = '', password = '' } = proxy;
  return { protocol, host, port, username, password };
}

function sameProxy(a, b) {
  return a.protocol === b.protocol && String(a.host).toLowerCase() === String(b.host).toLowerCase()
    && Number(a.port) === Number(b.port) && (a.username ?? '') === (b.username ?? '') && (a.password ?? '') === (b.password ?? '');
}

function accountMatchesJob(account, job) {
  const ids = account.group_ids ?? account.groupIds ?? account.groups?.map((group) => group.id) ?? [];
  const remoteProxyId = account.proxy_id ?? account.proxyId ?? null;
  const expectedIdentity = { accountId: job.chatgptAccountId, userId: job.chatgptUserId };
  return account.platform === 'openai' && account.type === 'oauth'
    && (job.creationKey ? account.extra?.oauth_onboarding_creation_key === job.creationKey : !account.extra?.oauth_onboarding_creation_key)
    && provesAccountEmail(account, job.email)
    && compareOAuthIdentity(readOAuthIdentity(account.credentials), expectedIdentity) === 'same'
    && Number.isSafeInteger(Number(account.id)) && Number(account.id) > 0
    && (remoteProxyId == null ? null : Number(remoteProxyId)) === job.remoteProxyId
    && (!job.importOptions || accountMatchesImportOptions(account, job.importOptions))
    && ids.length === job.groupIds.length && job.groupIds.every((id) => ids.map(Number).includes(id));
}

function safeError(error) {
  if (error?.safe === true && typeof error.code === 'string') return error;
  return onboardingError('INTERNAL_ERROR', '任务处理失败，请重试或检查服务运行状态', 500);
}

/** New admissions atomically store encrypted credentials; plaintext is limited to admission/execution. */
export function createOAuthOnboardingService({
  store, mySiteRepository, proxyRepository, mySiteProxyRepository,
  clientFactory = createOAuthSub2Client, login = loginOpenAI, now = () => Date.now(),
  credentialVault = createOAuthCredentialVault(), ownerId = randomUUID(), heartbeatMs = 30_000, logger = console,
  retryWait,
}) {
  const running = new Map();
  const admissions = new Set();
  let closing = false;
  const queue = createOAuthOnboardingQueue({ store, ownerId, execute, heartbeatMs });

  const replayTask = createOAuthTaskReplay({ store, vault: credentialVault, validateMetadata, resolveSite, resolveProxy, sameProxy,
    verifyGroups, verifyImportCapability, clientFactory, ownerId, queue, isClosing: () => closing });

  async function rerun(kind, id, body) {
    if (!UUID.test(id ?? '') || !UUID.test(body?.requestId ?? '') || Object.keys(body).some((key) => key !== 'requestId')) {
      throw onboardingError('INVALID_INPUT', '请使用有效的任务和提交编号');
    }
    if (closing) throw onboardingError('SHUTTING_DOWN', '服务正在重启，请稍后再试', 503);
    const promise = (async () => { await store.expireStale(); return replayTask(kind, id.toLowerCase(), body.requestId.toLowerCase()); })();
    admissions.add(promise);
    try { return await promise; } finally { admissions.delete(promise); }
  }

  function validatePage(params = {}) {
    const allowed = new Set(['email', 'before', 'status', 'mySiteId', 'createdFrom', 'createdBefore']);
    const statuses = new Set(['queued', 'running', 'pushing', 'succeeded', 'failed', 'needs_attention', 'uncertain']);
    const invalid = () => onboardingError('INVALID_PAGE', '无效的任务搜索或分页参数');
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some((key) => !allowed.has(key))) throw invalid();
    const { email = '', before = null, status = null, mySiteId = null, createdFrom = null, createdBefore = null } = params;
    if (typeof email !== 'string' || email.length > 254
        || (before !== null && (typeof before !== 'string' || !UUID.test(before)))
        || (status !== null && (typeof status !== 'string' || (status !== '' && !statuses.has(status))))
        || (mySiteId !== null && (typeof mySiteId !== 'string' || (mySiteId !== '' && !UUID.test(mySiteId))))) throw invalid();
    const timestamp = (value) => {
      if (value === null || value === '') return null;
      // Require an explicit UTC instant, including a real calendar date; Date.parse alone normalizes impossible dates.
      if (typeof value !== 'string' || value.startsWith('0000-') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw invalid();
      const parsed = new Date(value);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) throw invalid();
      return parsed.toISOString();
    };
    const from = timestamp(createdFrom);
    const until = timestamp(createdBefore);
    if (from && until && from >= until) throw invalid();
    return { email: email.trim().toLowerCase(), before, status: status || null, mySiteId: mySiteId || null,
      createdFrom: from, createdBefore: until };
  }

  async function resolveSite(id, expectedUrl = null) {
    const site = await mySiteRepository.getMySiteById(id);
    if (!site || site.type !== 'sub2api' || !site.adminKey) throw onboardingError('TARGET_UNAVAILABLE', '目标 Sub2API 未配置或缺少管理凭据', 400);
    const url = targetUrl(site);
    // Do not send admin credentials over cleartext; production targets are HTTPS.
    if (new URL(url).protocol !== 'https:') throw onboardingError('TARGET_INSECURE', 'OAuth 入池目标必须使用 HTTPS', 400);
    if (expectedUrl && url !== expectedUrl) throw onboardingError('TARGET_CHANGED', '目标地址已改变，不能继续原任务或对账', 409);
    return site;
  }

  async function resolveProxy(id) {
    if (!id) return null;
    const proxy = await proxyRepository.getProxyById(id);
    if (!isActiveProxy(proxy, now())) throw onboardingError('PROXY_UNAVAILABLE', '所选代理已停用、过期或不存在');
    oauthLoginProxyOptions(proxy);
    return proxy;
  }

  async function verifyGroups(client, groupIds) {
    const groups = await client.listGroups();
    if (groupIds.some((id) => !groups.some((group) => Number(group.id) === id && group.platform === 'openai' && group.status === 'active'))) {
      throw onboardingError('GROUP_UNAVAILABLE', '所选分组已停用、删除或不是 OpenAI 分组，请重新选择');
    }
  }

  async function ensureRemoteProxy(job, proxy, client, signal) {
    if (!proxy) return null;
    return store.withProxyLock(job.mySiteId, proxy.id, async (mappingClient) => {
      const links = await mySiteProxyRepository.listLinks({ mySiteId: job.mySiteId, proxyId: proxy.id }, mappingClient);
      if (links.length) {
        const id = Number(links[0].myProxyId);
        const remote = await client.getProxy(id);
        if (!sameProxy(remote, proxy) || !isActiveProxy(remote, now())) {
          throw onboardingError('PROXY_MAPPING_STALE', '远端代理映射与所选代理不一致或已失效，请先在 IP 管理中同步', 409);
        }
        return id;
      }
      const candidates = (await client.listProxies()).filter((item) => sameProxy(item, proxy) && isActiveProxy(item, now()));
      let remote = candidates[0];
      if (!remote) remote = await client.createProxy(proxy, { idempotencyKey: `oauth-proxy-${job.id}` });
      const id = Number(remote.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw onboardingError('PROXY_MAPPING_FAILED', '远端代理未返回有效编号，请检查 IP 管理', 502);
      await mySiteProxyRepository.createLink({ mySiteId: job.mySiteId, proxyId: proxy.id, myProxyId: String(id) }, mappingClient);
      return id;
    }, { signal });
  }

  async function execute(job, secrets, controller) {
    let pushStarted = false;
    let loginAttempt = 1;
    let heartbeating = false;
    let timer;
    const patch = async (values) => {
      if (controller.signal.aborted && !pushStarted) throw onboardingError('TASK_INTERRUPTED', job.credentialStored ? '任务已中断，可在入池任务中显式重跑' : '任务已中断，请重新输入凭据发起任务');
      job = await store.update(job.id, ownerId, values);
      logger.info?.('[oauth-onboarding]', { jobId: job.id, stage: job.stage, status: job.status, attempt: loginAttempt });
    };
    try {
      timer = setInterval(async () => {
        if (heartbeating) return;
        heartbeating = true;
        try { if (!await store.heartbeat(job.id, ownerId)) controller.abort(); }
        catch { controller.abort(); }
        finally { heartbeating = false; }
      }, heartbeatMs);
      timer.unref?.();
      const { client, site, proxy, remoteProxyId, sessionId, callback } = await loginWithChallengeRetry({
        signal: controller.signal, login, wait: retryWait,
        prepare: async (attempt) => {
          loginAttempt = attempt;
          await patch({ status: 'running', stage: 'validating', errorCode: '',
            message: attempt === 2 ? '自动重试 1/1：重新开始完整授权流程' : '' });
          const site = await resolveSite(job.mySiteId, job.targetUrl);
          const client = clientFactory({ baseUrl: site.url, adminKey: site.adminKey });
          const proxy = await resolveProxy(job.proxyId);
          if (job.credentialStored && (Boolean(proxy) !== Boolean(secrets.proxySnapshot) || (proxy && !sameProxy(proxy, secrets.proxySnapshot)))) throw onboardingError('PROXY_CHANGED', '原代理配置已变化，不能执行任务', 409);
          await verifyGroups(client, job.groupIds);
          await verifyImportCapability(client, job.importOptions);
          await patch({ stage: 'proxy' });
          const remoteProxyId = await ensureRemoteProxy(job, proxy, client, controller.signal);
          await patch({ remoteProxyId, stage: 'authorizing' });
          const { authUrl, sessionId } = await client.generateAuthUrl({ proxyId: remoteProxyId });
          return { client, site, proxy, remoteProxyId, sessionId,
            loginInput: { authUrl, email: job.email, password: secrets.password, totpSecret: secrets.totpSecret,
              proxy, signal: controller.signal, onStage: async (stage) => {
                if (LOGIN_STAGES.has(stage)) await patch({ stage });
              } } };
        },
        onChallenge: async (error, attempt) => {
          logger.warn?.('[oauth-onboarding]', { jobId: job.id, stage: job.stage,
            code: 'OAUTH_HTTP_CHALLENGE', attempt, challenge: sanitizeOAuthChallenge(error.challenge) });
        },
        onRetry: () => patch({ stage: 'retry_wait',
          message: '遇到访问挑战，等待 15 秒后自动从头重试一次（1/1）' }),
      });
      secrets.password = '';
      secrets.totpSecret = '';
      await patch({ stage: 'exchanging' });
      const tokens = await client.exchangeCode({ sessionId, code: callback.code, state: callback.state,
        redirectUri: callback.redirectUri, proxyId: remoteProxyId });
      const credentials = buildOAuthCredentials(tokens, { email: job.email, now: now() });
      await patch({ chatgptAccountId: credentials.chatgpt_account_id, chatgptUserId: credentials.chatgpt_user_id });
      // Configuration can change while a user is at a login page; revalidate before the external write.
      const currentSite = await resolveSite(job.mySiteId, job.targetUrl);
      if (currentSite.adminKey !== site.adminKey) throw onboardingError('TARGET_CHANGED', '目标管理凭据已改变，请重新发起任务', 409);
      const currentProxy = await resolveProxy(job.proxyId);
      if (proxy && !sameProxy(currentProxy, proxy)) throw onboardingError('PROXY_CHANGED', '代理配置已改变，请重新发起任务', 409);
      if (remoteProxyId !== null) {
        const remote = await client.getProxy(remoteProxyId);
        if (!sameProxy(remote, proxy) || !isActiveProxy(remote, now())) throw onboardingError('PROXY_MAPPING_STALE', '远端代理已改变或失效，请先同步代理', 409);
      }
      await verifyGroups(client, job.groupIds);
      await verifyImportCapability(client, job.importOptions);
      if (controller.signal.aborted) throw onboardingError('TASK_INTERRUPTED', '任务已中断', 409);
      await patch({ status: 'pushing', stage: 'pushing' });
      // Once persisted, a crash or lost response is reconciled, never blindly retried with a new key.
      pushStarted = true;
      const account = await client.createOAuthAccount({ name: job.accountName || job.email, credentials, proxyId: remoteProxyId, groupIds: job.groupIds, creationKey: job.creationKey, ...(job.importOptions ? { importOptions: job.importOptions } : {}) }, { idempotencyKey: `oauth-account-${job.id}` });
      if (job.importOptions && !accountMatchesJob(account, job)) throw onboardingError('IMPORT_OPTIONS_MISMATCH', '远端账号或导入参数未确认，请先对账', 409);
      await patch({ status: 'succeeded', stage: 'done', remoteAccountId: Number(account.id), message: `已创建 OAuth 账号并绑定所选代理及分组${loginAttempt === 2 ? '（自动重试一次后成功）' : ''}`, errorCode: '' });
    } catch (rawError) {
      const error = safeError(rawError);
      const uncertain = pushStarted && (rawError?.ambiguous !== false);
      const status = uncertain ? 'uncertain' : (error.needsAttention || error.code === 'TASK_INTERRUPTED' ? 'needs_attention' : 'failed');
      try {
        job = await store.update(job.id, ownerId, { status,
          errorCode: uncertain ? 'WRITE_UNCERTAIN' : error.code,
          message: `${uncertain ? '推送结果不明，请先对账，勿重复创建' : error.message}${loginAttempt === 2 ? '（已自动重试一次）' : ''}` });
      } catch { /* An expired lease leaves pushing recoverable by expireStale; do not erase the evidence. */ }
      logger.warn?.('[oauth-onboarding]', { jobId: job.id, code: uncertain ? 'WRITE_UNCERTAIN' : error.code, attempt: loginAttempt });
    } finally {
      clearInterval(timer);
      secrets.password = '';
      secrets.totpSecret = '';
      secrets.proxySnapshot = null;
    }
  }

  async function verifyImportCapability(client, options) {
    if (options?.schedulable !== false && options?.accountProtection !== false) return;
    const capabilities = await client.importCapabilities();
    if (options?.accountProtection === false && !capabilities.atomicProtection) {
      throw onboardingError('ATOMIC_PROTECTION_UNSUPPORTED', '目标 Sub2 尚不支持创建时关闭账号保护，请先升级目标服务', 409);
    }
    if (options?.schedulable === false && !capabilities.atomicSchedulable) {
      throw onboardingError('ATOMIC_SCHEDULABLE_UNSUPPORTED', '目标 Sub2 尚不支持创建时关闭调度，请先升级目标服务', 409);
    }
  }

  return {
    async getExecutionSettings() {
      return { settings: await store.getExecutionSettings(), limits: OAUTH_EXECUTION_LIMITS };
    },
    async saveExecutionSettings(input) {
      if (closing) throw onboardingError('SHUTTING_DOWN', '服务正在重启，请稍后再试', 503);
      return { settings: await store.saveExecutionSettings(validateOAuthExecutionSettings(input)), limits: OAUTH_EXECUTION_LIMITS };
    },
    rerunBatch: (id, body) => rerun('batch', id, body),
    rerunJob: (id, body) => rerun('job', id, body),
    async listBatches(params = {}) { const query = validatePage(params); await store.expireStale(); return store.listBatches(query); },
    async preferences(mySiteId) {
      if (!UUID.test(mySiteId ?? '')) throw onboardingError('INVALID_TARGET', '请选择有效的目标站点');
      const site = await resolveSite(mySiteId);
      const [preferences, capabilities] = await Promise.all([
        store.getImportPreferences(mySiteId),
        clientFactory({ baseUrl: site.url, adminKey: site.adminKey }).importCapabilities(),
      ]);
      return { preferences, capabilities };
    },
    async submitBatch(input) {
      let finishAdmission;
      const admission = new Promise((resolve) => { finishAdmission = resolve; });
      admissions.add(admission);
      const secrets = [];
      try {
        if (closing) throw onboardingError('SHUTTING_DOWN', '服务正在重启，请稍后再试', 503);
        const prepared = prepareOAuthBatch(input, validateMetadata);
        await store.expireStale();
        const previous = await store.getBatch(prepared.id);
        if (previous) {
          const replay = previous.jobs.length > 0 && previous.jobs.every((job) => !Object.hasOwn(job.importOptions ?? {}, 'accountProtection'))
            && !Object.hasOwn(input.importOptions ?? {}, 'accountProtection')
            ? prepareOAuthBatch(input, validateMetadata, { legacyProtection: true }) : prepared;
          if (previous.fingerprint !== replay.fingerprint) throw onboardingError('IDEMPOTENCY_CONFLICT', '此提交编号已用于不同的账号或选项', 409);
          return publicOnboardingBatch(previous);
        }
        credentialVault.assertReady();
        for (const account of input.accounts) {
          if (typeof account.password !== 'string' || !account.password.length || account.password.length > 1024) throw onboardingError('INVALID_PASSWORD', '账号密码需为1至1024字符');
          secrets.push({ password: account.password, totpSecret: normalizeTotpSecret(account.totpSecret) });
        }
        const site = await resolveSite(prepared.mySiteId);
        const proxy = await resolveProxy(prepared.proxyId);
        const client = clientFactory({ baseUrl: site.url, adminKey: site.adminKey });
        await verifyGroups(client, prepared.groupIds);
        await verifyImportCapability(client, prepared.importOptions);
        if (closing) throw onboardingError('SHUTTING_DOWN', '服务正在重启，请稍后再试', 503);
        prepared.jobs = prepared.jobs.map((job, index) => {
          secrets[index].proxySnapshot = proxySnapshot(proxy);
          const metadata = { ...job, targetUrl: targetUrl(site), accountName: job.email };
          return { ...metadata, envelope: credentialVault.seal(metadata, secrets[index]) };
        });
        const { batch, created } = await store.createBatch({ ...prepared, targetUrl: targetUrl(site), ownerId });
        if (created) {
          const byId = new Map(prepared.jobs.map((job, index) => [job.id, secrets[index]]));
          for (const job of batch.jobs) {
            const secret = byId.get(job.id);
            queue.enqueue(job, { ...secret });
          }
        }
        return publicOnboardingBatch(batch);
      } finally {
        for (const secret of secrets) { secret.password = ''; secret.totpSecret = ''; secret.proxySnapshot = null; }
        admissions.delete(admission); finishAdmission();
      }
    },
    async getBatch(id, params = {}) {
      const { email } = validatePage(params);
      if (!UUID.test(id ?? '')) throw onboardingError('INVALID_BATCH', '无效的批次编号');
      await store.expireStale();
      const batch = await store.getBatch(id);
      if (!batch) throw onboardingError('BATCH_NOT_FOUND', '批次不存在', 404);
      return publicOnboardingBatch(batch, email);
    },
    async options() {
      const [sites, proxies] = await Promise.all([mySiteRepository.listMySites(), proxyRepository.listProxies()]);
      return { mySites: sites.filter((site) => site.type === 'sub2api').map(({ id, name }) => ({ id, name })),
        proxies: proxies.filter((proxy) => isActiveProxy(proxy, now())).map(({ id, name, protocol, status, expiresAt }) => ({ id, name, protocol, status, expiresAt })) };
    },
    async groups(mySiteId) {
      if (!UUID.test(mySiteId ?? '')) throw onboardingError('INVALID_TARGET', '请选择有效的目标站点');
      const site = await resolveSite(mySiteId);
      const groups = await clientFactory({ baseUrl: site.url, adminKey: site.adminKey }).listGroups();
      return groups.filter((group) => group.platform === 'openai' && group.status === 'active')
        .map(({ id, name, platform, status }) => ({ id: Number(id), name, platform, status }));
    },
    async submit(input) {
      let secrets;
      let finishAdmission;
      const admission = new Promise((resolve) => { finishAdmission = resolve; });
      admissions.add(admission);
      try {
        if (closing) throw onboardingError('SHUTTING_DOWN', '服务正在重启，请稍后再试', 503);
        const metadata = validateMetadata(input);
        metadata.importOptions = normalizeImportOptions(input.importOptions);
        const fingerprint = onboardingFingerprint(metadata);
        await store.expireStale();
        const previous = await store.get(metadata.id);
        if (previous) {
          const replayFingerprint = previous.importOptions || input.importOptions !== undefined ? fingerprint : onboardingFingerprint({ ...metadata, importOptions: null });
          if (previous.fingerprint !== replayFingerprint) throw onboardingError('IDEMPOTENCY_CONFLICT', '此提交编号已用于不同的账号或选项', 409);
          return publicOnboardingJob(previous);
        }
        credentialVault.assertReady();
        if (typeof input.password !== 'string' || !input.password.length || input.password.length > 1024) throw onboardingError('INVALID_PASSWORD', '请输入账号密码（最多1024字符）');
        secrets = { password: input.password, totpSecret: normalizeTotpSecret(input.totpSecret) };
        const site = await resolveSite(metadata.mySiteId);
        const proxy = await resolveProxy(metadata.proxyId);
        secrets.proxySnapshot = proxySnapshot(proxy);
        const client = clientFactory({ baseUrl: site.url, adminKey: site.adminKey });
        await verifyGroups(client, metadata.groupIds);
        await verifyImportCapability(client, metadata.importOptions);
        metadata.targetUrl = targetUrl(site);
        metadata.accountName = metadata.email;
        if (closing) throw onboardingError('SHUTTING_DOWN', '服务正在重启，请稍后再试', 503);
        const { job, created } = await store.create({ ...metadata, fingerprint, targetUrl: targetUrl(site), ownerId, creationKey: `oauth-account-${metadata.id}`, envelope: credentialVault.seal(metadata, secrets) });
        if (created) {
          const controller = new AbortController();
          if (closing) controller.abort();
          const promise = execute(job, { ...secrets }, controller).finally(() => running.delete(job.id));
          running.set(job.id, { promise, controller });
        }
        return publicOnboardingJob(job);
      } finally {
        if (secrets) { secrets.password = ''; secrets.totpSecret = ''; secrets.proxySnapshot = null; }
        admissions.delete(admission); finishAdmission();
      }
    },
    async get(id) {
      if (!UUID.test(id ?? '')) throw onboardingError('INVALID_JOB', '无效的任务编号');
      await store.expireStale();
      const job = await store.get(id);
      if (!job) throw onboardingError('JOB_NOT_FOUND', '任务不存在', 404);
      return publicOnboardingJob(job);
    },
    async list() { return (await store.list()).map(publicOnboardingJob); },
    async listPage({ scope = 'all', before = null } = {}) {
      if (!['all', 'attention'].includes(scope) || (before !== null && !UUID.test(before))) throw onboardingError('INVALID_PAGE', '无效的任务分页参数');
      const page = await store.listPage({ scope, before });
      return { jobs: page.jobs.map(publicOnboardingJob), nextCursor: page.nextCursor };
    },
    async reconcile(id) {
      if (!UUID.test(id ?? '')) throw onboardingError('INVALID_JOB', '无效的任务编号');
      await store.expireStale();
      const job = await store.get(id);
      if (!job) throw onboardingError('JOB_NOT_FOUND', '任务不存在', 404);
      if (job.status === 'succeeded') return publicOnboardingJob(job);
      if (job.status !== 'uncertain') throw onboardingError('NOT_UNCERTAIN', '仅结果不明的任务需要对账', 409);
      const site = await resolveSite(job.mySiteId, job.targetUrl);
      const client = clientFactory({ baseUrl: site.url, adminKey: site.adminKey });
      const matches = (await client.listAccounts()).filter((account) => accountMatchesJob(account, job));
      if (matches.length !== 1) throw onboardingError('RECONCILE_UNRESOLVED', '未找到唯一且本次任务标记、邮箱、代理、分组及导入参数一致的远端账号；请在 Sub2API 人工核实，暂不允许重复创建', 409);
      return publicOnboardingJob(await store.reconcileSuccess(job.id, Number(matches[0].id)));
    },
    async close() {
      closing = true;
      await Promise.allSettled([...admissions]);
      await queue.close();
      for (const task of running.values()) task.controller.abort();
      await Promise.allSettled([...running.values()].map((task) => task.promise));
    },
    // Useful for graceful lifecycle management and deterministic tests; no credentials exposed.
    async waitForIdle() { await Promise.all([...running.values()].map((task) => task.promise)); await queue.waitForIdle(); },
  };
}
