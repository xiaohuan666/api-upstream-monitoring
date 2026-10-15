import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createRequestHandler } from '../src/http.mjs';
import { createProxyRepository as createDatabaseProxyRepository, createUiPreferencesRepository } from '../src/db.mjs';

test('GET /api/health returns ok', async () => {
  const handler = createRequestHandler({ publicDir: await createPublicDir(), repository: createRepo() });

  const response = await request(handler, 'GET', '/api/health');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
});

test('GET /api/sites returns repository sites', async () => {
  const sites = [{ id: 'site-1', name: '示例站点', url: 'https://relay.example.com', type: 'new-api' }];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({ listSites: async () => sites }),
  });

  const response = await request(handler, 'GET', '/api/sites');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { sites });
});

test('GET /api/proxies returns proxy configurations', async () => {
  const proxies = [
    {
      id: 'proxy-1',
      name: 'sub2 bridge',
      protocol: 'http',
      host: 'host.docker.internal',
      port: 17896,
      status: 'active',
    },
  ];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    proxyRepository: createProxyRepo({ listProxies: async () => proxies }),
  });

  const response = await request(handler, 'GET', '/api/proxies');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { proxies });
});

test('POST /api/proxies creates a proxy configuration', async () => {
  const calls = [];
  const created = { id: 'proxy-1', name: 'sub2 bridge', protocol: 'http', host: 'host.docker.internal', port: 17896 };
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    proxyRepository: createProxyRepo({
      createProxy: async (input) => {
        calls.push(input);
        return created;
      },
    }),
  });

  const response = await request(handler, 'POST', '/api/proxies', {
    name: 'sub2 bridge',
    protocol: 'http',
    host: 'host.docker.internal',
    port: 17896,
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls[0], {
    name: 'sub2 bridge',
    protocol: 'http',
    host: 'host.docker.internal',
    port: 17896,
  });
  assert.deepEqual(JSON.parse(response.body), { proxy: created });
});

test('PUT and DELETE /api/proxies/:id update and delete proxy configurations', async () => {
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    proxyRepository: createProxyRepo({
      updateProxy: async (id, input) => {
        calls.push(['update', id, input]);
        return { id, ...input };
      },
      deleteProxy: async (id) => {
        calls.push(['delete', id]);
        return true;
      },
    }),
  });

  const updateResponse = await request(handler, 'PUT', '/api/proxies/proxy-1', {
    name: 'edited',
    protocol: 'socks5',
    host: 'proxy.local',
    port: 1080,
  });
  const deleteResponse = await request(handler, 'DELETE', '/api/proxies/proxy-1');

  assert.equal(updateResponse.statusCode, 200);
  assert.equal(deleteResponse.statusCode, 200);
  assert.deepEqual(calls, [
    ['update', 'proxy-1', { name: 'edited', protocol: 'socks5', host: 'proxy.local', port: 1080 }],
    ['delete', 'proxy-1'],
  ]);
});

test('POST /api/proxies/batch imports parsed proxies with dedupe counts', async () => {
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    proxyRepository: createProxyRepo({
      createProxiesBatch: async (inputs) => {
        calls.push(inputs);
        return { created: [{ id: 'proxy-9', ...inputs[0], name: '1.2.3.4:1080' }], skipped: 1 };
      },
    }),
  });

  const response = await request(handler, 'POST', '/api/proxies/batch', {
    proxies: [
      { protocol: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' },
      { protocol: 'socks5', host: '2.3.4.5', port: 8080, username: '', password: '' },
    ],
  });
  const emptyResponse = await request(handler, 'POST', '/api/proxies/batch', { proxies: [] });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(JSON.parse(response.body), {
    created: 1,
    skipped: 1,
    proxies: [{ id: 'proxy-9', protocol: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p', name: '1.2.3.4:1080', provider: '' }],
  });
  assert.equal(calls[0].length, 2);
  assert.equal(emptyResponse.statusCode, 400);
});

test('batch proxy endpoint applies the selected provider to every entry', async () => {
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(), repository: createRepo(),
    proxyRepository: createProxyRepo({
      async createProxiesBatch(inputs) { calls.push(inputs); return { created: [], skipped: inputs.length }; },
    }),
  });
  const response = await request(handler, 'POST', '/api/proxies/batch', {
    provider: '星河', proxies: [{ host: 'a', port: 80 }, { host: 'b', port: 81, provider: 'overridden' }],
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls, [[{ host: 'a', port: 80, provider: '星河' }, { host: 'b', port: 81, provider: '星河' }]]);
});

test('proxy write endpoints reject C1 control characters before accessing the database', async () => {
  let databaseCalls = 0;
  const unexpectedDatabaseAccess = async () => {
    databaseCalls += 1;
    throw new Error('Unexpected database access');
  };
  const handler = createRequestHandler({
    publicDir: await createPublicDir(), repository: createRepo(),
    proxyRepository: createDatabaseProxyRepository({
      query: unexpectedDatabaseAccess, connect: unexpectedDatabaseAccess,
    }),
  });
  const proxy = { name: 'test', host: 'proxy.test', port: 80, provider: 'A\u0085B' };
  for (const [method, url, payload] of [
    ['POST', '/api/proxies', proxy],
    ['PUT', '/api/proxies/proxy-1', proxy],
    ['POST', '/api/proxies/batch', { provider: proxy.provider, proxies: [{ host: proxy.host, port: proxy.port }] }],
  ]) {
    const response = await request(handler, method, url, payload);
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error, '服务商名称不能包含控制字符');
  }
  assert.equal(databaseCalls, 0);
});

test('my-site-proxies routes expose link listing, creation and deletion', async () => {
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    mySites: {
      proxyService: {
        async listProxyLinks(filters) {
          calls.push(['list', filters]);
          return [{ id: 'link-1', mySiteId: 'my-site-1', proxyId: 'proxy-1', myProxyId: '66' }];
        },
        async createProxyLink(input) {
          calls.push(['create', input]);
          return { link: { id: 'link-1', myProxyId: '66' }, adopted: true, remoteName: 'default' };
        },
        async deleteProxyLink(id) {
          calls.push(['delete', id]);
          return { ok: true };
        },
      },
    },
  });

  const listResponse = await request(handler, 'GET', '/api/my-site-proxies?proxyId=proxy-1');
  const createResponse = await request(handler, 'POST', '/api/my-site-proxies', { proxyId: 'proxy-1' });
  const deleteResponse = await request(handler, 'DELETE', '/api/my-site-proxies/link-1');

  assert.equal(listResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(listResponse.body).links, [
    { id: 'link-1', mySiteId: 'my-site-1', proxyId: 'proxy-1', myProxyId: '66' },
  ]);
  assert.equal(createResponse.statusCode, 201);
  assert.deepEqual(JSON.parse(createResponse.body).adopted, true);
  assert.equal(deleteResponse.statusCode, 200);
  assert.deepEqual(calls, [
    ['list', { mySiteId: null, proxyId: 'proxy-1' }],
    ['create', { mySiteId: null, proxyId: 'proxy-1' }],
    ['delete', 'link-1'],
  ]);
});

test('GET /api/ui-preferences/group-management returns saved group view preferences', async () => {
  const preference = {
    preferenceKey: 'group-management',
    preferences: {
      groupSortKey: 'multiplier',
      groupSortDirection: 'desc',
      groupModelFilter: 'gpt-5.5',
      groupSiteFilter: 'site-1',
      groupPlatformFilter: 'openai',
      groupKeyFilter: 'all',
    },
    updatedAt: '2026-07-04T08:00:00.000Z',
  };
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    uiPreferencesRepository: createUiPreferencesRepo({
      getPreference: async (key) => {
        calls.push(['get', key]);
        return preference;
      },
    }),
  });

  const response = await request(handler, 'GET', '/api/ui-preferences/group-management');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [['get', 'group-management']]);
  assert.deepEqual(JSON.parse(response.body), { preference });
});

test('PUT /api/ui-preferences/group-management persists normalized group view preferences', async () => {
  const calls = [];
  const saved = {
    preferenceKey: 'group-management',
    preferences: {
      groupSortKey: 'site',
      groupSortDirection: 'asc',
      groupModelFilter: 'all',
      groupSiteFilter: 'all',
      groupPlatformFilter: 'anthropic',
      groupKeyFilter: '1',
    },
    updatedAt: '2026-07-04T08:01:00.000Z',
  };
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    uiPreferencesRepository: createUiPreferencesRepo({
      upsertPreference: async (key, preferences) => {
        calls.push(['upsert', key, preferences]);
        return saved;
      },
    }),
  });

  const response = await request(handler, 'PUT', '/api/ui-preferences/group-management', {
    groupSortKey: 'site',
    groupSortDirection: 'asc',
    groupModelFilter: '',
    groupSiteFilter: '',
    groupPlatformFilter: 'anthropic',
    groupKeyFilter: '1',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [['upsert', 'group-management', {
    groupSortKey: 'site',
    groupSortDirection: 'asc',
    groupModelFilter: '',
    groupSiteFilter: '',
    groupPlatformFilter: 'anthropic',
    groupKeyFilter: '1',
  }]]);
  assert.deepEqual(JSON.parse(response.body), { preference: saved });
});

test('GET /api/group-filter-presets lists presets from the repository', async () => {
  const presets = [
    { name: '低价openai', groupMultiplierMin: 0.03, groupMultiplierMax: 0.08, updatedAt: '2026-08-01T10:00:00.000Z' },
  ];
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    uiPreferencesRepository: createUiPreferencesRepo({
      listGroupFilterPresets: async () => {
        calls.push(['list']);
        return presets;
      },
    }),
  });

  const response = await request(handler, 'GET', '/api/group-filter-presets');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [['list']]);
  assert.deepEqual(JSON.parse(response.body), { presets });
});

test('PUT /api/group-filter-presets upserts by name and passes rename through', async () => {
  const calls = [];
  const saved = { name: '低价openai', groupMultiplierMin: 0.02, updatedAt: '2026-08-01T10:01:00.000Z' };
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    uiPreferencesRepository: createUiPreferencesRepo({
      upsertGroupFilterPreset: async (payload) => {
        calls.push(['upsert', payload]);
        return saved;
      },
    }),
  });

  const renameBody = { name: '低价openai', groupMultiplierMin: 0.02, originalName: '旧名' };
  const response = await request(handler, 'PUT', '/api/group-filter-presets', renameBody);
  const rejected = await request(handler, 'PUT', '/api/group-filter-presets', { name: '  ' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [['upsert', renameBody]]);
  assert.deepEqual(JSON.parse(response.body), { preset: saved });
  assert.equal(rejected.statusCode, 400);
});

test('DELETE /api/group-filter-presets deletes by request body name', async () => {
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    uiPreferencesRepository: createUiPreferencesRepo({
      deleteGroupFilterPreset: async (name) => {
        calls.push(['delete', name]);
        return name !== 'missing';
      },
    }),
  });

  const response = await request(handler, 'DELETE', '/api/group-filter-presets', { name: '低价openai' });
  const missing = await request(handler, 'DELETE', '/api/group-filter-presets', { name: 'missing' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [['delete', '低价openai'], ['delete', 'missing']]);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
  assert.equal(missing.statusCode, 404);
});

test('GET and PUT /api/auto-refresh-settings reads and saves auto refresh config', async () => {
  const calls = [];
  const rescheduleStarted = deferred();
  const rescheduleCanFinish = deferred();
  const loaded = {
    preferenceKey: 'auto-refresh',
    preferences: { enabled: false, intervalValue: 10, intervalUnit: 'minutes' },
    updatedAt: null,
  };
  const saved = {
    preferenceKey: 'auto-refresh',
    preferences: { enabled: true, intervalValue: 5, intervalUnit: 'minutes' },
    updatedAt: '2026-07-09T08:00:00.000Z',
  };
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    uiPreferencesRepository: createUiPreferencesRepo({
      getAutoRefreshSettings: async () => {
        calls.push(['get']);
        return loaded;
      },
      upsertAutoRefreshSettings: async (settings) => {
        calls.push(['upsert', settings]);
        return saved;
      },
    }),
    onAutoRefreshSettingsChanged: async (settings) => {
      calls.push(['reschedule', settings]);
      rescheduleStarted.resolve();
      await rescheduleCanFinish.promise;
      calls.push(['reschedule-complete']);
    },
  });

  const getResponse = await request(handler, 'GET', '/api/auto-refresh-settings');
  let putCompleted = false;
  const putResponsePromise = request(handler, 'PUT', '/api/auto-refresh-settings', {
    enabled: true,
    intervalValue: 3,
    intervalUnit: 'minutes',
  }).then((response) => {
    putCompleted = true;
    return response;
  });
  await rescheduleStarted.promise;

  assert.equal(putCompleted, false);
  assert.deepEqual(calls, [
    ['get'],
    ['upsert', { enabled: true, intervalValue: 3, intervalUnit: 'minutes' }],
    ['reschedule', saved.preferences],
  ]);

  rescheduleCanFinish.resolve();
  const putResponse = await putResponsePromise;

  assert.equal(getResponse.statusCode, 200);
  assert.equal(putResponse.statusCode, 200);
  assert.deepEqual(calls, [
    ['get'],
    ['upsert', { enabled: true, intervalValue: 3, intervalUnit: 'minutes' }],
    ['reschedule', saved.preferences],
    ['reschedule-complete'],
  ]);
  assert.deepEqual(JSON.parse(getResponse.body), { preference: loaded });
  assert.deepEqual(JSON.parse(putResponse.body), { preference: saved });
});

test('auto refresh API saves ID rules and rejects invalid rules before persistence', async () => {
  const writes = [];
  const sites = [{ id: 'stable-id', name: '改名后的站点', type: 'sub2api' }];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({ listSites: async () => sites }),
    uiPreferencesRepository: createUiPreferencesRepo({
      upsertAutoRefreshSettings: async (settings) => {
        writes.push(settings);
        return { preferenceKey: 'auto-refresh', preferences: settings };
      },
    }),
  });
  const rule = { siteIds: ['stable-id'], intervalValue: 10, intervalUnit: 'minutes' };
  const good = await request(handler, 'PUT', '/api/auto-refresh-settings', { rules: [rule] });
  assert.equal(good.statusCode, 200);
  for (const rules of [[rule, rule], [{ ...rule, siteIds: ['deleted'] }], [{ ...rule, siteIds: [] }],
    [{ ...rule, intervalValue: 1 }], null]) {
    const bad = await request(handler, 'PUT', '/api/auto-refresh-settings', { rules });
    assert.equal(bad.statusCode, 400);
  }
  assert.deepEqual(writes, [{ rules: [rule] }]);
});

test('POST /api/sites creates a site from JSON body', async () => {
  const calls = [];
  const created = {
    id: 'site-2',
    name: '示例站点',
    url: 'https://relay.example.com',
    type: 'new-api',
    username: 'admin',
    password: 'plain',
  };
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({
      createSite: async (input) => {
        calls.push(input);
        return created;
      },
    }),
  });

  const response = await request(handler, 'POST', '/api/sites', {
    name: '示例站点',
    url: 'relay.example.com',
    type: 'new-api',
    username: 'admin',
    password: 'plain',
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls[0], {
    name: '示例站点',
    url: 'relay.example.com',
    type: 'new-api',
    username: 'admin',
    password: 'plain',
  });
  assert.deepEqual(JSON.parse(response.body), { site: created });
});

test('POST /api/sites returns 400 when repository validation fails', async () => {
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({
      createSite: async () => {
        throw new Error('Unsupported site type: bad');
      },
    }),
  });

  const response = await request(handler, 'POST', '/api/sites', { type: 'bad' });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'Unsupported site type: bad' });
});

test('PUT /api/sites/:id updates a site from JSON body', async () => {
  const calls = [];
  const updated = {
    id: 'site-2',
    name: '示例站点 edited',
    url: 'https://relay.example.com',
    type: 'sub2api',
    username: '',
    password: 'plain',
    authToken: 'token',
  };
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({
      updateSite: async (id, input) => {
        calls.push({ id, input });
        return updated;
      },
    }),
  });

  const response = await request(handler, 'PUT', '/api/sites/site-2', {
    name: '示例站点 edited',
    url: 'relay.example.com',
    type: 'sub2api',
    password: 'plain',
    auth_token: 'token',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [
    {
      id: 'site-2',
      input: {
        name: '示例站点 edited',
        url: 'relay.example.com',
        type: 'sub2api',
        password: 'plain',
        auth_token: 'token',
      },
    },
  ]);
  assert.deepEqual(JSON.parse(response.body), { site: updated });
});

test('PUT /api/sites/:id returns 404 when the site is missing', async () => {
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({ updateSite: async () => null }),
  });

  const response = await request(handler, 'PUT', '/api/sites/missing-site', {
    name: 'missing',
    url: 'https://relay.example.com',
    type: 'other',
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), { error: 'Site not found' });
});

test('PUT /api/sites/:id returns 400 when repository validation fails', async () => {
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({
      updateSite: async () => {
        throw new Error('Bearer Token is required for sub2api');
      },
    }),
  });

  const response = await request(handler, 'PUT', '/api/sites/site-2', {
    name: 'bad',
    url: 'https://relay.example.com',
    type: 'sub2api',
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'Bearer Token is required for sub2api' });
});

test('DELETE /api/sites/:id deletes a site', async () => {
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({
      deleteSite: async (id) => {
        calls.push(id);
        return true;
      },
    }),
  });

  const response = await request(handler, 'DELETE', '/api/sites/site-2');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ['site-2']);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
});

test('DELETE /api/sites/:id returns 404 when the site is missing', async () => {
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({ deleteSite: async () => false }),
  });

  const response = await request(handler, 'DELETE', '/api/sites/missing-site');

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), { error: 'Site not found' });
});

test('PUT /api/sites/:id/watched toggles the watch flag', async () => {
  const calls = [];
  const site = { id: 'site-2', name: '示例站点', watched: true };
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({
      setSiteWatched: async (id, watched) => {
        calls.push([id, watched]);
        return { ...site, watched };
      },
    }),
  });

  const response = await request(handler, 'PUT', '/api/sites/site-2/watched', { watched: true });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [['site-2', true]]);
  assert.deepEqual(JSON.parse(response.body), { site: { ...site, watched: true } });
});

test('PUT /api/sites/:id/watched returns 404 when the site is missing', async () => {
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({ setSiteWatched: async () => null }),
  });

  const response = await request(handler, 'PUT', '/api/sites/missing-site/watched', { watched: false });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), { error: 'Site not found' });
});

test('GET /api/sites/:id/snapshot returns latest stored upstream snapshot without refreshing', async () => {
  const site = {
    id: 'site-1',
    name: '示例站点1',
    url: 'https://sub2.example.test',
    type: 'sub2api',
    authToken: 'token',
  };
  const snapshot = {
    siteId: 'site-1',
    balanceAmount: 23.7,
    groups: [],
    tokens: [],
    probe: { status: 'healthy', latencyMs: 300 },
  };
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({
      getSiteById: async (id) => (id === site.id ? site : null),
    }),
    snapshotService: {
      getLatestSnapshot: async (input) => {
        calls.push(input);
        return snapshot;
      },
      refreshSnapshot: async () => {
        throw new Error('should not refresh on GET');
      },
    },
  });

  const response = await request(handler, 'GET', '/api/sites/site-1/snapshot');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [site]);
  assert.deepEqual(JSON.parse(response.body), { snapshot });
});

test('POST /api/sites/:id/snapshot/refresh fetches upstream and stores a new snapshot', async () => {
  const site = {
    id: 'site-1',
    name: '示例站点1',
    url: 'https://sub2.example.test',
    type: 'sub2api',
    authToken: 'token',
  };
  const snapshot = {
    siteId: 'site-1',
    balanceAmount: 24.1,
    groups: [],
    tokens: [],
    probe: { status: 'healthy', latencyMs: 300 },
  };
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({
      getSiteById: async (id) => (id === site.id ? site : null),
    }),
    snapshotService: {
      getLatestSnapshot: async () => null,
      refreshSnapshot: async (input) => {
        calls.push(input);
        return snapshot;
      },
    },
  });

  const response = await request(handler, 'POST', '/api/sites/site-1/snapshot/refresh');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [site]);
  assert.deepEqual(JSON.parse(response.body), { snapshot });
});

test('GET /api/sites/:id/snapshot returns 404 when no stored snapshot exists', async () => {
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({
      getSiteById: async () => ({ id: 'site-1', type: 'sub2api' }),
    }),
    snapshotService: {
      getLatestSnapshot: async () => null,
    },
  });

  const response = await request(handler, 'GET', '/api/sites/site-1/snapshot');

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), { error: 'Snapshot not found' });
});

test('GET /api/sites/:id/snapshot returns 404 when site does not exist', async () => {
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({ getSiteById: async () => null }),
    snapshotService: { getLatestSnapshot: async () => ({}) },
  });

  const response = await request(handler, 'GET', '/api/sites/missing/snapshot');

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), { error: 'Site not found' });
});

test('POST /api/sites/:id/snapshot/refresh returns 502 when upstream refresh fails', async () => {
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({
      getSiteById: async () => ({ id: 'site-1', type: 'sub2api' }),
    }),
    snapshotService: {
      refreshSnapshot: async () => {
        throw new Error('Sub2API auth token is required');
      },
    },
  });

  const response = await request(handler, 'POST', '/api/sites/site-1/snapshot/refresh');

  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body), { error: 'Sub2API auth token is required' });
});

test('GET /api/sites/:id/models fetches available models using the saved snapshot token', async () => {
  const proxy = activeProxy();
  const site = { id: 'site-1', url: 'https://relay.example.com', type: 'sub2api', proxy };
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({ getSiteById: async () => site }),
    snapshotService: {
      getLatestSnapshot: async () => ({ token: 'sk-live', tokens: [] }),
    },
    modelProbe: {
      fetchAvailableModels: async (input) => {
        calls.push(input);
        return [{ id: 'gpt-4o-mini', ownedBy: 'openai' }];
      },
    },
  });

  const response = await request(handler, 'GET', '/api/sites/site-1/models');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{ siteId: site.id, baseUrl: site.url, apiKey: 'sk-live', proxy }]);
  assert.deepEqual(JSON.parse(response.body), {
    models: [{ id: 'gpt-4o-mini', ownedBy: 'openai' }],
  });
});

test('GET /api/sites/:id/models uses the requested group token when groupId is provided', async () => {
  const proxy = activeProxy();
  const site = { id: 'site-1', url: 'https://relay.example.com', type: 'sub2api', proxy };
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({ getSiteById: async () => site }),
    snapshotService: {
      getLatestSnapshot: async () => ({
        token: 'sk-fallback',
        tokens: [
          { key: 'sk-openai', groupId: 'openai-group' },
          { key: 'sk-claude', groupId: 'ccmax' },
        ],
      }),
    },
    modelProbe: {
      fetchAvailableModels: async (input) => {
        calls.push(input);
        return [{ id: 'claude-sonnet-4-5', ownedBy: 'anthropic' }];
      },
    },
  });

  const response = await request(handler, 'GET', '/api/sites/site-1/models?groupId=ccmax');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{ siteId: site.id, baseUrl: site.url, apiKey: 'sk-claude', proxy }]);
  assert.deepEqual(JSON.parse(response.body), {
    models: [{ id: 'claude-sonnet-4-5', ownedBy: 'anthropic' }],
  });
});

test('PUT /api/sites/:id/group-model-settings saves group model selection with groupId in body', async () => {
  const calls = [];
  const saved = {
    siteId: 'site-1',
    groupId: 'Claude-0.02元/次',
    selectedModel: 'gpt-4o-mini',
    testModel: 'gpt-4o',
    modelOptions: [{ id: 'gpt-4o-mini' }],
    lastTest: null,
  };
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({ getSiteById: async () => ({ id: 'site-1' }) }),
    groupModelSettingsRepository: {
      upsertSetting: async (input) => {
        calls.push(input);
        return saved;
      },
    },
  });

  // 分组名含 / 时 groupId 必须经请求体传递，放路径会被代理层编码破坏
  const response = await request(handler, 'PUT', '/api/sites/site-1/group-model-settings', {
    groupId: 'Claude-0.02元/次',
    selectedModel: 'gpt-4o-mini',
    testModel: 'gpt-4o',
    modelOptions: [{ id: 'gpt-4o-mini' }],
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{
    siteId: 'site-1',
    groupId: 'Claude-0.02元/次',
    selectedModel: 'gpt-4o-mini',
    testModel: 'gpt-4o',
    modelOptions: [{ id: 'gpt-4o-mini' }],
  }]);
  assert.deepEqual(JSON.parse(response.body), { setting: saved });
});

test('PUT /api/sites/:id/group-score saves hvoy score with groupId in body', async () => {
  const calls = [];
  const saved = {
    siteId: 'site-1',
    groupId: 'Claude-0.02元/次',
    selectedModel: 'gpt-4o-mini',
    testModel: 'gpt-4o',
    modelOptions: [],
    score: 90,
    lastTest: null,
  };
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({ getSiteById: async () => ({ id: 'site-1' }) }),
    groupModelSettingsRepository: {
      updateScore: async (siteId, groupId, score) => {
        calls.push([siteId, groupId, score]);
        return saved;
      },
    },
  });

  const response = await request(handler, 'PUT', '/api/sites/site-1/group-score', {
    groupId: 'Claude-0.02元/次',
    score: 90,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [['site-1', 'Claude-0.02元/次', 90]]);
  assert.deepEqual(JSON.parse(response.body), { setting: saved });
});

test('POST /api/sites/:id/group-model-test uses saved test model when request omits model', async () => {
  const proxy = activeProxy();
  const site = { id: 'site-1', url: 'https://relay.example.com', type: 'sub2api', proxy };
  const calls = [];
  const testResult = {
    success: true,
    status: 'healthy',
    message: '模型响应正常',
    responseTimeMs: 368,
    httpStatus: 200,
    modelUsed: 'gpt-4o-mini',
    testedAt: '2026-07-04T07:02:00.000Z',
  };
  const saved = {
    siteId: 'site-1',
    groupId: 'group-a',
    selectedModel: 'gpt-5.5',
    testModel: 'claude-sonnet-5',
    modelOptions: [],
    lastTest: testResult,
  };
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({ getSiteById: async () => site }),
    snapshotService: {
      getLatestSnapshot: async () => ({
        token: 'sk-fallback',
        tokens: [{ key: 'sk-group', groupId: 'group-a' }],
      }),
    },
    groupModelSettingsRepository: {
      getBySiteIdAndGroupId: async (siteId, groupId) => {
        calls.push(['load-setting', siteId, groupId]);
        return saved;
      },
      updateLastTest: async (siteId, groupId, result) => {
        calls.push(['save', siteId, groupId, result]);
        return saved;
      },
    },
    modelProbe: {
      testModelLatency: async (input) => {
        calls.push(['test', input]);
        return testResult;
      },
    },
  });

  const response = await request(handler, 'POST', '/api/sites/site-1/group-model-test', {
    groupId: 'group-a',
    platform: 'openai',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [
    ['load-setting', 'site-1', 'group-a'],
    ['test', {
      siteId: site.id,
      baseUrl: site.url,
      apiKey: 'sk-group',
      model: 'claude-sonnet-5',
      platform: 'openai',
      proxy,
    }],
    ['save', 'site-1', 'group-a', testResult],
  ]);
  assert.deepEqual(JSON.parse(response.body), { result: testResult, setting: saved });
});

test('POST /api/sites/:id/group-model-test probes against the site base URL when set', async () => {
  const site = {
    id: 'site-1',
    url: 'https://relay.example.com',
    baseUrl: 'https://api.relay.example.com',
    type: 'sub2api',
  };
  const calls = [];
  const testResult = {
    success: true,
    status: 'healthy',
    message: '模型响应正常',
    responseTimeMs: 120,
    httpStatus: 200,
    modelUsed: 'gpt-4o-mini',
    testedAt: '2026-07-04T07:02:00.000Z',
  };
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo({ getSiteById: async () => site }),
    snapshotService: {
      getLatestSnapshot: async () => ({ token: 'sk-live', tokens: [] }),
    },
    groupModelSettingsRepository: {
      getBySiteIdAndGroupId: async () => null,
      updateLastTest: async (siteId, groupId, result) => ({
        siteId,
        groupId,
        selectedModel: '',
        testModel: '',
        modelOptions: [],
        lastTest: result,
      }),
    },
    modelProbe: {
      testModelLatency: async (input) => {
        calls.push(input);
        return testResult;
      },
    },
  });

  const response = await request(handler, 'POST', '/api/sites/site-1/group-model-test', {
    groupId: 'group-a',
    model: 'gpt-4o-mini',
    platform: 'openai',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{
    siteId: site.id,
    baseUrl: 'https://api.relay.example.com',
    apiKey: 'sk-live',
    model: 'gpt-4o-mini',
    platform: 'openai',
    proxy: undefined,
  }]);
});

test('GET known client routes serves index.html for direct navigation', async () => {
  const publicDir = await createPublicDir();
  const handler = createRequestHandler({ publicDir, repository: createRepo() });

  for (const pathname of [
    '/sites', '/groups', '/rate-changes', '/ip-management', '/oauth-accounts', '/oauth-tasks',
    '/settings', '/settings/proxies', '/settings/auto-refresh', '/settings/my-sites', '/settings/oauth-onboarding',
  ]) {
    const response = await request(handler, 'GET', pathname);
    assert.equal(response.statusCode, 200, pathname);
    assert.match(response.headers['content-type'], /text\/html/, pathname);
    assert.match(response.body, /上游 API 监控台/, pathname);
  }
});

test('GET known client route serves matching static file before index fallback', async () => {
  const publicDir = await createPublicDir();
  await writeFile(path.join(publicDir, 'sites'), 'real sites file');
  const handler = createRequestHandler({ publicDir, repository: createRepo() });

  const response = await request(handler, 'GET', '/sites');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'real sites file');
});

test('POST known client route remains 404', async () => {
  const handler = createRequestHandler({ publicDir: await createPublicDir(), repository: createRepo() });

  const response = await request(handler, 'POST', '/sites');

  assert.equal(response.statusCode, 404);
  assert.equal(response.body, 'Not found');
});

test('GET unknown client route remains 404', async () => {
  const handler = createRequestHandler({ publicDir: await createPublicDir(), repository: createRepo() });
  const response = await request(handler, 'GET', '/settings/missing');
  assert.equal(response.statusCode, 404);
  assert.equal(response.body, 'Not found');
});

test('GET / serves static index.html', async () => {
  const publicDir = await createPublicDir();
  const handler = createRequestHandler({ publicDir, repository: createRepo() });

  const response = await request(handler, 'GET', '/');

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.body, /上游 API 监控台/);
});

test('my-sites CRUD routes delegate to repository', async () => {
  const mySite = { id: 'my-site-1', name: '主站', type: 'sub2api', url: 'https://sub.example.com', adminKey: 'k' };
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    mySites: {
      repository: {
        async listMySites() {
          return [mySite];
        },
        async createMySite(input) {
          calls.push(['create', input]);
          return { id: 'my-site-1', ...input };
        },
        async updateMySite(id, input) {
          calls.push(['update', id, input]);
          return { id, ...input };
        },
        async deleteMySite(id) {
          calls.push(['delete', id]);
          return true;
        },
      },
    },
  });

  const listResponse = await request(handler, 'GET', '/api/my-sites');
  assert.equal(listResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(listResponse.body), { mySites: [mySite] });

  const createResponse = await request(handler, 'POST', '/api/my-sites', { name: '主站', url: 'https://sub.example.com', adminKey: 'k' });
  assert.equal(createResponse.statusCode, 201);

  const updateResponse = await request(handler, 'PUT', '/api/my-sites/my-site-1', { name: '改名', url: 'https://sub.example.com', adminKey: 'k' });
  assert.equal(updateResponse.statusCode, 200);

  const deleteResponse = await request(handler, 'DELETE', '/api/my-sites/my-site-1');
  assert.equal(deleteResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(deleteResponse.body), { ok: true });

  assert.deepEqual(calls, [
    ['create', { name: '主站', url: 'https://sub.example.com', adminKey: 'k' }],
    ['update', 'my-site-1', { name: '改名', url: 'https://sub.example.com', adminKey: 'k' }],
    ['delete', 'my-site-1'],
  ]);
});

test('my-sites routes return 501 when not configured', async () => {
  const handler = createRequestHandler({ publicDir: await createPublicDir(), repository: createRepo() });

  const response = await request(handler, 'GET', '/api/my-sites');
  assert.equal(response.statusCode, 501);
});

test('GET /api/my-sites/:id/groups proxies remote groups through service', async () => {
  const groups = [{ id: '7', name: 'gpt-plus', platform: 'openai', rateMultiplier: 0.09, status: 'active' }];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    mySites: {
      service: {
        async listRemoteGroups(mySiteId) {
          assert.equal(mySiteId, 'my-site-1');
          return groups;
        },
      },
    },
  });

  const response = await request(handler, 'GET', '/api/my-sites/my-site-1/groups');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { groups });
});

test('GET /api/my-sites/:id/groups maps service failure to 502', async () => {
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    mySites: {
      service: {
        async listRemoteGroups() {
          throw new Error('remote refused');
        },
      },
    },
  });

  const response = await request(handler, 'GET', '/api/my-sites/my-site-1/groups');

  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body), { error: 'remote refused' });
});

test('GET /api/my-site-accounts lists links with filters', async () => {
  const accounts = [{ id: 'link-1', mySiteId: 'my-site-1', myGroupId: '7', upstreamSiteId: 'site-1', upstreamGroupId: 'g-1' }];
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    mySites: {
      accountRepository: {
        async listAccounts(filters) {
          calls.push(filters);
          return accounts;
        },
      },
    },
  });

  const response = await request(handler, 'GET', '/api/my-site-accounts?upstreamSiteId=site-1&upstreamGroupId=g-1');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { accounts });
  assert.deepEqual(calls, [{ mySiteId: null, upstreamSiteId: 'site-1', upstreamGroupId: 'g-1' }]);
});

test('POST /api/my-site-accounts creates link and maps conflict to 409', async () => {
  const link = { id: 'link-1', mySiteId: 'my-site-1', myGroupId: '7', upstreamSiteId: 'site-1', upstreamGroupId: 'g-1' };
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    mySites: {
      service: {
        async createAccountLink(input) {
          calls.push(input);
          if (input.myGroupId === '8') {
            const error = new Error('该分组下已创建过账号');
            error.statusCode = 409;
            throw error;
          }
          return link;
        },
      },
    },
  });

  const createResponse = await request(handler, 'POST', '/api/my-site-accounts', {
    mySiteId: 'my-site-1',
    myGroupId: '7',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  });
  assert.equal(createResponse.statusCode, 201);
  assert.deepEqual(JSON.parse(createResponse.body), { account: link });
  assert.deepEqual(calls[0], {
    mySiteId: 'my-site-1',
    myGroupId: '7',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
    poolMode: true,
    poolModeRetryCount: 3,
    responsesMode: null,
    excludedModels: null,
  });

  const excludedResponse = await request(handler, 'POST', '/api/my-site-accounts', {
    mySiteId: 'my-site-1',
    myGroupId: '7',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
    excludedModels: ['gpt-image-1', 'gpt-5.6-luna'],
  });
  assert.equal(excludedResponse.statusCode, 201);
  assert.deepEqual(calls[1].excludedModels, ['gpt-image-1', 'gpt-5.6-luna']);

  const conflictResponse = await request(handler, 'POST', '/api/my-site-accounts', {
    mySiteId: 'my-site-1',
    myGroupId: '8',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  });
  assert.equal(conflictResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(conflictResponse.body), { error: '该分组下已创建过账号' });
});

test('GET /api/my-site-accounts/remote returns links with remote state', async () => {
  const accounts = [{ id: 'link-1', mySiteName: '主站', remote: { schedulable: true, priority: 1 }, remoteError: null }];
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    mySites: {
      service: {
        async listLinkedAccountsRemote(filters) {
          calls.push(filters);
          return accounts;
        },
      },
    },
  });

  const response = await request(handler, 'GET', '/api/my-site-accounts/remote?upstreamSiteId=site-1&upstreamGroupId=g-1');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { accounts });
  assert.deepEqual(calls, [{ upstreamSiteId: 'site-1', upstreamGroupId: 'g-1' }]);
});

test('PATCH /api/my-site-accounts/:id updates remote schedulable and priority', async () => {
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(),
    repository: createRepo(),
    mySites: {
      service: {
        async updateLinkedAccountRemote(input) {
          calls.push(input);
          if (input.accountLinkId === 'link-x') {
            const error = new Error('Account link not found');
            error.statusCode = 404;
            throw error;
          }
          return { link: { id: input.accountLinkId }, remote: { schedulable: false, priority: 9 } };
        },
      },
    },
  });

  const response = await request(handler, 'PATCH', '/api/my-site-accounts/link-1', { schedulable: false, priority: 9 });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{ accountLinkId: 'link-1', schedulable: false, priority: 9 }]);
  assert.deepEqual(JSON.parse(response.body), {
    link: { id: 'link-1' },
    remote: { schedulable: false, priority: 9 },
  });

  const missingResponse = await request(handler, 'PATCH', '/api/my-site-accounts/link-x', { priority: 1 });
  assert.equal(missingResponse.statusCode, 404);
  assert.deepEqual(JSON.parse(missingResponse.body), { error: 'Account link not found' });
});

function createRepo(overrides = {}) {
  return {
    async listSites() {
      return [];
    },
    async createSite() {
      return {};
    },
    async getSiteById() {
      return null;
    },
    async updateSite() {
      return null;
    },
    async deleteSite() {
      return false;
    },
    ...overrides,
  };
}

function createProxyRepo(overrides = {}) {
  return {
    async listProxies() {
      return [];
    },
    async createProxy() {
      return {};
    },
    async updateProxy() {
      return null;
    },
    async deleteProxy() {
      return false;
    },
    ...overrides,
  };
}

function createUiPreferencesRepo(overrides = {}) {
  return {
    async getPreference() {
      return null;
    },
    async upsertPreference() {
      return null;
    },
    ...overrides,
  };
}

function activeProxy() {
  return {
    id: 'proxy-1',
    name: '本地 Clash 7897',
    protocol: 'http',
    host: '127.0.0.1',
    port: 7897,
    username: '',
    password: '',
    status: 'active',
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createPublicDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'api-upstream-http-'));
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'index.html'), '<title>上游 API 监控台</title>');
  await writeFile(path.join(dir, 'src', 'app.mjs'), 'console.log("ok");');
  return dir;
}

async function request(handler, method, url, body) {
  return await new Promise((resolve, reject) => {
    const req = new FakeRequest(method, url, body);
    const res = new FakeResponse(resolve);
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

class FakeRequest {
  constructor(method, url, body) {
    this.method = method;
    this.url = url;
    this.headers = body ? { 'content-type': 'application/json' } : {};
    this.body = body === undefined ? null : Buffer.from(JSON.stringify(body));
  }

  async *[Symbol.asyncIterator]() {
    if (this.body) yield this.body;
  }
}

class FakeResponse {
  constructor(done) {
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.done = done;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value);
    }
  }

  end(chunk = '') {
    if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    this.done({
      statusCode: this.statusCode,
      headers: this.headers,
      body: Buffer.concat(this.chunks).toString('utf8'),
    });
  }
}

test('batch proxy mapping and deletion pass selected IDs and reject invalid delete input', async () => {
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const calls = [];
  const handler = createRequestHandler({
    publicDir: await createPublicDir(), repository: createRepo(),
    proxyRepository: createProxyRepo({
      async deleteProxiesBatch(proxyIds) { calls.push(['delete', proxyIds]); return proxyIds; },
    }),
    mySites: { proxyService: {
      async syncProxyLinks(input) {
        calls.push(['map', input]);
        return { results: input.proxyIds.map((proxyId) => ({ proxyId, outcome: 'updated' })) };
      },
    } },
  });
  const mapped = await request(handler, 'POST', '/api/my-site-proxies/batch', { proxyIds: ids });
  assert.equal(mapped.statusCode, 200);
  assert.equal(JSON.parse(mapped.body).results.length, 2);
  const invalid = await request(handler, 'DELETE', '/api/proxies/batch', { proxyIds: [ids[0], ids[0]] });
  assert.equal(invalid.statusCode, 400);
  const deleted = await request(handler, 'DELETE', '/api/proxies/batch', { proxyIds: ids });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(JSON.parse(deleted.body), { deletedIds: ids });
  assert.deepEqual(calls, [['map', { mySiteId: null, proxyIds: ids }], ['delete', ids]]);
});

test('proxy test endpoint validates IDs and handles stale or failed persistence without leaking details', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  let failure = null;
  let calls = 0;
  const handler = createRequestHandler({ publicDir: await createPublicDir(), repository: createRepo(), proxyProbeService: {
    async test(proxyId) { calls++; assert.equal(proxyId, id); if (failure) throw failure; return { ok: false, error: '探测失败' }; },
  } });
  assert.equal((await request(handler, 'POST', '/api/proxies/bad/test')).statusCode, 400);
  assert.equal(calls, 0);
  const response = await request(handler, 'POST', `/api/proxies/${id}/test`);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).result.ok, false);
  failure = Object.assign(new Error('代理已修改或删除，请重新测试'), { statusCode: 409 });
  assert.equal((await request(handler, 'POST', `/api/proxies/${id}/test`)).statusCode, 409);
  failure = new Error('secret-database-credentials');
  const failed = await request(handler, 'POST', `/api/proxies/${id}/test`);
  assert.equal(failed.statusCode, 500);
  assert.doesNotMatch(failed.body, /secret/);
});


test('GET/PUT /api/ui-preferences/rate-change-history reuse the HTTP envelope and independent DB normalization', async () => {
  const rows = new Map();
  const uiPreferencesRepository = createUiPreferencesRepository({ async query(sql, [key, json]) {
    if (/insert into ui_preferences/.test(sql)) rows.set(key, { preference_key: key, preferences: JSON.parse(json), updated_at: new Date('2026-10-03T00:00:00Z') });
    return { rows: rows.has(key) ? [rows.get(key)] : [] };
  } });
  const handler = createRequestHandler({ publicDir: await createPublicDir(), repository: createRepo(), uiPreferencesRepository });
  const path = '/api/ui-preferences/rate-change-history';
  const initial = await request(handler, 'GET', path);
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(JSON.parse(initial.body), { preference: {
    preferenceKey: 'rate-change-history', preferences: { columnOrder: ['platform', 'group', 'site', 'change', 'old', 'new'] }, updatedAt: null,
  } });
  const groupPut = await request(handler, 'PUT', '/api/ui-preferences/group-management', { groupSortKey: 'multiplier', groupSortDirection: 'desc' });
  assert.equal(groupPut.statusCode, 200);
  const saved = await request(handler, 'PUT', path, { columnOrder: ['site', 'new', 'site', 'unknown'], groupSortKey: 'site' });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(JSON.parse(saved.body), { preference: {
    preferenceKey: 'rate-change-history', preferences: { columnOrder: ['site', 'new', 'platform', 'group', 'change', 'old'] }, updatedAt: '2026-10-03T00:00:00.000Z',
  } });
  assert.deepEqual(JSON.parse((await request(handler, 'GET', path)).body), JSON.parse(saved.body));
  assert.deepEqual(JSON.parse((await request(handler, 'GET', '/api/ui-preferences/group-management')).body), JSON.parse(groupPut.body));
});
