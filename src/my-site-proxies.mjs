import { createSub2ApiAdminClient } from './my-sites-admin.mjs';

// 编排"把监控侧代理映射到我的站点（sub2api）"的流程：
// sub2 侧已有同连接信息的代理时直接采用（adopt）并把名称向监控侧对齐，否则新建
export function createMySiteProxyService({
  mySiteRepository,
  mySiteProxyRepository,
  proxyRepository,
  adminClientFactory = createSub2ApiAdminClient,
} = {}) {
  if (!mySiteRepository) throw new Error('My site repository is required');
  if (!mySiteProxyRepository) throw new Error('My site proxy repository is required');
  if (!proxyRepository) throw new Error('Proxy repository is required');

  // 只有一个 sub2api 我的站点时自动选用；多个时必须显式指定
  async function resolveMySite(mySiteId) {
    if (mySiteId) {
      const mySite = await mySiteRepository.getMySiteById(String(mySiteId).trim());
      if (!mySite) throw withStatus(404, 'My site not found');
      return mySite;
    }
    const candidates = (await mySiteRepository.listMySites()).filter((item) => item.type === 'sub2api');
    if (candidates.length === 0) throw withStatus(400, '还没有配置 sub2api 我的站点');
    if (candidates.length > 1) throw withStatus(400, '存在多个 sub2api 我的站点，请指定 mySiteId');
    return candidates[0];
  }

  return {
    async listProxyLinks({ mySiteId = null, proxyId = null } = {}) {
      return await mySiteProxyRepository.listLinks({ mySiteId, proxyId });
    },

    async createProxyLink({ mySiteId = null, proxyId, syncAll = false }) {
      const proxy = await proxyRepository.getProxyById(String(proxyId ?? '').trim());
      if (!proxy) throw withStatus(404, 'Proxy not found');
      const mySite = await resolveMySite(mySiteId);

      const existing = await mySiteProxyRepository.listLinks({ mySiteId: mySite.id, proxyId: proxy.id });
      if (existing.length > 0) throw withStatus(409, '该代理已创建过映射');

      const client = adminClientFactory({ baseUrl: mySite.url, adminKey: mySite.adminKey });
      const remoteProxies = await client.listProxies();
      const matched = remoteProxies.find((item) => (
        item.host === proxy.host
          && Number(item.port) === Number(proxy.port)
          && item.username === (proxy.username ?? '')
          && item.password === (proxy.password ?? '')
      ));

      let remote;
      let adopted = false;
      if (matched) {
        // 采用既有代理：名称与到期时间向监控侧对齐
        adopted = true;
        const alignment = {};
        if (matched.name !== proxy.name) alignment.name = proxy.name;
        if (proxy.expiresAt && matched.expiresAt !== proxy.expiresAt) alignment.expiresAt = proxy.expiresAt;
        if (syncAll) {
          Object.assign(alignment, proxySyncFields(proxy));
        }
        if (Object.keys(alignment).length > 0) await client.updateProxy(matched.id, alignment);
        remote = { id: matched.id, name: proxy.name };
      } else {
        remote = await client.createProxy({
          name: proxy.name,
          protocol: proxy.protocol,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username ?? '',
          password: proxy.password ?? '',
          expiresAt: proxy.expiresAt ?? null,
        });
        if (!remote.id) throw withStatus(502, '创建代理成功但未返回代理 ID');
        if (proxy.status === 'inactive') await client.updateProxy(remote.id, { status: 'inactive' });
      }

      const link = await mySiteProxyRepository.createLink({
        mySiteId: mySite.id,
        proxyId: proxy.id,
        myProxyId: remote.id,
      });
      return { link, adopted, remoteName: remote.name };
    },

    async syncProxyLinks({ mySiteId = null, proxyIds } = {}) {
      if (!Array.isArray(proxyIds) || proxyIds.length === 0 || proxyIds.length > 200
          || proxyIds.some((id) => typeof id !== 'string' || !id.trim())
          || new Set(proxyIds).size !== proxyIds.length) {
        throw withStatus(400, 'proxyIds must contain 1–200 unique non-empty IDs');
      }
      const mySite = await resolveMySite(mySiteId);
      const links = await mySiteProxyRepository.listLinks({ mySiteId: mySite.id });
      const linksByProxyId = new Map(links.map((link) => [link.proxyId, link]));
      const client = adminClientFactory({ baseUrl: mySite.url, adminKey: mySite.adminKey });
      const results = [];
      for (const proxyId of proxyIds) {
        try {
          const proxy = await proxyRepository.getProxyById(proxyId);
          if (!proxy) throw withStatus(404, 'Proxy not found');
          const link = linksByProxyId.get(proxyId);
          if (link) {
            await client.updateProxy(link.myProxyId, proxySyncFields(proxy));
            results.push({ proxyId, outcome: 'updated' });
          } else {
            const mapped = await this.createProxyLink({ mySiteId: mySite.id, proxyId, syncAll: true });
            results.push({ proxyId, outcome: mapped.adopted ? 'adopted' : 'created' });
          }
        } catch (error) {
          // 批次继续执行；错误只返回受控摘要，避免上游响应意外包含认证信息。
          console.error('[proxy-batch-map]', { proxyId, errorType: error.name ?? 'Error', statusCode: error.statusCode ?? error.httpStatus ?? null, errorCode: error.errorCode ?? null });
          results.push({ proxyId, outcome: 'failed', error: error.statusCode === 404 ? '代理不存在' : '映射或同步失败' });
        }
      }
      return { results };
    },

    // 只解除本地映射关系，不动 sub2 侧的代理记录
    async deleteProxyLink(linkId) {
      const deleted = await mySiteProxyRepository.deleteLinkById(String(linkId ?? '').trim());
      if (!deleted) throw withStatus(404, 'Proxy link not found');
      return { ok: true };
    },
  };
}

function proxySyncFields(proxy) {
  return {
    name: proxy.name,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username ?? '',
    password: proxy.password ?? '',
    status: proxy.status,
    expiresAt: proxy.expiresAt ?? null,
  };
}

function withStatus(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
