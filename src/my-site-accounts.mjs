import { displayMultiplier } from './currency-display.mjs';
import { normalizeProviderPlatform } from './domain.mjs';
import { fetchAvailableModels } from './model-probe.mjs';
import { createSub2ApiAdminClient, normalizeAdminPlatform } from './my-sites-admin.mjs';

// 编排"在我的站点创建账号并与上游分组关联"的完整流程
export function buildMySiteAccountName(siteName, groupName) {
  return `${String(siteName ?? '').trim()} · ${String(groupName ?? '').trim()}`;
}

// 建账号时默认排除的上游模型（sub2api 账号白名单 = 上游支持模型 - 排除模型）
export const DEFAULT_EXCLUDED_MODELS = [
  'gpt-5.6-luna',
  'gpt-image-1',
  'gpt-image-2',
  'gpt-image-1.5',
];

export function normalizeExcludedModels(value, fallback = DEFAULT_EXCLUDED_MODELS) {
  if (value === null || value === undefined) return [...fallback];
  const items = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  return [...new Set(items.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

export function createMySiteAccountService({
  mySiteRepository,
  mySiteAccountRepository,
  siteRepository,
  snapshotRepository,
  adminClientFactory = createSub2ApiAdminClient,
  fetchUpstreamModels = fetchAvailableModels,
} = {}) {
  if (!mySiteRepository) throw new Error('My site repository is required');
  if (!mySiteAccountRepository) throw new Error('My site account repository is required');
  if (!siteRepository) throw new Error('Site repository is required');
  if (!snapshotRepository) throw new Error('Snapshot repository is required');

  async function requireMySite(mySiteId) {
    const mySite = await mySiteRepository.getMySiteById(String(mySiteId ?? '').trim());
    if (!mySite) throw withStatus(404, 'My site not found');
    return mySite;
  }

  return {
    async listRemoteGroups(mySiteId) {
      const mySite = await requireMySite(mySiteId);
      const client = adminClientFactory({ baseUrl: mySite.url, adminKey: mySite.adminKey });
      return await client.listGroups();
    },

    // 映射账号弹窗：本地映射 + 我站点实时状态（可调度/优先级）；单个账号拉取失败不拖垮整列
    async listLinkedAccountsRemote({ upstreamSiteId, upstreamGroupId }) {
      const links = await mySiteAccountRepository.listAccounts({
        upstreamSiteId: upstreamSiteId || null,
        upstreamGroupId: upstreamGroupId || null,
      });
      return await Promise.all(links.map(async (link) => {
        const mySite = await mySiteRepository.getMySiteById(link.mySiteId);
        const base = { ...link, mySiteName: mySite?.name ?? '', remote: null, remoteError: null };
        if (!mySite) return { ...base, remoteError: '我的站点不存在' };
        try {
          const client = adminClientFactory({ baseUrl: mySite.url, adminKey: mySite.adminKey });
          const remote = await client.getAccount(link.myAccountId);
          return { ...base, remote };
        } catch (error) {
          return { ...base, remoteError: error.message };
        }
      }));
    },

    // 映射账号仅支持改可调度开关和优先级：直接透传到我站点，不落本地库
    async updateLinkedAccountRemote({ accountLinkId, schedulable = null, priority = null }) {
      if (schedulable === null && priority === null) throw withStatus(400, 'Nothing to update');
      // 先校验再调用：避免可调度已改、优先级校验失败的半更新状态
      let numericPriority = null;
      if (priority !== null) {
        numericPriority = Number(priority);
        if (!Number.isInteger(numericPriority) || numericPriority < 0) {
          throw withStatus(400, 'Invalid priority');
        }
      }
      const link = await mySiteAccountRepository.getAccountById(String(accountLinkId ?? '').trim());
      if (!link) throw withStatus(404, 'Account link not found');
      const mySite = await requireMySite(link.mySiteId);
      const client = adminClientFactory({ baseUrl: mySite.url, adminKey: mySite.adminKey });
      if (schedulable !== null) {
        await client.setSchedulable(link.myAccountId, Boolean(schedulable));
      }
      if (numericPriority !== null) {
        await client.updateAccount(link.myAccountId, { priority: numericPriority });
      }
      const remote = await client.getAccount(link.myAccountId);
      return { link, remote };
    },

    async createAccountLink({
      mySiteId,
      myGroupId,
      upstreamSiteId,
      upstreamGroupId,
      poolMode = true,
      poolModeRetryCount = 3,
      responsesMode = null,
      excludedModels = null,
    }) {
      const normalizedMyGroupId = String(myGroupId ?? '').trim();
      const normalizedUpstreamGroupId = String(upstreamGroupId ?? '').trim();
      if (!normalizedMyGroupId) throw withStatus(400, 'My group id is required');
      if (!normalizedUpstreamGroupId) throw withStatus(400, 'Upstream group id is required');

      const mySite = await requireMySite(mySiteId);
      const site = await siteRepository.getSiteById(String(upstreamSiteId ?? '').trim());
      if (!site) throw withStatus(404, 'Site not found');

      const snapshot = await snapshotRepository.getLatestSnapshot(site);
      const group = (snapshot?.groups ?? []).find(
        (item) => String(item.id) === normalizedUpstreamGroupId,
      );
      if (!group) throw withStatus(400, '上游分组不存在，请先刷新该站点');

      const token = (snapshot?.tokens ?? []).find((item) => (
        String(item.groupId ?? item.group_id ?? '') === normalizedUpstreamGroupId
          && String(item.key ?? '').trim()
      ));
      if (!token) throw withStatus(400, '该分组没有可用的 API Key，无法创建账号');

      // 我站点每个分组只能创建一个账号（同一上游分组）
      const existing = await mySiteAccountRepository.listAccounts({
        mySiteId: mySite.id,
        upstreamSiteId: site.id,
        upstreamGroupId: normalizedUpstreamGroupId,
      });
      if (existing.some((item) => String(item.myGroupId) === normalizedMyGroupId)) {
        throw withStatus(409, '该分组下已创建过账号');
      }

      const client = adminClientFactory({ baseUrl: mySite.url, adminKey: mySite.adminKey });
      const remoteGroups = await client.listGroups();
      const remoteGroup = remoteGroups.find((item) => String(item.id) === normalizedMyGroupId);
      if (!remoteGroup) throw withStatus(400, '我的站点中不存在该分组');

      // 倍率用监控侧展示口径（USD 快照按站点换算倍率折过），不是上游原始声明值
      const convertedRate = displayMultiplier({ site, snapshot, multiplier: group.multiplier });
      const rate = Number.isFinite(Number(convertedRate)) ? Number(convertedRate) : null;
      // grok/gemini 目标分组必须按对应平台建账号（上游分组上报的平台上兼容 openai 格式，
      // 直接沿用会建成 openai 账号，与 grok/gemini 分组平台冲突）；其余平台沿用上游分组口径
      const targetPlatform = normalizeAdminPlatform(remoteGroup.platform);
      const accountPlatform = ['grok', 'gemini'].includes(targetPlatform)
        ? targetPlatform
        : normalizeProviderPlatform(group.platform);
      // Responses API 模式只对目标（我站点）openai 分组有意义，默认强制 responses
      const effectiveResponsesMode = targetPlatform === 'openai'
        ? (responsesMode ?? 'force_responses')
        : null;
      // 账号模型白名单 = 上游当前支持模型 - 排除模型（sub2api model_mapping 恒等映射）。
      // 拉取失败不排除：宁可建账号失败，也不建一个不受模型限制的账号
      const excluded = normalizeExcludedModels(excludedModels);
      let upstreamModels;
      try {
        upstreamModels = await fetchUpstreamModels({
          baseUrl: site.baseUrl || site.url,
          apiKey: String(token.key),
          proxy: site.proxy ?? null,
        });
      } catch (error) {
        throw withStatus(502, `拉取上游模型列表失败：${error.message}`);
      }
      const upstreamModelIds = (Array.isArray(upstreamModels) ? upstreamModels : [])
        .map((model) => String(typeof model === 'string' ? model : model?.id ?? '').trim())
        .filter(Boolean);
      const allowedModels = upstreamModelIds.filter((model) => !excluded.includes(model));
      if (allowedModels.length === 0) {
        throw withStatus(400, '排除后上游没有可支持的模型，未创建账号');
      }
      const modelMapping = Object.fromEntries(allowedModels.map((model) => [model, model]));
      const account = await client.createAccount({
        name: buildMySiteAccountName(site.name, group.name),
        platform: accountPlatform,
        apiKey: String(token.key),
        baseUrl: site.baseUrl || site.url,
        groupId: normalizedMyGroupId,
        rateMultiplier: rate,
        poolMode,
        poolModeRetryCount,
        responsesMode: effectiveResponsesMode,
        modelMapping,
      });
      if (!account.id) throw withStatus(502, '创建账号成功但未返回账号 ID');

      return await mySiteAccountRepository.createAccount({
        mySiteId: mySite.id,
        myGroupId: normalizedMyGroupId,
        myGroupName: remoteGroup.name,
        myAccountId: account.id,
        upstreamSiteId: site.id,
        upstreamGroupId: normalizedUpstreamGroupId,
        lastSyncedRate: rate,
      });
    },
  };
}

function withStatus(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
