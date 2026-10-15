import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { chromium } from 'playwright';

import { createRequestHandler } from '../src/http.mjs';

test('all-sites sync reports a database reload failure without replacing visible sites or showing success', { timeout: 30_000 }, async (t) => {
  const site = { id: 'site-1', name: '仍在显示的站点', type: 'sub2api', url: 'https://example.test' };
  let failSnapshotReload = false;
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: {
      async listSites() {
        return [site];
      },
      async getSiteById(id) {
        return id === site.id ? site : null;
      },
    },
    groupModelSettingsRepository: createGroupModelSettingsRepository(),
    proxyRepository: createProxyRepository(),
    uiPreferencesRepository: createUiPreferencesRepository(),
    snapshotService: {
      async getLatestSnapshot() {
        if (failSnapshotReload) throw new Error('snapshot reload failed');
        return null;
      },
      async refreshSnapshot() {
        failSnapshotReload = true;
        return { refreshedAt: new Date().toISOString() };
      },
    },
  }));
  let browser;

  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      if (server.listening) await closeServer(server);
    }
  });

  await listenOnEphemeralPort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/sites`, { waitUntil: 'networkidle' });
  await page.locator('#sites-table').getByText(site.name).waitFor();

  const reloadFailure = page.waitForResponse((response) => (
    response.url().endsWith(`/api/sites/${site.id}/snapshot`) && response.status() === 502
  ));
  await page.locator('#refresh-sites').click();
  await reloadFailure;
  await page.waitForFunction(() => !document.querySelector('#refresh-sites').disabled);

  assert.equal(await page.locator('#sites-table').getByText(site.name).count(), 1);
  assert.equal(await page.locator('#toast-region').getByText('同步失败').count(), 1);
  assert.equal(await page.locator('#toast-region').getByText('同步完成').count(), 0);
});

test('single-site sync reports a reload failure without replacing its visible snapshot or showing batch completion', { timeout: 30_000 }, async (t) => {
  const site = { id: 'site-1', name: '仍在显示的单站点', type: 'sub2api', url: 'https://example.test' };
  const snapshot = {
    siteId: site.id,
    balanceAmount: 42.5,
    balanceCurrency: 'USD',
    groups: [],
    probe: { ok: true, latencyMs: 180, status: 'healthy', checkedAt: '2026-07-11T00:00:00.000Z' },
    refreshedAt: '2026-07-11T00:00:00.000Z',
  };
  let failSnapshotReload = false;
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: {
      async listSites() {
        return [site];
      },
      async getSiteById(id) {
        return id === site.id ? site : null;
      },
    },
    groupModelSettingsRepository: createGroupModelSettingsRepository(),
    proxyRepository: createProxyRepository(),
    uiPreferencesRepository: createUiPreferencesRepository(),
    snapshotService: {
      async getLatestSnapshot() {
        if (failSnapshotReload) throw new Error('snapshot reload failed');
        return snapshot;
      },
      async refreshSnapshot() {
        failSnapshotReload = true;
        return { ...snapshot, balanceAmount: 99.99, refreshedAt: new Date().toISOString() };
      },
    },
  }));
  let browser;

  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      if (server.listening) await closeServer(server);
    }
  });

  await listenOnEphemeralPort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/sites`, { waitUntil: 'networkidle' });

  const row = page.locator('#sites-table tr').filter({ hasText: site.name });
  const syncButton = row.locator('[data-action="refresh"]');
  await row.getByText('42.50').waitFor();
  assert.equal(await syncButton.count(), 1);

  const refreshSucceeded = page.waitForResponse((response) => (
    response.url().endsWith(`/api/sites/${site.id}/snapshot/refresh`)
    && response.request().method() === 'POST'
    && response.status() === 200
  ));
  const reloadFailed = page.waitForResponse((response) => (
    response.url().endsWith(`/api/sites/${site.id}/snapshot`) && response.status() === 502
  ));
  await syncButton.click();
  await refreshSucceeded;
  await reloadFailed;
  await page.waitForFunction(() => (
    !document.querySelector('#refresh-all').disabled
    && !document.querySelector('#refresh-sites').disabled
    && !document.querySelector('#refresh-sites-table').disabled
    && [...document.querySelectorAll('[data-action="refresh"], .balance-refresh')]
      .every((control) => !control.disabled)
  ));

  assert.equal(await row.getByText(site.name).count(), 1);
  assert.equal(await row.getByText('42.50').count(), 1);
  assert.equal(await row.getByText('99.99').count(), 0);
  assert.equal(await page.locator('#toast-region').getByText('同步失败').count(), 1);
  assert.equal(await page.locator('#toast-region').getByText('同步完成').count(), 0);
  assert.equal(await page.locator('#toast-region').getByText('部分站点同步失败').count(), 0);
});

test('table refresh keeps other snapshots, marks one failed site, warns, and never posts upstream', { timeout: 30_000 }, async (t) => {
  const sites = [
    { id: 'site-1', name: '正常站点', type: 'sub2api', url: 'https://one.example.test' },
    { id: 'site-2', name: '失败站点', type: 'new-api', url: 'https://two.example.test' },
  ];
  let failSecondSnapshot = false;
  let refreshPosts = 0;
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: {
      async listSites() {
        return sites;
      },
      async getSiteById(id) {
        return sites.find((site) => site.id === id) ?? null;
      },
    },
    groupModelSettingsRepository: createGroupModelSettingsRepository(),
    proxyRepository: createProxyRepository(),
    uiPreferencesRepository: createUiPreferencesRepository(),
    snapshotService: {
      async getLatestSnapshot(site) {
        if (failSecondSnapshot && site.id === 'site-2') throw new Error('snapshot reload failed');
        return {
          siteId: site.id,
          balanceAmount: failSecondSnapshot ? 77 : 42,
          balanceCurrency: 'USD',
          groups: [],
          probe: { ok: true, latencyMs: 20, status: 'healthy', checkedAt: '2026-07-11T00:00:00.000Z' },
          refreshedAt: '2026-07-11T00:00:00.000Z',
        };
      },
      async refreshSnapshot() {
        refreshPosts += 1;
        return { refreshedAt: new Date().toISOString() };
      },
    },
  }));
  let browser;

  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      if (server.listening) await closeServer(server);
    }
  });

  await listenOnEphemeralPort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const pageUrl = `http://127.0.0.1:${address.port}/sites`;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(pageUrl, { waitUntil: 'networkidle' });
  await page.locator('#sites-table').getByText('42.00').first().waitFor();

  failSecondSnapshot = true;
  await page.locator('#refresh-sites-table').click();
  await page.waitForFunction(() => !document.querySelector('#refresh-sites-table').disabled);

  const normalRow = page.locator('#sites-table tr').filter({ hasText: '正常站点' });
  const failedRow = page.locator('#sites-table tr').filter({ hasText: '失败站点' });
  assert.equal(await normalRow.getByText('77.00').count(), 1);
  assert.equal(await failedRow.getByText(/snapshot reload failed/).count(), 1);
  assert.equal(await page.locator('#toast-region').getByText('表格已部分刷新').count(), 1);
  assert.equal(refreshPosts, 0);
});

test('site currency rates drive multiplier, balance currency, and add-edit form defaults', { timeout: 30_000 }, async (t) => {
  const sites = [
    { id: 'lucis', name: 'Lucis API', type: 'sub2api', url: 'https://lucis.example.test', usdToCnyRate: 7 },
    { id: 'smart', name: '示例站点', type: 'sub2api', url: 'https://smart.example.test', usdToCnyRate: 1 },
  ];
  const snapshots = {
    lucis: {
      siteId: 'lucis',
      balanceAmount: 1.87,
      balanceCurrency: 'USD',
      groups: [{ id: 'lucis-group', name: 'OpenAI-ChatGPT', multiplier: 0.039, enabled: true }],
      tokens: [{ id: 'lucis-key', groupId: 'lucis-group', key: 'sk-lucis' }],
      probe: { ok: true, latencyMs: 20, status: 'healthy', checkedAt: '2026-07-11T00:00:00.000Z' },
      refreshedAt: '2026-07-11T00:00:00.000Z',
    },
    smart: {
      siteId: 'smart',
      balanceAmount: 13.81,
      balanceCurrency: 'USD',
      groups: [{ id: 'smart-group', name: '快速稳定分组', multiplier: 0.005, enabled: true }],
      tokens: [{ id: 'smart-key', groupId: 'smart-group', key: 'sk-smart' }],
      probe: { ok: true, latencyMs: 20, status: 'healthy', checkedAt: '2026-07-11T00:00:00.000Z' },
      refreshedAt: '2026-07-11T00:00:00.000Z',
    },
  };
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: {
      async listSites() {
        return sites;
      },
      async getSiteById(id) {
        return sites.find((site) => site.id === id) ?? null;
      },
    },
    groupModelSettingsRepository: createGroupModelSettingsRepository(),
    proxyRepository: createProxyRepository(),
    uiPreferencesRepository: createUiPreferencesRepository(),
    snapshotService: {
      async getLatestSnapshot(site) {
        return snapshots[site.id];
      },
    },
  }));
  let browser;

  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      if (server.listening) await closeServer(server);
    }
  });

  await listenOnEphemeralPort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/groups`, { waitUntil: 'networkidle' });

  const lucisRow = page.locator('#groups-table tr').filter({ hasText: 'Lucis API' });
  const smartRow = page.locator('#groups-table tr').filter({ hasText: '示例站点' });
  const lucisGroupSiteLink = lucisRow.locator('a.external-link');
  assert.equal(await lucisGroupSiteLink.getAttribute('href'), 'https://lucis.example.test');
  assert.equal(await lucisGroupSiteLink.getAttribute('target'), '_blank');
  assert.equal(await lucisGroupSiteLink.getAttribute('rel'), 'noopener noreferrer');
  await page.context().route('https://lucis.example.test/**', (route) => route.fulfill({ body: 'ok' }));
  const [sitePage] = await Promise.all([
    page.waitForEvent('popup'),
    lucisGroupSiteLink.click(),
  ]);
  await sitePage.waitForLoadState('domcontentloaded');
  assert.equal(sitePage.url(), 'https://lucis.example.test/');
  await sitePage.close();
  assert.equal(await lucisRow.getByText('0.273x').count(), 1);
  // 余额按站点换算倍率折 CNY 展示：1.87 USD × 7 = 13.09 CNY
  assert.equal(await lucisRow.getByText('13.09').count(), 1);
  assert.equal(await lucisRow.getByText('CNY', { exact: true }).count(), 1);
  assert.equal(await smartRow.getByText('0.005x').count(), 1);
  assert.equal(await smartRow.getByText('13.81').count(), 1);
  assert.equal(await smartRow.getByText('CNY', { exact: true }).count(), 1);

  await page.goto(`${baseUrl}/sites`, { waitUntil: 'networkidle' });
  await page.locator('#sites-table tr').filter({ hasText: 'Lucis API' }).locator('[data-action="edit"]').click();
  assert.equal(await page.locator('#site-form [name="usd_to_cny_rate"]').inputValue(), '7');
  await page.locator('[data-close-modal]').first().click();
  await page.locator('#open-site-modal').click();
  assert.equal(await page.locator('#site-form [name="usd_to_cny_rate"]').inputValue(), '1');
});

test('site multi-select exposes removable chips and clear-all while keeping preferences in sync', { timeout: 30_000 }, async (t) => {
  const sites = [
    { id: 'movo', name: 'movo-ds', type: 'new-api', url: 'https://movo.example.test' },
    { id: 'zhiye', name: '智叶', type: 'sub2api', url: 'https://zhiye.example.test' },
    { id: 'third', name: '第三站点', type: 'new-api', url: 'https://third.example.test' },
  ];
  const preferenceWrites = [];
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: {
      async listSites() {
        return sites;
      },
      async getSiteById(id) {
        return sites.find((site) => site.id === id) ?? null;
      },
    },
    groupModelSettingsRepository: createGroupModelSettingsRepository(),
    proxyRepository: createProxyRepository(),
    uiPreferencesRepository: createUiPreferencesRepository({
      async upsertPreference(preferenceKey, preferences) {
        preferenceWrites.push({ preferenceKey, preferences });
        return { preferenceKey, preferences, updatedAt: new Date().toISOString() };
      },
    }),
    snapshotService: {
      async getLatestSnapshot(site) {
        return {
          siteId: site.id,
          balanceAmount: 10,
          balanceCurrency: 'CNY',
          groups: [],
          tokens: [],
          probe: { ok: true, latencyMs: 20, status: 'healthy', checkedAt: '2026-09-19T00:00:00.000Z' },
          refreshedAt: '2026-09-19T00:00:00.000Z',
        };
      },
    },
  }));
  let browser;

  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      if (server.listening) await closeServer(server);
    }
  });

  await listenOnEphemeralPort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const preferenceResponse = (response) => (
    response.url().endsWith('/api/ui-preferences/site-management')
    && response.request().method() === 'PUT'
    && response.status() === 200
  );

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/sites`, { waitUntil: 'networkidle' });
  await page.locator('#sites-table tr').filter({ hasText: '第三站点' }).waitFor();
  await page.locator('#sites-site-filter-trigger').click();

  const menu = page.locator('#sites-site-filter-menu');
  assert.equal(await menu.isVisible(), true);
  assert.deepEqual(
    await menu.locator(':scope > *').evaluateAll((children) => children.map((child) => child.id || child.className)),
    ['sites-site-filter-selection', 'dropdown-search', 'sites-site-filter-options'],
  );

  const movoOption = page.locator('#sites-site-filter-options .multi-select-option').filter({ hasText: 'movo-ds' });
  await Promise.all([
    page.waitForResponse(preferenceResponse),
    movoOption.locator('input').check(),
  ]);
  const zhiyeOption = page.locator('#sites-site-filter-options .multi-select-option').filter({ hasText: '智叶' });
  await Promise.all([
    page.waitForResponse(preferenceResponse),
    zhiyeOption.locator('input').check(),
  ]);

  assert.equal(await page.locator('#sites-site-filter-selection').isVisible(), true);
  assert.equal(await page.locator('#sites-site-filter-count').textContent(), '已选 2 项');
  assert.deepEqual(
    await page.locator('#sites-site-filter-chips .multi-select-chip-label').allTextContents(),
    ['movo-ds', '智叶'],
  );
  assert.equal(await page.locator('#sites-site-filter-options .multi-select-option.is-selected').count(), 2);
  assert.equal(await page.locator('#sites-table tr').count(), 2);
  assert.equal(await page.locator('#sites-table tr').filter({ hasText: '第三站点' }).count(), 0);

  await Promise.all([
    page.waitForResponse(preferenceResponse),
    page.locator('.multi-select-chip-remove[aria-label="移除站点：movo-ds"]').click(),
  ]);
  assert.equal(await menu.isVisible(), true);
  assert.equal(await page.locator('#sites-site-filter-count').textContent(), '已选 1 项');
  assert.deepEqual(
    await page.locator('#sites-site-filter-chips .multi-select-chip-label').allTextContents(),
    ['智叶'],
  );
  assert.equal(await page.locator('#sites-table tr').count(), 1);
  assert.equal(await page.locator('#sites-table tr').filter({ hasText: '智叶' }).count(), 1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#sites-site-filter').classList.contains('opens-up'));
  const mobileGeometry = await page.locator('#sites-site-filter-menu').evaluate((menu) => {
    const menuRect = menu.getBoundingClientRect();
    const workspaceRect = document.querySelector('.workspace').getBoundingClientRect();
    const selectionRect = document.querySelector('#sites-site-filter-selection').getBoundingClientRect();
    const searchRect = document.querySelector('#sites-site-filter-search').getBoundingClientRect();
    const optionsRect = document.querySelector('#sites-site-filter-options').getBoundingClientRect();
    return {
      menuTop: menuRect.top,
      menuRight: menuRect.right,
      menuBottom: menuRect.bottom,
      menuLeft: menuRect.left,
      workspaceTop: workspaceRect.top,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      selectionBottom: selectionRect.bottom,
      searchTop: searchRect.top,
      searchBottom: searchRect.bottom,
      optionsTop: optionsRect.top,
    };
  });
  assert.ok(mobileGeometry.menuTop >= mobileGeometry.workspaceTop);
  assert.ok(mobileGeometry.menuRight <= mobileGeometry.viewportWidth);
  assert.ok(mobileGeometry.menuBottom <= mobileGeometry.viewportHeight);
  assert.ok(mobileGeometry.menuLeft >= 0);
  assert.ok(mobileGeometry.searchTop >= mobileGeometry.selectionBottom);
  assert.ok(mobileGeometry.optionsTop >= mobileGeometry.searchBottom);

  await Promise.all([
    page.waitForResponse(preferenceResponse),
    page.locator('#sites-site-filter-clear').click(),
  ]);
  assert.equal(await menu.isVisible(), true);
  assert.equal(await page.locator('#sites-site-filter-selection').isHidden(), true);
  assert.equal(await page.locator('#sites-site-filter-label').textContent(), '全部站点');
  assert.equal(await page.locator('#sites-table tr').count(), 3);
  assert.deepEqual(
    preferenceWrites.map((entry) => [entry.preferenceKey, entry.preferences.sitesSiteFilter]),
    [
      ['site-management', ['movo']],
      ['site-management', ['movo', 'zhiye']],
      ['site-management', ['zhiye']],
      ['site-management', []],
    ],
  );
});

test('settings children render as standalone routed pages', { timeout: 30_000 }, async (t) => {
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: createRepository(),
    proxyRepository: createProxyRepository(),
    uiPreferencesRepository: createUiPreferencesRepository(),
  }));
  let browser;

  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      if (server.listening) await closeServer(server);
    }
  });

  await listenOnEphemeralPort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(`${baseUrl}/groups`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('a[href="/groups"]').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('a[href="/sites"]').getAttribute('aria-current'), null);
  assert.equal(await page.locator('#config-management-link').getAttribute('aria-current'), null);
  await page.locator('#config-management-link').click();
  await page.waitForURL('**/settings/proxies');

  const proxiesPanel = page.locator('#settings-proxies-panel');
  const autoRefreshPanel = page.locator('#settings-auto-refresh-panel');
  assert.equal(new URL(page.url()).pathname, '/settings/proxies');
  assert.equal(await page.locator('#proxy-modal').count(), 0);
  assert.equal(await page.locator('#auto-refresh-modal').count(), 0);
  assert.equal(await proxiesPanel.isVisible(), true);
  assert.equal(await autoRefreshPanel.isVisible(), false);
  assert.equal(await page.locator('#sites-panel').isVisible(), false);
  assert.equal(await page.locator('#groups-panel').isVisible(), false);
  assert.equal(await page.locator('#page-title').count(), 0);
  assert.equal(await page.locator('#proxy-form').isVisible(), true);
  assert.equal(await proxiesPanel.locator('#proxies-table').isVisible(), true);
  assert.equal(await page.locator('a[href="/groups"]').getAttribute('aria-current'), null);
  assert.equal(await page.locator('#config-management-link').getAttribute('aria-current'), 'page');
  assert.deepEqual(
    await page.locator('a[data-setting-route="proxies"]').evaluateAll((links) => links.map((link) => link.getAttribute('aria-current'))),
    ['page'],
  );
  assert.deepEqual(
    await page.locator('a[data-setting-route="auto-refresh"]').evaluateAll((links) => links.map((link) => link.getAttribute('aria-current'))),
    [null],
  );

  await page.locator('a[data-setting-route="auto-refresh"]').click();
  await page.waitForURL('**/settings/auto-refresh');

  assert.equal(new URL(page.url()).pathname, '/settings/auto-refresh');
  assert.equal(await proxiesPanel.isVisible(), false);
  assert.equal(await autoRefreshPanel.isVisible(), true);
  assert.equal(await page.locator('#auto-refresh-form').isVisible(), true);
  assert.deepEqual(
    await page.locator('a[data-setting-route="proxies"]').evaluateAll((links) => links.map((link) => link.getAttribute('aria-current'))),
    [null],
  );
  assert.deepEqual(
    await page.locator('a[data-setting-route="auto-refresh"]').evaluateAll((links) => links.map((link) => link.getAttribute('aria-current'))),
    ['page'],
  );

  await page.locator('a[href="/groups"]').click();
  await page.waitForURL('**/groups');
  assert.equal(new URL(page.url()).pathname, '/groups');
  assert.equal(await proxiesPanel.isVisible(), false);
  assert.equal(await autoRefreshPanel.isVisible(), false);
  assert.equal(await page.locator('#groups-panel').isVisible(), true);
  assert.equal(await page.locator('a[href="/groups"]').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('#config-management-link').getAttribute('aria-current'), null);
  assert.deepEqual(
    await page.locator('a[data-setting-route]').evaluateAll((links) => links.map((link) => link.getAttribute('aria-current'))),
    [null, null, null, null],
  );

  await page.goto(`${baseUrl}/settings/auto-refresh`, { waitUntil: 'networkidle' });
  assert.equal(new URL(page.url()).pathname, '/settings/auto-refresh');
  assert.equal(await autoRefreshPanel.isVisible(), true);
  assert.equal(await page.locator('#page-title').count(), 0);

  await page.goto(`${baseUrl}/settings`, { waitUntil: 'networkidle' });
  await page.waitForURL('**/settings/proxies');
  assert.equal(new URL(page.url()).pathname, '/settings/proxies');
  assert.equal(await proxiesPanel.isVisible(), true);
});

function createRepository() {
  return {
    async listSites() {
      return [];
    },
  };
}

test('refresh rules search names, save IDs, exclude duplicates and follow renamed sites on desktop/mobile', { timeout: 30_000 }, async (t) => {
  const sites = [
    { id: 'private-stable-id-a', name: '星河 API', type: 'sub2api', url: 'https://a.example.test' },
    { id: 'private-stable-id-b', name: '北辰 New API', type: 'new-api', url: 'https://b.example.test' },
  ];
  let settings = { enabled: true, intervalValue: 5, intervalUnit: 'minutes', rules: [] };
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: {
      async listSites() { return sites; },
      async getSiteById(id) { return sites.find((site) => site.id === id) ?? null; },
    },
    groupModelSettingsRepository: createGroupModelSettingsRepository(),
    proxyRepository: createProxyRepository(),
    uiPreferencesRepository: createUiPreferencesRepository({
      async getAutoRefreshSettings() { return { preferenceKey: 'auto-refresh', preferences: settings }; },
      async upsertAutoRefreshSettings(input) { settings = input; return { preferenceKey: 'auto-refresh', preferences: settings }; },
    }),
    snapshotService: { async getLatestSnapshot() { return null; } },
  }));
  let browser;
  t.after(async () => { await browser?.close(); if (server.listening) await closeServer(server); });
  await listenOnEphemeralPort(server);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/settings/auto-refresh`, { waitUntil: 'networkidle' });
  await page.locator('#auto-refresh-add-rule').click();
  const first = page.locator('.refresh-rule').first();
  await first.getByRole('searchbox').fill('星河');
  assert.equal(await first.getByLabel('北辰 New API', { exact: true }).isVisible(), false);
  await first.getByLabel('星河 API', { exact: true }).check();
  await first.getByRole('searchbox').fill('');
  await first.getByLabel('北辰 New API', { exact: true }).check();
  await first.getByRole('button', { name: '移除 北辰 New API', exact: true }).click();
  await page.locator('#auto-refresh-add-rule').click();
  const second = page.locator('.refresh-rule').nth(1);
  assert.equal(await second.getByLabel('星河 API', { exact: true }).isVisible(), false);
  await second.getByLabel('北辰 New API', { exact: true }).check();
  await second.locator('.refresh-rule-value').fill('30');
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/auto-refresh-settings') && r.request().method() === 'PUT');
  await page.locator('#auto-refresh-submit').click();
  assert.equal((await saved).status(), 200);
  assert.deepEqual(settings.rules, [
    { siteIds: [sites[0].id], intervalValue: 10, intervalUnit: 'minutes' },
    { siteIds: [sites[1].id], intervalValue: 30, intervalUnit: 'minutes' },
  ]);
  assert.equal(settings.intervalValue, 5);
  sites[0].name = '星河已改名 API';
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await first.locator('.refresh-rule-chips').innerText(), '星河已改名 API\n×');
  assert.ok(!(await page.locator('#auto-refresh-form').innerText()).includes('private-stable-id'));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await first.locator('summary').click();
    assert.equal(await first.getByLabel('星河已改名 API', { exact: true }).isChecked(), true);
    const layout = await page.locator('#auto-refresh-form').evaluate((form) => {
      const box = form.getBoundingClientRect();
      const controls = [...form.querySelectorAll('input, select, button, summary')].filter((el) => el.getClientRects().length);
      return controls.every((el) => { const r = el.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right + 1; });
    });
    assert.equal(layout, true, `controls fit at ${width}px`);
    const panelCanScroll = await page.locator('#settings-auto-refresh-panel').evaluate((panel) => {
      const style = getComputedStyle(panel);
      return panel.scrollHeight <= panel.clientHeight + 1 || style.overflowY === 'auto';
    });
    assert.equal(panelCanScroll, true, `form is not clipped at ${width}px`);
    await first.locator('summary').click();
  }
  await first.getByRole('button', { name: '删除规则', exact: true }).click();
  await page.locator('#auto-refresh-submit').click();
  await page.waitForFunction(() => !document.querySelector('#auto-refresh-submit').disabled);
  assert.equal(settings.rules.length, 1);
  assert.equal(settings.rules[0].siteIds[0], sites[1].id);
  assert.deepEqual(errors, []);
});

test('proxy imports choose or enter providers, preview gaps, show provider columns and preserve export formats', { timeout: 30_000 }, async (t) => {
  const proxies = [1, 2, 4].map((n) => ({ id: `proxy-${n}`, name: `服务商-00${n}`, provider: '服务商',
    protocol: 'socks5', host: `192.0.2.${n}`, port: 1080, username: '', password: '', status: 'active', siteCount: 0 }));
  let submitted;
  let edited;
  let releaseImport;
  const importCanFinish = new Promise((resolve) => { releaseImport = resolve; });
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: { async listSites() { return []; } },
    groupModelSettingsRepository: createGroupModelSettingsRepository(),
    proxyRepository: {
      async listProxies() { return proxies; },
      async createProxiesBatch(inputs) {
        submitted = inputs;
        await importCanFinish;
        const created = inputs.map((proxy, index) => ({ ...proxy, id: `new-${index}`, name: `服务商-00${index === 0 ? 3 : 5}`, siteCount: 0, status: 'active' }));
        proxies.push(...created);
        return { created, skipped: 0 };
      },
      async updateProxy(id, input) { edited = input; const proxy = proxies.find((p) => p.id === id); Object.assign(proxy, input); return proxy; },
    },
    uiPreferencesRepository: createUiPreferencesRepository(),
  }));
  let browser;
  t.after(async () => { releaseImport(); await browser?.close(); if (server.listening) await closeServer(server); });
  await listenOnEphemeralPort(server);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/ip-management`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#ip-management-panel').getByRole('columnheader', { name: '服务商', exact: true }).count(), 1);
  await page.locator('#open-proxy-import').click();
  const provider = page.locator('#proxy-import-provider');
  assert.equal(await provider.getAttribute('list'), 'proxy-provider-options');
  assert.deepEqual(await page.locator('#proxy-provider-options option').evaluateAll((items) => items.map((o) => o.value)), ['服务商']);
  await provider.fill('新服务商');
  assert.match(await page.locator('#proxy-import-naming').innerText(), /没有待导入的新代理/);
  await provider.fill('服务商');
  await page.locator('#proxy-import-input').fill('192.0.2.3:1080\n192.0.2.5:1080');
  await page.locator('#proxy-import-expires-at').fill('');
  assert.match(await page.locator('#proxy-import-naming').innerText(), /服务商-003、服务商-005/);
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await provider.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390);
  assert.equal(await page.locator('#proxy-import-modal').evaluate((modal) => modal.scrollWidth <= modal.clientWidth), true);
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/proxies/batch') && r.request().method() === 'POST');
  const started = page.waitForRequest((r) => r.url().endsWith('/api/proxies/batch'));
  await page.locator('#proxy-import-submit').click();
  await started;
  await provider.fill('仍在提交');
  assert.equal(await page.locator('#proxy-import-submit').isDisabled(), true);
  releaseImport();
  assert.equal((await saved).status(), 201);
  await page.locator('#proxy-import-modal').waitFor({ state: 'hidden' });
  assert.ok(submitted.every((proxy) => proxy.provider === '服务商' && proxy.expiresAt === null));
  const row = page.locator('#ip-management-table tr').filter({ hasText: '服务商-003' });
  assert.equal(await row.locator('.proxy-provider-cell').innerText(), '服务商');
  await row.locator('[data-action="select-proxy"]').check();
  await page.locator('#open-proxy-export').click();
  assert.equal(await page.locator('#proxy-export-preview').inputValue(), 'socks5://192.0.2.3:1080');
  await page.locator('input[name="proxy-export-format"][value="sub2api-json"]').check();
  const exported = JSON.parse(await page.locator('#proxy-export-preview').inputValue());
  assert.equal(exported.proxies[0].name, '服务商-003');
  assert.equal(Object.hasOwn(exported.proxies[0], 'provider'), false);
  await page.locator('#proxy-export-modal [data-close-proxy-export-modal]').last().click();
  await row.locator('[data-action="edit-proxy"]').click();
  assert.equal(await page.locator('#proxy-edit-form [name="provider"]').inputValue(), '服务商');
  await page.locator('#proxy-edit-form [name="provider"]').fill('服务商改名');
  const updated = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/proxies/'));
  await page.locator('#proxy-edit-submit').click();
  await updated;
  await page.locator('#proxy-edit-modal').waitFor({ state: 'hidden' });
  assert.equal(edited.provider, '服务商改名');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await row.locator('.proxy-provider-cell').innerText(), '服务商改名');
  await page.goto(`http://127.0.0.1:${server.address().port}/settings/proxies`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#settings-proxies-panel').getByRole('columnheader', { name: '服务商', exact: true }).count(), 1);
  assert.equal(await page.locator('#proxy-form [name="provider"]').count(), 1);
  assert.deepEqual(errors, []);
});

function createProxyRepository() {
  return {
    async listProxies() {
      return [];
    },
  };
}

function createGroupModelSettingsRepository() {
  return {
    async listBySiteIds() {
      return [];
    },
  };
}

function createUiPreferencesRepository(overrides = {}) {
  return {
    async getPreference(preferenceKey) {
      return { preferenceKey, preferences: {}, updatedAt: null };
    },
    async upsertPreference(preferenceKey, preferences) {
      return { preferenceKey, preferences, updatedAt: new Date().toISOString() };
    },
    async getAutoRefreshSettings() {
      return {
        preferenceKey: 'auto-refresh',
        preferences: { enabled: false, intervalValue: 10, intervalUnit: 'minutes' },
        updatedAt: null,
      };
    },
    ...overrides,
  };
}

async function listenOnEphemeralPort(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('IP management shows bulk actions only with selection, maps and deletes selected proxies, and keeps actions visible', { timeout: 30_000 }, async (t) => {
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const proxies = ids.map((id, index) => ({
    id, name: `WebShare-${String(index + 1).padStart(3, '0')}`, provider: 'WebShare',
    protocol: 'socks5', host: `192.0.2.${index + 1}`, port: 1080,
    username: 'user', password: 'secret', status: 'active', siteCount: 0,
  }));
  let links = [{ id: 'link-1', proxyId: ids[0], mySiteId: 'my-site-1', myProxyId: '53' }];
  const calls = [];
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url), repository: { async listSites() { return []; } },
    groupModelSettingsRepository: createGroupModelSettingsRepository(),
    uiPreferencesRepository: createUiPreferencesRepository(),
    proxyRepository: {
      async listProxies() { return proxies; },
      async deleteProxiesBatch(proxyIds) {
        calls.push(['delete', proxyIds]);
        for (const id of proxyIds) {
          const index = proxies.findIndex((proxy) => proxy.id === id);
          if (index !== -1) proxies.splice(index, 1);
        }
        links = links.filter((link) => !proxyIds.includes(link.proxyId));
        return proxyIds;
      },
    },
    mySites: { proxyService: {
      async listProxyLinks() { return links; },
      async syncProxyLinks({ proxyIds }) {
        calls.push(['map', proxyIds]);
        links.push({ id: 'link-2', proxyId: ids[1], mySiteId: 'my-site-1', myProxyId: '54' });
        return { results: [{ proxyId: ids[0], outcome: 'updated' }, { proxyId: ids[1], outcome: 'created' }] };
      },
    } },
  }));
  let browser;
  t.after(async () => { await browser?.close(); if (server.listening) await closeServer(server); });
  await listenOnEphemeralPort(server);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/ip-management`, { waitUntil: 'networkidle' });
  for (const id of ['#bulk-proxy-map', '#open-proxy-export', '#bulk-proxy-delete']) {
    assert.equal(await page.locator(id).isVisible(), false);
  }
  for (const width of [1920, 1440, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.locator('#ip-management-panel .table-wrap').evaluate((wrap) => {
      const table = wrap.querySelector('table');
      const action = table.querySelector('tbody tr td:last-child');
      const cell = action.getBoundingClientRect();
      const bounds = wrap.getBoundingClientRect();
      return { tableWidth: table.getBoundingClientRect().width, computedWidth: getComputedStyle(table).width, wrapWidth: bounds.width, actionRight: cell.right, visibleRight: bounds.right, actionWidth: cell.width,
        protocolWidth: table.querySelector('tbody tr td:nth-child(4)').getBoundingClientRect().width,
        statusWidth: table.querySelector('tbody tr td:nth-child(10)').getBoundingClientRect().width };
    });
    assert.ok(layout.actionRight <= layout.visibleRight + 1, `action column stays visible at ${width}: ${JSON.stringify(layout)}`);
    assert.ok(width <= 620 ? layout.actionWidth >= 140 && layout.actionWidth <= 150 : layout.actionWidth >= 235,
      `action column fits the viewport at ${width}: ${JSON.stringify(layout)}`);
    assert.ok(layout.protocolWidth <= 100 && layout.statusWidth <= 110, `small columns are bounded at ${width}: ${JSON.stringify(layout)}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#proxy-select-all').check();
  for (const id of ['#bulk-proxy-map', '#open-proxy-export', '#bulk-proxy-delete']) assert.equal(await page.locator(id).isVisible(), true);
  assert.equal(await page.locator('#open-proxy-export').innerText(), '导出 2 个');
  await page.screenshot({ path: '/tmp/aum-proxy-bulk-desktop.png' });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: '/tmp/aum-proxy-bulk-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  const mapped = page.waitForResponse((response) => response.url().endsWith('/api/my-site-proxies/batch'));
  await page.locator('#bulk-proxy-map').click();
  assert.equal((await mapped).status(), 200);
  await page.locator('#ip-management-table').getByText('已映射 #54').waitFor();
  assert.deepEqual(calls[0], ['map', ids]);
  page.once('dialog', (dialog) => dialog.accept());
  const deleted = page.waitForResponse((response) => response.url().endsWith('/api/proxies/batch') && response.request().method() === 'DELETE');
  await page.locator('#bulk-proxy-delete').click();
  assert.equal((await deleted).status(), 200);
  await page.waitForFunction(() => document.querySelector('#bulk-proxy-delete').hidden);
  assert.deepEqual(calls[1], ['delete', ids]);
  assert.deepEqual(errors, []);
});

test('proxy probe buttons show persisted location, batch test selected rows and dedupe before name preview', { timeout: 60_000 }, async (t) => {
  const proxies = [1, 2, 4].map((n) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name: `服务商-${String(n).padStart(3, '0')}`,
    provider: '服务商', protocol: 'socks5', host: `192.0.2.${n}`, port: 1080, username: 'u', password: 'p', siteCount: 0, status: 'active' }));
  const tested = [];
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url), repository: { async listSites() { return []; } },
    proxyRepository: { async listProxies() { return proxies; } },
    uiPreferencesRepository: createUiPreferencesRepository(),
    proxyProbeService: { async test(id) {
      tested.push(id);
      const proxy = proxies.find((item) => item.id === id);
      const ok = id === proxies[0].id;
      proxy.probeResult = { ok, ip: ok ? '203.0.113.7' : '', country: ok ? '美国' : '', region: ok ? '加州' : '', city: ok ? '洛杉矶' : '', latencyMs: ok ? 120 : null, checkedAt: new Date().toISOString(), error: ok ? '' : '探测失败' };
      return proxy.probeResult;
    } },
  }));
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); if (server.listening) await closeServer(server); });
  await listenOnEphemeralPort(server);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/ip-management`, { waitUntil: 'networkidle' });
  const rows = page.locator('#ip-management-table tr');
  await rows.first().getByText('服务商-001', { exact: true }).waitFor();
  assert.equal(await page.locator('#bulk-proxy-test').isVisible(), false);
  await rows.first().locator('[data-action="test-proxy"]').click();
  await rows.first().getByText('可用 · 120 ms', { exact: true }).waitFor();
  assert.match(await rows.first().locator('.proxy-location').innerText(), /美国 · 加州 · 洛杉矶/);
  await page.reload({ waitUntil: 'networkidle' });
  await rows.first().getByText('203.0.113.7', { exact: true }).waitFor();
  await rows.nth(1).locator('[data-action="select-proxy"]').check();
  await rows.nth(2).locator('[data-action="select-proxy"]').check();
  await page.locator('#bulk-proxy-test').click();
  await page.waitForFunction(() => document.querySelectorAll('#ip-management-table .proxy-probe.failed').length === 2);
  assert.deepEqual(tested.sort(), proxies.map((p) => p.id).sort());
  assert.equal(await rows.nth(1).locator('.proxy-location').count(), 0);
  await page.locator('#toast-region .toast-close').first().click().catch(() => {});
  await page.screenshot({ path: '/tmp/aum-proxy-probe-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const tableWrap = page.locator('#ip-management-panel .table-wrap');
  await tableWrap.evaluate((wrap) => wrap.scrollIntoView({ block: 'center' }));
  const mobileLayout = await rows.first().evaluate((row) => {
    const actions = row.lastElementChild.getBoundingClientRect();
    const name = row.querySelector('.site-name strong').getBoundingClientRect();
    return { actionRight: actions.right, actionLeft: actions.left, actionWidth: actions.width, nameLeft: name.left, nameRight: name.right };
  });
  assert.ok(mobileLayout.actionRight <= 390 && mobileLayout.actionWidth <= 150, JSON.stringify(mobileLayout));
  assert.ok(mobileLayout.nameLeft >= 0 && mobileLayout.nameRight <= mobileLayout.actionLeft, JSON.stringify(mobileLayout));
  await page.screenshot({ path: '/tmp/aum-proxy-probe-mobile.png', fullPage: true });
  const geoVisible = await tableWrap.evaluate((wrap) => {
    const geo = wrap.querySelector('.proxy-location');
    wrap.scrollLeft += geo.getBoundingClientRect().left - wrap.getBoundingClientRect().left - 10;
    const location = geo.getBoundingClientRect();
    const actions = wrap.querySelector('tbody tr td:last-child').getBoundingClientRect();
    return location.left >= wrap.getBoundingClientRect().left && location.right <= actions.left;
  });
  assert.equal(geoVisible, true, 'horizontal scrolling exposes the full exit location beside the sticky actions');
  await page.screenshot({ path: '/tmp/aum-proxy-probe-mobile-geo.png', fullPage: true });
  await page.locator('#open-proxy-import').click();
  await page.locator('#proxy-import-provider').fill('服务商');
  await page.locator('#proxy-import-input').fill('192.0.2.1:1080:u:p\n192.0.2.1:1080:u:p\n192.0.2.3:1080:u:p\n192.0.2.3:1080:u:p\n192.0.2.5:1080:u:p');
  assert.match(await page.locator('#proxy-import-stats').innerText(), /待导入 2 · 重复（含已有）3/);
  assert.match(await page.locator('#proxy-import-naming').innerText(), /服务商-003、服务商-005/);
  assert.equal(await page.locator('#proxy-import-submit').innerText(), '导入 2 个代理');
  await page.locator('#proxy-import-input').fill('192.0.2.1:1080:u:p');
  assert.equal(await page.locator('#proxy-import-submit').isDisabled(), true);
  assert.match(await page.locator('#proxy-import-naming').innerText(), /没有待导入/);
  assert.deepEqual(errors, []);
});

test('OAuth task route, sidebar, deep batch links and client back/forward keep lifecycle and query intact', { timeout: 30_000 }, async (t) => {
  const batchId = '44444444-4444-4444-8444-444444444444';
  const siteId = '11111111-1111-4111-8111-111111111111';
  const requests = [];
  const batches = new Map([[batchId, {
    id: batchId, total: 1, matchedCount: 1, statusCounts: { succeeded: 1 }, canRerun: true, legacy: false,
    createdAt: '2026-10-07T01:00:00Z', jobs: [{ id: batchId, email: 'existing@example.test', accountName: '定位账号', status: 'succeeded', stage: 'done', remoteAccountId: 91, canRerun: true }],
  }]]);
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: { async listSites() { return []; } },
    groupModelSettingsRepository: createGroupModelSettingsRepository(),
    proxyRepository: createProxyRepository(),
    uiPreferencesRepository: createUiPreferencesRepository(),
    snapshotService: { async getLatestSnapshot() { return null; } },
    oauthOnboarding: {
      async options() { requests.push('options'); return { mySites: [{ id: siteId, name: '测试目标' }], proxies: [] }; },
      async groups() { return ['默认分组', '高优先级', '日常调用', '备用分组', '团队共享', '长上下文'].map((name, i) => ({ id: 11 + i, name, platform: 'openai', status: 'active' })); },
      async preferences() { return { preferences: { groupIds: [11] }, capabilities: { atomicSchedulable: true, atomicProtection: true } }; },
      async listBatches() { requests.push('batches'); return { batches: [], nextCursor: null }; },
      async getBatch(id) { requests.push(`batch:${id}`); return batches.get(id); },
      async submitBatch(body) {
        const batch = { ...batches.get(batchId), id: body.requestId,
          jobs: [{ ...batches.get(batchId).jobs[0], id: body.requestId, batchId: body.requestId, status: 'queued' }] };
        batches.set(batch.id, batch); return batch;
      },
    },
  }));
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); if (server.listening) await closeServer(server); });
  await listenOnEphemeralPort(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/oauth-tasks?batch=${batchId}`, { waitUntil: 'networkidle' });
  const taskPanel = page.locator('#oauth-tasks-panel');
  await taskPanel.getByText('定位账号', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-tab="oauth-tasks"]').getAttribute('aria-current'), 'page');
  assert.equal(await taskPanel.locator('.oauth-batch-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(new URL(page.url()).searchParams.get('batch'), batchId);
  await page.reload({ waitUntil: 'networkidle' }); await taskPanel.getByText('定位账号', { exact: true }).waitFor();
  await page.locator('[data-tab="oauth-accounts"]').click();
  const importPanel = page.locator('#oauth-accounts-panel');
  await importPanel.locator('[data-role="site"] option[value="'+siteId+'"]').waitFor({ state: 'attached' });
  assert.equal(await importPanel.locator('[data-role="site-field"]').isVisible(), false);
  assert.equal(await importPanel.locator('[data-role="site"]').inputValue(), siteId);
  assert.equal(await page.locator('#fleet-summary').isVisible(), false);
  await importPanel.locator('[data-role="groups"] input[value="11"]').waitFor();
  if (process.env.AUM_LAYOUT_EVIDENCE) {
    await page.screenshot({ path: `${process.env.AUM_LAYOUT_EVIDENCE}/onboarding-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.AUM_LAYOUT_EVIDENCE}/onboarding-mobile.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1440, height: 960 });
  }
  await importPanel.locator('[data-role="credential-line"]').fill('existing@example.test|offline-password|JBSWY3DPEHPK3PXP');
  await importPanel.locator('[data-role="parse-credentials"]').click();
  const bootMarker = await page.evaluate(() => (window.layoutBootMarker = crypto.randomUUID()));
  await importPanel.locator('[data-role="submit"]').click();
  await page.waitForURL((url) => url.pathname === '/oauth-tasks' && url.searchParams.get('batch') !== batchId);
  const newBatchId = new URL(page.url()).searchParams.get('batch');
  await taskPanel.locator(`[data-batch-id="${newBatchId}"] .oauth-job`).waitFor();
  assert.equal(new URL(page.url()).pathname, '/oauth-tasks');
  assert.equal(new URL(page.url()).searchParams.get('batch'), newBatchId);
  assert.equal(await page.evaluate(() => window.layoutBootMarker), bootMarker, 'confirmed submission automatically uses SPA navigation rather than reloading the application');
  assert.equal(await importPanel.locator('[data-role="credential-line"]').inputValue(), '');
  if (process.env.AUM_LAYOUT_EVIDENCE) {
    await taskPanel.locator(`[data-batch-id="${newBatchId}"] .oauth-batch-toggle`).click();
    await page.screenshot({ path: `${process.env.AUM_LAYOUT_EVIDENCE}/tasks-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.AUM_LAYOUT_EVIDENCE}/tasks-mobile.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1440, height: 960 });
  }
  await page.goBack(); await importPanel.getByRole('heading', { name: '批量账号入池' }).waitFor();
  await page.goForward(); await taskPanel.locator(`[data-batch-id="${newBatchId}"] .oauth-job`).waitFor();
  assert.equal(await page.locator('#fleet-summary').isVisible(), false);
  await taskPanel.locator('[data-oauth-create-link]').click();
  await importPanel.getByRole('heading', { name: '批量账号入池' }).waitFor();
  await page.locator('[data-tab="sites"]').click();
  assert.equal(await page.locator('#fleet-summary').isVisible(), true);
  const count = requests.filter((request) => request === 'batches' || request.startsWith('batch:')).length;
  await page.waitForTimeout(3200);
  assert.equal(requests.filter((request) => request === 'batches' || request.startsWith('batch:')).length, count, 'leaving task route stops task polling');
  assert.deepEqual(errors, []);
});


test('share frontend keeps model probes, rate history and my sites while removed pages return 404', { timeout: 30_000 }, async (t) => {
  const site = { id: 'site-1', name: '示例上游', type: 'sub2api', url: 'https://upstream.example.test' };
  const group = { id: 'group-1', name: '示例分组', platform: 'openai', multiplier: 1, enabled: true };
  const snapshot = {
    siteId: site.id, groups: [group], tokens: [{ key: 'sk-offline-test', groupId: group.id }],
    probe: { ok: true, latencyMs: 20, status: 'healthy', checkedAt: '2026-10-15T00:00:00.000Z' },
    balanceAmount: 20, balanceCurrency: 'CNY', refreshedAt: '2026-10-15T00:00:00.000Z',
  };
  let setting = { siteId: site.id, groupId: group.id, selectedModel: 'example-model', testModel: 'example-model', modelOptions: [], lastTest: null };
  const probes = [];
  const modelLists = [];
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: {
      async listSites() { return [site]; },
      async getSiteById(id) { return id === site.id ? site : null; },
    },
    snapshotService: { async getLatestSnapshot() { return snapshot; } },
    groupModelSettingsRepository: {
      async listBySiteIds() { return [setting]; },
      async getBySiteIdAndGroupId() { return setting; },
      async updateLastTest(siteId, groupId, lastTest) {
        setting = { ...setting, siteId, groupId, lastTest };
        return setting;
      },
    },
    modelProbe: {
      async fetchAvailableModels(input) { modelLists.push(input); return [{ id: 'additional-model' }]; },
      async testModelLatency(input) {
        probes.push(input);
        return { success: true, status: 'healthy', responseTimeMs: 368, modelUsed: input.model, testedAt: '2026-10-15T00:00:00.000Z' };
      },
    },
    proxyRepository: createProxyRepository(),
    uiPreferencesRepository: createUiPreferencesRepository(),
    groupRateChangeRepository: {
      async listChanges() {
        return { items: [], total: 0, page: 1, pages: 1, asOf: '2026-10-15T00:00:00.000Z' };
      },
    },
    mySites: {
      repository: { async listMySites() { return [{ id: 'my-site', name: '示例我的站点', type: 'sub2api', url: 'https://mine.example.test' }]; } },
      accountRepository: { async listAccounts() { return []; } },
      proxyService: { async listProxyLinks() { return []; } },
      service: {
        async listLinkedAccountsRemote() { return []; },
        async listRemoteGroups() { return []; },
      },
    },
  }));
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    if (server.listening) await closeServer(server);
  });
  await listenOnEphemeralPort(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.goto(`${base}/groups`, { waitUntil: 'networkidle' });
  await page.locator('#groups-table tr').getByText(group.name, { exact: true }).waitFor();
  assert.equal(await page.locator('#groups-panel thead th').count(), 13);
  assert.equal(await page.locator('#groups-table tr').first().locator('td').count(), 13);
  assert.equal(await page.locator('[data-tab="pricing"], [data-tab="benchmarks"], #pricing-panel, #benchmarks-panel, [data-action="run-group-benchmark"]').count(), 0);

  await page.locator('[data-action="test-group-model"]').click();
  await page.locator('#groups-table').getByText('368 ms', { exact: true }).waitFor();
  assert.equal(probes.length, 1);
  assert.equal(probes[0].model, 'example-model');
  assert.equal(probes[0].apiKey, 'sk-offline-test');
  assert.equal(await page.locator('#toast-region').getByText('模型测试完成', { exact: true }).count(), 1);

  await page.locator('[data-action="edit-group-model"]').click();
  await page.locator('#fetch-group-models').click();
  await page.locator('#group-model-select option[value="additional-model"]').waitFor({ state: 'attached' });
  assert.equal(modelLists.length, 1);
  assert.equal(modelLists[0].apiKey, 'sk-offline-test');
  await page.locator('[data-close-group-model-modal]').first().click();

  const historyResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/group-rate-changes' && response.ok());
  await page.locator('[data-tab="rate-changes"]').click();
  await historyResponse;
  assert.equal(await page.locator('#rate-changes-panel').isVisible(), true);
  await page.locator('#config-management-link').click();
  await page.locator('[data-setting-route="my-sites"]').click();
  await page.locator('#my-sites-table').getByText('示例我的站点', { exact: true }).waitFor();
  assert.equal(await page.locator('#my-site-form').isVisible(), true);
  await page.locator('[data-tab="groups"]').click();
  await page.locator('#groups-table').getByText('368 ms', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-action="open-create-account"]').isVisible(), true);
  assert.deepEqual(requests.filter((path) => /\/api\/(?:pricing|benchmarks)(?:\/|$)|pricing-view/.test(path)), []);
  assert.deepEqual(errors, []);
  for (const path of ['/pricing', '/benchmarks']) {
    const response = await page.request.get(`${base}${path}`);
    assert.equal(response.status(), 404, `${path} must not serve the application shell`);
  }
});
