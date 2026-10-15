import { displayMultiplier } from './currency-display.mjs';
import { buildMySiteAccountName } from './my-site-accounts.mjs';
import { createSub2ApiAdminClient } from './my-sites-admin.mjs';

// 每次快照刷新后，对齐我站点中关联账号的状态：
// 1. 账号在我站点已不存在 → 删掉监控侧的关联记录；
// 2. 账号名跟随最新的"站点名 · 分组名"（上游分组改名也跟着改）；
// 3. 账号倍率改成拉取到的最新倍率；
// 单条失败只记日志，不阻断刷新。
export function createMySiteRateSync({
  mySiteRepository,
  mySiteAccountRepository,
  adminClientFactory = createSub2ApiAdminClient,
  logger = console,
} = {}) {
  return {
    async syncSiteRates({ site, snapshot }) {
      const result = { updated: 0, removed: 0, failed: 0 };
      if (!mySiteRepository || !mySiteAccountRepository) return result;
      if (!site?.id) return result;
      const links = await mySiteAccountRepository.listAccounts({ upstreamSiteId: site.id });
      if (links.length === 0) return result;

      const groupsById = new Map(
        (snapshot?.groups ?? []).map((group) => [String(group.id), group]),
      );
      const mySitesById = new Map();

      for (const link of links) {
        const group = groupsById.get(String(link.upstreamGroupId));
        // 上游分组从快照里消失时不动关联：无法确定新名字/倍率，留着下次再说
        if (!group) continue;
        try {
          const mySite = await loadMySite(mySiteRepository, mySitesById, link.mySiteId);
          if (!mySite?.url || !mySite?.adminKey) {
            result.failed += 1;
            continue;
          }
          const client = adminClientFactory({ baseUrl: mySite.url, adminKey: mySite.adminKey });

          let remote;
          try {
            remote = await client.getAccount(link.myAccountId);
          } catch (error) {
            if (error?.httpStatus === 404) {
              await mySiteAccountRepository.deleteAccountById(link.id);
              result.removed += 1;
              continue;
            }
            throw error;
          }

          // 账号还在、但已被移出映射时的分组（或该分组被删）→ 桥接已断，删掉关联记录
          if (Array.isArray(remote.groupIds) && !remote.groupIds.includes(String(link.myGroupId))) {
            await mySiteAccountRepository.deleteAccountById(link.id);
            result.removed += 1;
            continue;
          }

          const update = {};
          const expectedName = buildMySiteAccountName(site.name, group.name);
          if (String(remote.name ?? '') !== expectedName) update.name = expectedName;
          // 倍率用监控侧展示口径（USD 快照按站点换算倍率折过），不是上游原始声明值
          const rate = Number(displayMultiplier({ site, snapshot, multiplier: group.multiplier }));
          if (Number.isFinite(rate) && Number(remote.rateMultiplier) !== rate) {
            update.rateMultiplier = rate;
          }
          if (Object.keys(update).length > 0) {
            await client.updateAccount(link.myAccountId, update);
            result.updated += 1;
          }
          if (Number.isFinite(rate) && Number(link.lastSyncedRate) !== rate) {
            await mySiteAccountRepository.markRateSynced(link.id, rate);
          }
        } catch (error) {
          result.failed += 1;
          logger.error?.(
            `[my-site-rate-sync] ${site.name ?? site.id}: account ${link.myAccountId}: ${error.message}`,
          );
        }
      }
      return result;
    },
  };
}

async function loadMySite(mySiteRepository, cache, mySiteId) {
  const key = String(mySiteId);
  if (!cache.has(key)) {
    cache.set(key, await mySiteRepository.getMySiteById(key));
  }
  return cache.get(key);
}
