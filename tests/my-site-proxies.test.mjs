import test from 'node:test';
import assert from 'node:assert/strict';

import { createMySiteProxyService } from '../src/my-site-proxies.mjs';

const MY_SITE = { id: 'my-site-1', name: 'Example Site', type: 'sub2api', url: 'https://sub.example.com', adminKey: 'k' };
const PROXY = { id: 'proxy-1', name: 'default', protocol: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p', status: 'active', expiresAt: '2026-10-02T00:00:00.000Z' };

function createFakes({ links = [], remoteProxies = [], mySites = [MY_SITE] } = {}) {
  const calls = { createProxy: [], updateProxy: [], createLink: [] };
  return {
    calls,
    mySiteRepository: {
      async listMySites() {
        return mySites;
      },
      async getMySiteById(id) {
        return mySites.find((item) => item.id === id) ?? null;
      },
    },
    mySiteProxyRepository: {
      async listLinks({ mySiteId = null, proxyId = null } = {}) {
        return links.filter((link) => (
          (!mySiteId || link.mySiteId === mySiteId) && (!proxyId || link.proxyId === proxyId)
        ));
      },
      async createLink(input) {
        calls.createLink.push(input);
        return { id: 'link-1', ...input };
      },
      async deleteLinkById(id) {
        return links.some((link) => link.id === id);
      },
    },
    proxyRepository: {
      async getProxyById(id) {
        return id === PROXY.id ? { ...PROXY } : null;
      },
    },
    adminClientFactory: () => ({
      async listProxies() {
        return remoteProxies;
      },
      async createProxy(input) {
        calls.createProxy.push(input);
        return { id: '88', name: input.name };
      },
      async updateProxy(id, input) {
        calls.updateProxy.push([id, input]);
        return {};
      },
    }),
  };
}

test('creates remote proxy and link when sub2 side has no matching proxy', async () => {
  const fakes = createFakes();
  const service = createMySiteProxyService(fakes);

  const result = await service.createProxyLink({ proxyId: PROXY.id });

  assert.equal(result.adopted, false);
  // 新建时把到期时间一起同步到 sub2
  assert.deepEqual(fakes.calls.createProxy, [{
    name: 'default', protocol: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p',
    expiresAt: '2026-10-02T00:00:00.000Z',
  }]);
  assert.deepEqual(fakes.calls.createLink, [{ mySiteId: 'my-site-1', proxyId: 'proxy-1', myProxyId: '88' }]);
  assert.equal(result.link.myProxyId, '88');
});

test('adopts existing remote proxy with same connection and aligns its name and expiry', async () => {
  const fakes = createFakes({
    remoteProxies: [{ id: '66', name: '旧名字', protocol: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p', status: 'active', expiresAt: null }],
  });
  const service = createMySiteProxyService(fakes);

  const result = await service.createProxyLink({ proxyId: PROXY.id });

  assert.equal(result.adopted, true);
  assert.equal(result.link.myProxyId, '66');
  assert.deepEqual(fakes.calls.createProxy, []);
  // 名称与到期时间向监控侧对齐
  assert.deepEqual(fakes.calls.updateProxy, [['66', { name: 'default', expiresAt: '2026-10-02T00:00:00.000Z' }]]);
});

test('adopts existing remote proxy without updating when name and expiry already match', async () => {
  const fakes = createFakes({
    remoteProxies: [{ id: '66', name: 'default', protocol: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p', status: 'active', expiresAt: '2026-10-02T00:00:00.000Z' }],
  });
  const service = createMySiteProxyService(fakes);

  const result = await service.createProxyLink({ proxyId: PROXY.id });

  assert.equal(result.adopted, true);
  assert.deepEqual(fakes.calls.updateProxy, []);
});

test('rejects duplicate link for the same proxy and my site', async () => {
  const fakes = createFakes({
    links: [{ id: 'link-0', mySiteId: 'my-site-1', proxyId: 'proxy-1', myProxyId: '66' }],
  });
  const service = createMySiteProxyService(fakes);

  await assert.rejects(
    () => service.createProxyLink({ proxyId: PROXY.id }),
    (error) => error.statusCode === 409,
  );
  assert.deepEqual(fakes.calls.createProxy, []);
});

test('requires a sub2api my site when none configured', async () => {
  const fakes = createFakes({ mySites: [] });
  const service = createMySiteProxyService(fakes);

  await assert.rejects(
    () => service.createProxyLink({ proxyId: PROXY.id }),
    (error) => error.statusCode === 400 && /我的站点/.test(error.message),
  );
});

test('deleteProxyLink removes the local link only', async () => {
  const fakes = createFakes({
    links: [{ id: 'link-0', mySiteId: 'my-site-1', proxyId: 'proxy-1', myProxyId: '66' }],
  });
  const service = createMySiteProxyService(fakes);

  assert.deepEqual(await service.deleteProxyLink('link-0'), { ok: true });
  await assert.rejects(
    () => service.deleteProxyLink('missing'),
    (error) => error.statusCode === 404,
  );
});

test('bulk mapping synchronizes every common field for existing links and creates missing links', async () => {
  const fakes = createFakes({
    links: [{ id: 'link-0', mySiteId: MY_SITE.id, proxyId: PROXY.id, myProxyId: '66' }],
  });
  fakes.proxyRepository.getProxyById = async (id) => ({
    ...PROXY, id, name: id === PROXY.id ? '已更新' : '新代理', status: 'inactive',
    username: '', password: '', expiresAt: null,
  });
  const service = createMySiteProxyService(fakes);
  const result = await service.syncProxyLinks({ proxyIds: [PROXY.id, 'proxy-2'] });
  assert.deepEqual(result.results, [
    { proxyId: PROXY.id, outcome: 'updated' },
    { proxyId: 'proxy-2', outcome: 'created' },
  ]);
  assert.deepEqual(fakes.calls.updateProxy, [['66', {
    name: '已更新', protocol: 'socks5', host: '1.2.3.4', port: 1080,
    username: '', password: '', status: 'inactive', expiresAt: null,
  }], ['88', { status: 'inactive' }]]);
  assert.deepEqual(fakes.calls.createProxy, [{
    name: '新代理', protocol: 'socks5', host: '1.2.3.4', port: 1080,
    username: '', password: '', expiresAt: null,
  }]);
});

test('bulk mapping adopts an unmapped remote proxy and continues after one failure', async () => {
  const fakes = createFakes({ remoteProxies: [{ ...PROXY, id: 'remote-3', name: '旧名', expiresAt: null }] });
  fakes.proxyRepository.getProxyById = async (id) => id === 'missing' ? null : ({ ...PROXY, id, expiresAt: null });
  const service = createMySiteProxyService(fakes);
  const result = await service.syncProxyLinks({ proxyIds: ['missing', 'proxy-3'] });
  assert.deepEqual(result.results, [
    { proxyId: 'missing', outcome: 'failed', error: '代理不存在' },
    { proxyId: 'proxy-3', outcome: 'adopted' },
  ]);
  assert.equal(fakes.calls.updateProxy[0][0], 'remote-3');
  assert.equal(fakes.calls.updateProxy[0][1].expiresAt, null);
  assert.deepEqual(fakes.calls.createLink[0], { mySiteId: MY_SITE.id, proxyId: 'proxy-3', myProxyId: 'remote-3' });
  await assert.rejects(service.syncProxyLinks({ proxyIds: ['same', 'same'] }), /unique/);
});
