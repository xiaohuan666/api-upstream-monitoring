import { handleOAuthOnboarding } from './oauth-onboarding-http.mjs';

import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGroupRateChangeQuery } from './group-rate-changes.mjs';
import { isAppPagePath } from './client-route.mjs';
import { isPublicAssetPath } from './public-assets.mjs';
import { validateAutoRefreshRules } from './auto-refresh-settings.mjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function createRequestHandler({
  publicDir,
  repository,
  proxyRepository = null,
  proxyProbeService = null,
  snapshotService = null,
  groupRateChangeRepository = null,
  groupModelSettingsRepository = null,
  uiPreferencesRepository = null,
  modelProbe = null,
  onAutoRefreshSettingsChanged = null,
  mySites = null,
  oauthOnboarding = null,
}) {
  const root = path.resolve(fileURLToPathMaybe(publicDir));

  return async function requestHandler(req, res) {
    try {
      const requestUrl = new URL(req.url, 'http://localhost');
      if (await handleOAuthOnboarding(req, res, requestUrl, oauthOnboarding)) return;
      const siteMatch = requestUrl.pathname.match(/^\/api\/sites\/([^/]+)$/);
      const siteWatchedMatch = requestUrl.pathname.match(/^\/api\/sites\/([^/]+)\/watched$/);
      const proxyMatch = requestUrl.pathname.match(/^\/api\/proxies\/([^/]+)$/);
      const mySiteMatch = requestUrl.pathname.match(/^\/api\/my-sites\/([^/]+)$/);
      const mySiteGroupsMatch = requestUrl.pathname.match(/^\/api\/my-sites\/([^/]+)\/groups$/);
      const mySiteAccountMatch = requestUrl.pathname.match(/^\/api\/my-site-accounts\/([^/]+)$/);
      const mySiteProxyLinkMatch = requestUrl.pathname.match(/^\/api\/my-site-proxies\/([^/]+)$/);
      const modelsMatch = requestUrl.pathname.match(/^\/api\/sites\/([^/]+)\/models$/);
      const groupSettingsMatch = requestUrl.pathname.match(/^\/api\/sites\/([^/]+)\/group-model-settings$/);
      const groupScoreMatch = requestUrl.pathname.match(/^\/api\/sites\/([^/]+)\/group-score$/);
      const groupModelTestMatch = requestUrl.pathname.match(/^\/api\/sites\/([^/]+)\/group-model-test$/);
      const uiPreferenceMatch = requestUrl.pathname.match(/^\/api\/ui-preferences\/([^/]+)$/);
      const snapshotMatch = requestUrl.pathname.match(/^\/api\/sites\/([^/]+)\/snapshot$/);
      const refreshMatch = requestUrl.pathname.match(/^\/api\/sites\/([^/]+)\/snapshot\/refresh$/);

      if (requestUrl.pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true });
      }

      if (requestUrl.pathname === '/api/sites' && req.method === 'GET') {
        const sites = await repository.listSites();
        return sendJson(res, 200, { sites });
      }

      if (requestUrl.pathname === '/api/group-rate-changes' && req.method === 'GET') {
        let options;
        try {
          options = parseGroupRateChangeQuery(requestUrl.searchParams);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        if (!groupRateChangeRepository) {
          return sendJson(res, 501, { error: '倍率变更记录服务未配置' });
        }
        try {
          const page = await groupRateChangeRepository.listChanges(options);
          res.setHeader('cache-control', 'no-store');
          return sendJson(res, 200, page);
        } catch {
          // 不把数据库错误和连接信息暴露给浏览器。
          console.error('[group-rate-changes] history query failed');
          return sendJson(res, 500, { error: '读取倍率变更记录失败，请稍后重试' });
        }
      }

      const proxyTestMatch = requestUrl.pathname.match(/^\/api\/proxies\/([^/]+)\/test$/);
      if (proxyTestMatch && req.method === 'POST') {
        if (!proxyProbeService) return sendJson(res, 501, { error: 'Proxy probe service is not configured' });
        const id = proxyTestMatch[1];
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          return sendJson(res, 400, { error: 'Invalid proxy ID' });
        }
        try {
          const result = await proxyProbeService.test(id);
          return sendJson(res, 200, { result });
        } catch (error) {
          const status = [404, 409, 429].includes(error.statusCode) ? error.statusCode : 500;
          return sendJson(res, status, { error: status === 500 ? '测试结果保存失败，请稍后重试' : error.message });
        }
      }

      if (requestUrl.pathname === '/api/proxies' && req.method === 'GET') {
        if (!proxyRepository) return sendJson(res, 501, { error: 'Proxy repository is not configured' });
        const proxies = await proxyRepository.listProxies();
        return sendJson(res, 200, { proxies });
      }

      if (requestUrl.pathname === '/api/proxies' && req.method === 'POST') {
        if (!proxyRepository) return sendJson(res, 501, { error: 'Proxy repository is not configured' });
        const payload = await readJsonBody(req);
        try {
          const proxy = await proxyRepository.createProxy(payload);
          return sendJson(res, 201, { proxy });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      // 批量导入：前端已逐行解析校验，后端按 host+port+username+password 全库去重
      if (requestUrl.pathname === '/api/proxies/batch' && req.method === 'POST') {
        if (!proxyRepository) return sendJson(res, 501, { error: 'Proxy repository is not configured' });
        const payload = await readJsonBody(req);
        const inputs = Array.isArray(payload?.proxies)
          ? payload.proxies.map((proxy) => ({ ...proxy, provider: payload.provider ?? proxy?.provider ?? '' }))
          : null;
        if (!inputs || inputs.length === 0) return sendJson(res, 400, { error: 'proxies must be a non-empty array' });
        try {
          const result = await proxyRepository.createProxiesBatch(inputs);
          return sendJson(res, 201, {
            created: result.created.length,
            skipped: result.skipped,
            proxies: result.created,
          });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (requestUrl.pathname === '/api/proxies/batch' && req.method === 'DELETE') {
        if (!proxyRepository?.deleteProxiesBatch) return sendJson(res, 501, { error: 'Proxy repository is not configured' });
        const payload = await readJsonBody(req);
        const ids = payload?.proxyIds;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200
            || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
            || new Set(ids).size !== ids.length) {
          return sendJson(res, 400, { error: 'proxyIds must contain 1–200 unique UUIDs' });
        }
        const deletedIds = await proxyRepository.deleteProxiesBatch(ids);
        return sendJson(res, 200, { deletedIds });
      }

      if (proxyMatch && req.method === 'PUT') {
        if (!proxyRepository) return sendJson(res, 501, { error: 'Proxy repository is not configured' });
        const payload = await readJsonBody(req);
        try {
          const proxy = await proxyRepository.updateProxy(decodeURIComponent(proxyMatch[1]), payload);
          if (!proxy) return sendJson(res, 404, { error: 'Proxy not found' });
          return sendJson(res, 200, { proxy });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (proxyMatch && req.method === 'DELETE') {
        if (!proxyRepository) return sendJson(res, 501, { error: 'Proxy repository is not configured' });
        const deleted = await proxyRepository.deleteProxy(decodeURIComponent(proxyMatch[1]));
        if (!deleted) return sendJson(res, 404, { error: 'Proxy not found' });
        return sendJson(res, 200, { ok: true });
      }

      if (requestUrl.pathname === '/api/my-sites' && req.method === 'GET') {
        if (!mySites?.repository) return sendJson(res, 501, { error: 'My site repository is not configured' });
        const sites = await mySites.repository.listMySites();
        return sendJson(res, 200, { mySites: sites });
      }

      if (requestUrl.pathname === '/api/my-sites' && req.method === 'POST') {
        if (!mySites?.repository) return sendJson(res, 501, { error: 'My site repository is not configured' });
        const payload = await readJsonBody(req);
        try {
          const mySite = await mySites.repository.createMySite(payload);
          return sendJson(res, 201, { mySite });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (mySiteMatch && req.method === 'PUT') {
        if (!mySites?.repository) return sendJson(res, 501, { error: 'My site repository is not configured' });
        const payload = await readJsonBody(req);
        try {
          const mySite = await mySites.repository.updateMySite(decodeURIComponent(mySiteMatch[1]), payload);
          if (!mySite) return sendJson(res, 404, { error: 'My site not found' });
          return sendJson(res, 200, { mySite });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (mySiteMatch && req.method === 'DELETE') {
        if (!mySites?.repository) return sendJson(res, 501, { error: 'My site repository is not configured' });
        const deleted = await mySites.repository.deleteMySite(decodeURIComponent(mySiteMatch[1]));
        if (!deleted) return sendJson(res, 404, { error: 'My site not found' });
        return sendJson(res, 200, { ok: true });
      }

      // 实时从我站点拉分组列表，供"创建账号"弹窗的下拉框
      if (mySiteGroupsMatch && req.method === 'GET') {
        if (!mySites?.service) return sendJson(res, 501, { error: 'My site service is not configured' });
        try {
          const groups = await mySites.service.listRemoteGroups(decodeURIComponent(mySiteGroupsMatch[1]));
          return sendJson(res, 200, { groups });
        } catch (error) {
          return sendJson(res, error.statusCode ?? 502, { error: error.message });
        }
      }

      // 映射账号弹窗：本地映射 + 我站点实时状态（可调度/优先级）。
      // 必须在 mySiteAccountMatch 之前判：'remote' 会被 [^/]+ 吃掉
      if (requestUrl.pathname === '/api/my-site-accounts/remote' && req.method === 'GET') {
        if (!mySites?.service) return sendJson(res, 501, { error: 'My site service is not configured' });
        const accounts = await mySites.service.listLinkedAccountsRemote({
          upstreamSiteId: requestUrl.searchParams.get('upstreamSiteId') || null,
          upstreamGroupId: requestUrl.searchParams.get('upstreamGroupId') || null,
        });
        return sendJson(res, 200, { accounts });
      }

      // 映射账号只支持改可调度开关和优先级，透传到我站点
      if (mySiteAccountMatch && req.method === 'PATCH') {
        if (!mySites?.service) return sendJson(res, 501, { error: 'My site service is not configured' });
        const payload = await readJsonBody(req);
        try {
          const result = await mySites.service.updateLinkedAccountRemote({
            accountLinkId: decodeURIComponent(mySiteAccountMatch[1]),
            schedulable: payload.schedulable ?? null,
            priority: payload.priority ?? null,
          });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, error.statusCode ?? 502, { error: error.message });
        }
      }

      if (requestUrl.pathname === '/api/my-site-accounts' && req.method === 'GET') {
        if (!mySites?.accountRepository) {
          return sendJson(res, 501, { error: 'My site account repository is not configured' });
        }
        const accounts = await mySites.accountRepository.listAccounts({
          mySiteId: requestUrl.searchParams.get('mySiteId') || null,
          upstreamSiteId: requestUrl.searchParams.get('upstreamSiteId') || null,
          upstreamGroupId: requestUrl.searchParams.get('upstreamGroupId') || null,
        });
        return sendJson(res, 200, { accounts });
      }

      if (requestUrl.pathname === '/api/my-site-accounts' && req.method === 'POST') {
        if (!mySites?.service) return sendJson(res, 501, { error: 'My site service is not configured' });
        const payload = await readJsonBody(req);
        try {
          const account = await mySites.service.createAccountLink({
            mySiteId: payload.mySiteId ?? payload.my_site_id,
            myGroupId: payload.myGroupId ?? payload.my_group_id,
            upstreamSiteId: payload.upstreamSiteId ?? payload.upstream_site_id,
            upstreamGroupId: payload.upstreamGroupId ?? payload.upstream_group_id,
            poolMode: payload.poolMode ?? payload.pool_mode ?? true,
            poolModeRetryCount: payload.poolModeRetryCount ?? payload.pool_mode_retry_count ?? 3,
            responsesMode: payload.responsesMode ?? payload.responses_mode ?? null,
            excludedModels: payload.excludedModels ?? payload.excluded_models ?? null,
          });
          return sendJson(res, 201, { account });
        } catch (error) {
          return sendJson(res, error.statusCode ?? 502, { error: error.message });
        }
      }

      // IP 映射：监控侧代理 ↔ 我站点侧代理记录
      if (requestUrl.pathname === '/api/my-site-proxies' && req.method === 'GET') {
        if (!mySites?.proxyService) return sendJson(res, 501, { error: 'My site proxy service is not configured' });
        const links = await mySites.proxyService.listProxyLinks({
          mySiteId: requestUrl.searchParams.get('mySiteId') || null,
          proxyId: requestUrl.searchParams.get('proxyId') || null,
        });
        return sendJson(res, 200, { links });
      }

      if (requestUrl.pathname === '/api/my-site-proxies' && req.method === 'POST') {
        if (!mySites?.proxyService) return sendJson(res, 501, { error: 'My site proxy service is not configured' });
        const payload = await readJsonBody(req);
        try {
          const result = await mySites.proxyService.createProxyLink({
            mySiteId: payload.mySiteId ?? payload.my_site_id ?? null,
            proxyId: payload.proxyId ?? payload.proxy_id,
          });
          return sendJson(res, 201, result);
        } catch (error) {
          return sendJson(res, error.statusCode ?? 502, { error: error.message });
        }
      }

      if (requestUrl.pathname === '/api/my-site-proxies/batch' && req.method === 'POST') {
        if (!mySites?.proxyService?.syncProxyLinks) return sendJson(res, 501, { error: 'My site proxy service is not configured' });
        const payload = await readJsonBody(req);
        try {
          const result = await mySites.proxyService.syncProxyLinks({
            mySiteId: payload.mySiteId ?? null,
            proxyIds: payload.proxyIds,
          });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, error.statusCode ?? 502, { error: error.message });
        }
      }

      if (mySiteProxyLinkMatch && req.method === 'DELETE') {
        if (!mySites?.proxyService) return sendJson(res, 501, { error: 'My site proxy service is not configured' });
        try {
          await mySites.proxyService.deleteProxyLink(decodeURIComponent(mySiteProxyLinkMatch[1]));
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, error.statusCode ?? 502, { error: error.message });
        }
      }

      if (uiPreferenceMatch && req.method === 'GET') {
        if (!uiPreferencesRepository) {
          return sendJson(res, 501, { error: 'UI preferences repository is not configured' });
        }
        const preference = await uiPreferencesRepository.getPreference(decodeURIComponent(uiPreferenceMatch[1]));
        return sendJson(res, 200, { preference });
      }

      if (uiPreferenceMatch && req.method === 'PUT') {
        if (!uiPreferencesRepository) {
          return sendJson(res, 501, { error: 'UI preferences repository is not configured' });
        }
        const payload = await readJsonBody(req);
        const preference = await uiPreferencesRepository.upsertPreference(
          decodeURIComponent(uiPreferenceMatch[1]),
          payload,
        );
        return sendJson(res, 200, { preference });
      }

      // 筛选预设走独立资源、按名粒度读写：预设名可能含任意字符，一律放请求体，
      // 不进 URL 路径（groupId 双重编码的教训）；日常筛选/排序保存 blob 不再触碰预设。
      if (requestUrl.pathname === '/api/group-filter-presets' && req.method === 'GET') {
        if (!uiPreferencesRepository?.listGroupFilterPresets) {
          return sendJson(res, 501, { error: 'Group filter preset repository is not configured' });
        }
        const presets = await uiPreferencesRepository.listGroupFilterPresets();
        return sendJson(res, 200, { presets });
      }

      if (requestUrl.pathname === '/api/group-filter-presets' && req.method === 'PUT') {
        if (!uiPreferencesRepository?.upsertGroupFilterPreset) {
          return sendJson(res, 501, { error: 'Group filter preset repository is not configured' });
        }
        const payload = await readJsonBody(req);
        if (!String(payload?.name ?? '').trim()) {
          return sendJson(res, 400, { error: 'Preset name is required' });
        }
        const preset = await uiPreferencesRepository.upsertGroupFilterPreset(payload);
        return sendJson(res, 200, { preset });
      }

      if (requestUrl.pathname === '/api/group-filter-presets' && req.method === 'DELETE') {
        if (!uiPreferencesRepository?.deleteGroupFilterPreset) {
          return sendJson(res, 501, { error: 'Group filter preset repository is not configured' });
        }
        const payload = await readJsonBody(req);
        const deleted = await uiPreferencesRepository.deleteGroupFilterPreset(payload?.name);
        if (!deleted) return sendJson(res, 404, { error: 'Preset not found' });
        return sendJson(res, 200, { ok: true });
      }

      if (requestUrl.pathname === '/api/auto-refresh-settings' && req.method === 'GET') {
        if (!uiPreferencesRepository?.getAutoRefreshSettings) {
          return sendJson(res, 501, { error: 'Auto refresh settings repository is not configured' });
        }
        const preference = await uiPreferencesRepository.getAutoRefreshSettings();
        return sendJson(res, 200, { preference });
      }

      if (requestUrl.pathname === '/api/auto-refresh-settings' && req.method === 'PUT') {
        if (!uiPreferencesRepository?.upsertAutoRefreshSettings) {
          return sendJson(res, 501, { error: 'Auto refresh settings repository is not configured' });
        }
        const payload = await readJsonBody(req);
        const sites = Array.isArray(payload?.rules) && payload.rules.length ? await repository.listSites() : [];
        try {
          validateAutoRefreshRules(payload, sites);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        const preference = await uiPreferencesRepository.upsertAutoRefreshSettings(payload);
        try {
          await onAutoRefreshSettingsChanged?.(preference.preferences);
        } catch (error) {
          console.error(`[auto-refresh] reschedule failed: ${error.message}`);
        }
        return sendJson(res, 200, { preference });
      }

      if (requestUrl.pathname === '/api/sites' && req.method === 'POST') {
        const payload = await readJsonBody(req);
        try {
          const site = await repository.createSite(payload);
          return sendJson(res, 201, { site });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (siteMatch && req.method === 'PUT') {
        const payload = await readJsonBody(req);
        try {
          const site = await repository.updateSite(decodeURIComponent(siteMatch[1]), payload);
          if (!site) return sendJson(res, 404, { error: 'Site not found' });
          return sendJson(res, 200, { site });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (siteMatch && req.method === 'DELETE') {
        const deleted = await repository.deleteSite(decodeURIComponent(siteMatch[1]));
        if (!deleted) return sendJson(res, 404, { error: 'Site not found' });
        return sendJson(res, 200, { ok: true });
      }

      if (siteWatchedMatch && req.method === 'PUT') {
        if (!repository.setSiteWatched) {
          return sendJson(res, 501, { error: 'Site watch repository is not configured' });
        }
        const payload = await readJsonBody(req);
        const site = await repository.setSiteWatched(
          decodeURIComponent(siteWatchedMatch[1]),
          Boolean(payload.watched),
        );
        if (!site) return sendJson(res, 404, { error: 'Site not found' });
        return sendJson(res, 200, { site });
      }

      if (groupSettingsMatch && req.method === 'GET') {
        if (!groupModelSettingsRepository) {
          return sendJson(res, 501, { error: 'Group model settings repository is not configured' });
        }
        const site = await repository.getSiteById(decodeURIComponent(groupSettingsMatch[1]));
        if (!site) return sendJson(res, 404, { error: 'Site not found' });
        const settings = await groupModelSettingsRepository.listBySiteIds([site.id]);
        return sendJson(res, 200, { settings });
      }

      if (groupSettingsMatch && req.method === 'PUT') {
        if (!groupModelSettingsRepository) {
          return sendJson(res, 501, { error: 'Group model settings repository is not configured' });
        }
        const site = await repository.getSiteById(decodeURIComponent(groupSettingsMatch[1]));
        if (!site) return sendJson(res, 404, { error: 'Site not found' });
        const payload = await readJsonBody(req);
        // groupId 走请求体：分组名可能含 /（如 Claude-0.02元/次），放路径会被代理层编码破坏
        const setting = await groupModelSettingsRepository.upsertSetting({
          siteId: site.id,
          groupId: String(payload.groupId ?? payload.group_id ?? ''),
          selectedModel: payload.selectedModel ?? payload.selected_model ?? '',
          testModel: payload.testModel ?? payload.test_model ?? '',
          modelOptions: payload.modelOptions ?? payload.model_options ?? [],
        });
        return sendJson(res, 200, { setting });
      }

      if (groupScoreMatch && req.method === 'PUT') {
        if (!groupModelSettingsRepository?.updateScore) {
          return sendJson(res, 501, { error: 'Group model settings repository is not configured' });
        }
        const site = await repository.getSiteById(decodeURIComponent(groupScoreMatch[1]));
        if (!site) return sendJson(res, 404, { error: 'Site not found' });
        const payload = await readJsonBody(req);
        // groupId 走请求体：分组名可能含 /（如 Claude-0.02元/次），放路径会被代理层编码破坏
        try {
          const setting = await groupModelSettingsRepository.updateScore(
            site.id,
            String(payload.groupId ?? payload.group_id ?? ''),
            payload.score,
          );
          return sendJson(res, 200, { setting });
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
      }

      if (modelsMatch && req.method === 'GET') {
        const site = await repository.getSiteById(decodeURIComponent(modelsMatch[1]));
        if (!site) return sendJson(res, 404, { error: 'Site not found' });
        if (!snapshotService) return sendJson(res, 501, { error: 'Snapshot service is not configured' });
        if (!modelProbe?.fetchAvailableModels) return sendJson(res, 501, { error: 'Model probe is not configured' });
        try {
          const snapshot = await snapshotService.getLatestSnapshot(site);
          const groupId = requestUrl.searchParams.get('groupId') ?? '';
          const apiKey = chooseSnapshotToken(snapshot, groupId);
          if (!apiKey) return sendJson(res, 400, { error: 'No API key token found in saved snapshot' });
          const models = await modelProbe.fetchAvailableModels({ siteId: site.id, baseUrl: site.baseUrl || site.url, apiKey, proxy: site.proxy });
          return sendJson(res, 200, { models });
        } catch (error) {
          return sendJson(res, 502, { error: error.message });
        }
      }

      if (groupModelTestMatch && req.method === 'POST') {
        const site = await repository.getSiteById(decodeURIComponent(groupModelTestMatch[1]));
        if (!site) return sendJson(res, 404, { error: 'Site not found' });
        if (!snapshotService) return sendJson(res, 501, { error: 'Snapshot service is not configured' });
        if (!groupModelSettingsRepository) {
          return sendJson(res, 501, { error: 'Group model settings repository is not configured' });
        }
        if (!modelProbe?.testModelLatency) return sendJson(res, 501, { error: 'Model probe is not configured' });
        const payload = await readJsonBody(req);
        // groupId 走请求体：分组名可能含 /，放路径会被代理层编码破坏
        const groupId = String(payload.groupId ?? payload.group_id ?? '').trim();
        try {
          const savedSetting = await groupModelSettingsRepository.getBySiteIdAndGroupId?.(site.id, groupId);
          const model = String(payload.model ?? savedSetting?.testModel ?? savedSetting?.selectedModel ?? '').trim();
          const snapshot = await snapshotService.getLatestSnapshot(site);
          const apiKey = chooseSnapshotToken(snapshot, groupId);
          if (!apiKey) return sendJson(res, 400, { error: 'No API key token found in saved snapshot' });
          const result = await modelProbe.testModelLatency({
            siteId: site.id,
            baseUrl: site.baseUrl || site.url,
            apiKey,
            model,
            platform: payload.platform,
            proxy: site.proxy,
          });
          const setting = await groupModelSettingsRepository.updateLastTest(site.id, groupId, result);
          return sendJson(res, 200, { result, setting });
        } catch (error) {
          return sendJson(res, 502, { error: error.message });
        }
      }

      if (snapshotMatch && req.method === 'GET') {
        const site = await repository.getSiteById(decodeURIComponent(snapshotMatch[1]));
        if (!site) return sendJson(res, 404, { error: 'Site not found' });
        if (!snapshotService) return sendJson(res, 501, { error: 'Snapshot service is not configured' });

        try {
          const snapshot = await snapshotService.getLatestSnapshot(site);
          if (!snapshot) return sendJson(res, 404, { error: 'Snapshot not found' });
          return sendJson(res, 200, { snapshot });
        } catch (error) {
          return sendJson(res, 502, { error: error.message });
        }
      }

      if (refreshMatch && req.method === 'POST') {
        const site = await repository.getSiteById(decodeURIComponent(refreshMatch[1]));
        if (!site) return sendJson(res, 404, { error: 'Site not found' });
        if (!snapshotService) return sendJson(res, 501, { error: 'Snapshot service is not configured' });

        try {
          const snapshot = await snapshotService.refreshSnapshot(site);
          return sendJson(res, 200, { snapshot });
        } catch (error) {
          return sendJson(res, 502, { error: error.message });
        }
      }

      if (requestUrl.pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'Not found' });
      }

      return await sendStatic(res, root, requestUrl.pathname, req.method);
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  };
}

function chooseSnapshotToken(snapshot, groupId = '') {
  const tokens = Array.isArray(snapshot?.tokens) ? snapshot.tokens : [];
  const targetGroupId = String(groupId ?? '').trim();
  const matched = tokens.find((token) => String(token.groupId ?? token.group_id ?? '') === targetGroupId);
  return String(matched?.key ?? snapshot?.token ?? '').trim();
}

async function sendStatic(res, publicDir, pathname, method) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  const appPage = isAppPagePath(decodedPath);
  if (!['GET', 'HEAD'].includes(method) || (!appPage && !isPublicAssetPath(decodedPath))) {
    return sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }

  const canonicalRoot = await realpath(publicDir);
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.slice(1);
  let filePath = path.resolve(canonicalRoot, relativePath);
  if (!await isFile(filePath)) {
    if (!appPage) return sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
    filePath = path.resolve(canonicalRoot, 'index.html');
    if (!await isFile(filePath)) return sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }

  // A public asset symlink must not turn private files into downloadable content.
  if (await realpath(filePath) !== filePath) {
    return sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  const contentType = MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
  const content = await readFile(filePath);
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(method === 'HEAD' ? undefined : content);
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, statusCode, body) {
  return sendText(res, statusCode, JSON.stringify(body), 'application/json; charset=utf-8');
}

function sendText(res, statusCode, body, contentType) {
  res.writeHead(statusCode, { 'content-type': contentType });
  res.end(body);
}

function fileURLToPathMaybe(value) {
  return value instanceof URL ? fileURLToPath(value) : value;
}
