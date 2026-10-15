import { fetchSub2ApiSnapshot } from './upstreams/sub2api.mjs';
import { fetchSub2ApiFlowSnapshot } from './upstreams/sub2api-flow.mjs';
import { fetchNewApiSnapshot } from './upstreams/newapi.mjs';

const siteRefreshLocks = new Map();

export function createSnapshotService({ snapshotRepository, siteRepository, adapters = {}, onSnapshotSaved = null } = {}) {
  const sub2api = adapters.sub2api ?? fetchSub2ApiSnapshot;
  const sub2apiFlow = adapters.sub2apiFlow ?? fetchSub2ApiFlowSnapshot;
  const newApi = adapters.newApi ?? fetchNewApiSnapshot;

  return {
    async getLatestSnapshot(site) {
      if (!snapshotRepository) throw new Error('Snapshot repository is not configured');
      return await snapshotRepository.getLatestSnapshot(site);
    },

    async refreshSnapshot(site) {
      if (!snapshotRepository) throw new Error('Snapshot repository is not configured');
      if (site.type === 'sub2api') {
        return await withSiteRefreshLock(site.id, async () => {
          const latestSite = await reloadSite(siteRepository, site);
          const adapter = String(latestSite.syncVariant ?? latestSite.sync_variant ?? '') === 'credential-flow'
            ? sub2apiFlow
            : sub2api;
          const auth = createAuthCheckpoint(siteRepository, latestSite);
          let result;
          try {
            result = await adapter(latestSite, { onAuthUpdate: auth.save });
            await auth.save(result.authUpdate);
          } finally {
            // A browser deadline must not release this site's lock while an
            // already received token rotation is still being persisted.
            await auth.close();
          }
          return await saveAdapterResult(snapshotRepository, latestSite, result, onSnapshotSaved);
        });
      }
      if (site.type === 'new-api') {
        return await withSiteRefreshLock(site.id, async () => {
          let fallbackLoginUsername = '';
          if (typeof snapshotRepository.getLatestSnapshot === 'function') {
            const latest = await snapshotRepository.getLatestSnapshot(site).catch(() => null);
            fallbackLoginUsername = String(latest?.profile?.username ?? '').trim();
          }
          const result = await newApi(site, fallbackLoginUsername ? { fallbackLoginUsername } : {});
          await persistAuthUpdate(siteRepository, site, result.authUpdate);
          return await saveAdapterResult(snapshotRepository, site, result, onSnapshotSaved);
        });
      }
      throw new Error(`Unsupported snapshot site type: ${site.type}`);
    },
  };
}

async function reloadSite(siteRepository, fallbackSite) {
  if (!siteRepository?.getSiteById || !fallbackSite?.id) return fallbackSite;
  return await siteRepository.getSiteById(fallbackSite.id) ?? fallbackSite;
}

async function withSiteRefreshLock(siteId, task) {
  if (!siteId) return await task();
  const previous = siteRefreshLocks.get(siteId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const cleanup = run.catch(() => {}).finally(() => {
    if (siteRefreshLocks.get(siteId) === cleanup) {
      siteRefreshLocks.delete(siteId);
    }
  });
  siteRefreshLocks.set(siteId, cleanup);
  return await run;
}

function createAuthCheckpoint(siteRepository, site) {
  let pending = Promise.resolve();
  let accepting = true;
  let saved = null;
  return {
    save(authUpdate) {
      if (!accepting) return Promise.reject(new Error('Auth checkpoint is closed'));
      if (!authUpdate) return pending;
      const update = { ...authUpdate };
      const identity = JSON.stringify(update);
      pending = pending.then(async () => {
        if (identity === saved) return;
        await persistAuthUpdate(siteRepository, site, update);
        saved = identity;
      });
      // The browser may disappear before its binding receives the rejection;
      // close() still awaits the original promise and propagates write failure.
      void pending.catch(() => {});
      return pending;
    },
    async close() {
      accepting = false;
      await pending;
    },
  };
}

async function persistAuthUpdate(siteRepository, site, authUpdate) {
  if (!authUpdate || !siteRepository?.updateSiteAuthTokens) return;
  await siteRepository.updateSiteAuthTokens(site.id, authUpdate);
}

async function saveAdapterResult(snapshotRepository, site, result, onSnapshotSaved = null) {
  const normalizedSnapshot = result.normalizedSnapshot ?? result;
  const rawPayload = result.rawPayload ?? result;
  await snapshotRepository.saveSnapshot({
    site,
    rawPayload,
    normalizedSnapshot,
    fetchedAt: result.fetchedAt ?? normalizedSnapshot.refreshedAt ?? new Date(),
  });
  // 快照落库后的扩展钩子（如"我的站点"倍率跟随）；钩子失败不阻断刷新
  if (onSnapshotSaved) {
    try {
      await onSnapshotSaved({ site, snapshot: normalizedSnapshot });
    } catch (error) {
      console.error(`[snapshot] onSnapshotSaved hook failed: ${error.message}`);
    }
  }
  return normalizedSnapshot;
}
