import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createRequestHandler } from '../src/http.mjs';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const DAY_MS = 86_400_000;
const sites = [
  { id: SITE_A, name: '星河 API', type: 'sub2api', url: 'https://one.example.test', usdToCnyRate: 7 },
  { id: SITE_B, name: '北辰 API', type: 'new-api', url: 'https://two.example.test', usdToCnyRate: 1 },
];

function change(n, now, overrides = {}) {
  return {
    id: `event-${n}`, siteId: n % 2 ? SITE_B : SITE_A,
    siteName: n % 2 ? sites[1].name : sites[0].name, siteType: n % 2 ? 'new-api' : 'sub2api',
    groupId: `group-${n}`, groupName: `分组 ${n}`, platform: n % 2 ? 'anthropic' : 'openai', siteUrl: n % 2 ? sites[1].url : sites[0].url,
    oldMultiplier: n % 2 ? 0.3 : 0.273, newMultiplier: n % 2 ? 0.2 : 0.273000000001,
    rawOldMultiplier: n % 2 ? 0.3 : 0.039, rawNewMultiplier: n % 2 ? 0.2 : 0.039000000001,
    changedAt: new Date(now - (n + 1) * 60_000).toISOString(), ...overrides,
  };
}

/** 仅本地 ephemeral HTTP + DI 假数据库/API，无生产连接和外部同步。 */
async function fixture(t, { count = 125, setupPage = null, preferenceRepository = null } = {}) {
  const context = {
    now: Date.now(), items: [], queries: [], posts: [], errors: [], failRates: false, failSnapshots: false,
    listHook: null, preferences: new Map(), failPreferenceLoad: false, failPreferenceSave: false, preferenceWriteHook: null,
  };
  context.items = Array.from({ length: count }, (_, i) => change(i, context.now));
  const handler = createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: {
      async listSites() { return sites; },
      async getSiteById(id) { return sites.find((site) => site.id === id) ?? null; },
    },
    groupRateChangeRepository: {
      async listChanges(options) {
        const request = context.queries.at(-1);
        if (context.listHook) await context.listHook(options);
        if (context.failRates) throw new Error('fake history failure');
        const asOf = request.searchParams.has('asOf') ? options.asOf : new Date(context.now).toISOString();
        const upper = Date.parse(asOf);
        const windowStart = options.window === '24h' ? new Date(upper - DAY_MS).toISOString() : null;
        const items = context.items.filter((item) => (
          Date.parse(item.changedAt) <= upper
          && (!windowStart || Date.parse(item.changedAt) > Date.parse(windowStart))
          && (!options.siteId || item.siteId === options.siteId)
          && (!options.q || `${item.siteName} ${item.groupName}`.includes(options.q))
          && (!options.direction || (options.direction === 'up' ? item.newMultiplier > item.oldMultiplier : item.newMultiplier < item.oldMultiplier))
        ));
        const start = (options.page - 1) * options.pageSize;
        return { items: items.slice(start, start + options.pageSize), total: items.length, page: options.page, pageSize: options.pageSize, pages: Math.max(1, Math.ceil(items.length / options.pageSize)), asOf, windowStart, snapshot: options.snapshot ?? '500' };
      },
    },
    groupModelSettingsRepository: { async listBySiteIds() { return []; } },
    proxyRepository: { async listProxies() { return []; } },
    uiPreferencesRepository: {
      async getPreference(preferenceKey) {
        if (preferenceKey === 'rate-change-history' && context.failPreferenceLoad) throw new Error('test preference load failed');
        if (preferenceRepository && preferenceKey === 'rate-change-history') return preferenceRepository.getPreference(preferenceKey);
        return { preferenceKey, preferences: context.preferences.get(preferenceKey) || {} };
      },
      async upsertPreference(preferenceKey, preferences) {
        if (context.failPreferenceSave) throw new Error('test preference save failed');
        if (context.preferenceWriteHook) await context.preferenceWriteHook(preferences);
        if (preferenceRepository && preferenceKey === 'rate-change-history') return preferenceRepository.upsertPreference(preferenceKey, preferences);
        context.preferences.set(preferenceKey, preferences);
        return { preferenceKey, preferences };
      },
      async getAutoRefreshSettings() { return { preferences: { enabled: false, intervalValue: 10, intervalUnit: 'minutes' } }; },
    },
    snapshotService: {
      async getLatestSnapshot(site) {
        if (context.failSnapshots) throw new Error('fake snapshot reload failure');
        return { siteId: site.id, balanceAmount: 42.5, balanceCurrency: 'USD', groups: [], tokens: [], probe: { ok: true }, refreshedAt: new Date(context.now).toISOString() };
      },
      async refreshSnapshot() { return { refreshedAt: new Date(context.now).toISOString() }; },
    },
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/group-rate-changes') context.queries.push(url);
    if (req.method !== 'GET') context.posts.push({ method: req.method, path: url.pathname });
    return handler(req, res);
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  page.on('pageerror', (error) => context.errors.push(error.message));
  if (setupPage) await setupPage(page);
  return { context, page, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function loaded(page, kind = 'dashboard') {
  await page.waitForFunction((kind) => document.getElementById(`rate-change-${kind === 'dashboard' ? 'dashboard' : 'history-scroll'}`).getAttribute('aria-busy') === 'false', kind);
}

async function select(page, id, value) {
  // 与旧 UI 一致，select 由 searchable-select 增强；原生值仍是唯一数据来源。
  await page.locator(`#${id}`).selectOption(value, { force: true });
}

test('sites show equal 144px cards, relocated add button, precise safe records and all 24h pages', { timeout: 30_000 }, async (t) => {
  const { page, context, baseUrl } = await fixture(t);
  const hostile = '<img src=x onerror="window.rateXss=true">';
  context.items[0].groupName = hostile;
  context.items[0].siteName = '<svg onload="window.rateXss=true">';
  context.items[1].oldMultiplier = 0;
  context.items[1].rawOldMultiplier = 0;
  await page.goto(`${baseUrl}/sites`, { waitUntil: 'networkidle' });
  const cards = await page.locator('#fleet-summary > article:visible').evaluateAll((nodes) => nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
  assert.equal(cards.length, 3);
  for (const card of cards) { assert.equal(card.height, 144); assert.ok(Math.abs(card.width - cards[0].width) < 1); }
  assert.match(await page.locator('.rate-card-heading').innerText(), /最近24小时/);
  assert.equal(await page.locator('.topbar').count(), 0);
  assert.equal(await page.locator('#sites-panel .panel-actions #open-site-modal').isVisible(), true);
  for (const id of ['open-site-modal', 'refresh-sites-table', 'refresh-sites']) {
    assert.equal(await page.locator(`#${id}`).evaluate((node) => getComputedStyle(node).whiteSpace), 'nowrap');
  }
  const scroll = page.locator('#rate-change-dashboard');
  assert.equal(await scroll.locator('.rate-event').count(), 50);
  assert.equal(await scroll.locator('img, svg').count(), 0);
  assert.equal(await page.evaluate(() => window.rateXss), undefined);
  assert.match(await scroll.innerText(), /0\.273000000001×/);
  assert.match(await scroll.innerText(), /零基数 · 涨幅不适用/);
  assert.doesNotMatch(await scroll.innerText(), /Infinity|新增/);
  assert.ok(await scroll.evaluate((node) => node.scrollHeight > node.clientHeight));
  assert.ok(await scroll.locator('time').first().getAttribute('title'));
  assert.ok(await scroll.locator('.rate-up').count());
  assert.ok(await scroll.locator('.rate-down').count());
  await scroll.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll('#rate-change-dashboard .rate-event').length === 100);
  await scroll.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll('#rate-change-dashboard .rate-event').length === 125);
  assert.equal(context.queries[0].searchParams.get('window'), '24h');
  assert.equal(context.queries[0].searchParams.get('pageSize'), '50');
  assert.equal(context.queries[1].searchParams.get('asOf'), new Date(context.now).toISOString());
  assert.equal(context.queries[2].searchParams.get('page'), '3');
  await page.screenshot({ path: '/tmp/aum-rate-ui-fake-sites-desktop.png' });
  for (const width of [621, 920, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    const overflow = await page.locator('#rate-change-card').evaluate((node) => node.scrollWidth - node.clientWidth);
    assert.ok(overflow <= 1, `rate card overflow at ${width}px: ${overflow}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.locator('#rate-change-card a').click();
  await page.waitForURL('**/rate-changes');
  await loaded(page, 'history');
  assert.equal(context.queries.at(-1).searchParams.has('window'), false);
  assert.equal(await page.locator('#fleet-summary').isVisible(), false);
  assert.equal(await page.locator('#rate-changes-panel').isVisible(), true);
  await page.goBack();
  await page.waitForURL('**/sites');
  assert.equal(await page.locator('#rate-change-card').isVisible(), true);
  await page.goForward();
  await page.waitForURL('**/rate-changes');
  assert.equal(await page.locator('a[data-tab="rate-changes"]').getAttribute('aria-current'), 'page');
  await page.locator('a[data-tab="groups"]').click();
  const geometry = await page.evaluate(() => {
    const summary = document.getElementById('fleet-summary').getBoundingClientRect();
    const panel = document.getElementById('groups-panel').getBoundingClientRect();
    return { gap: panel.top - summary.bottom, height: summary.height };
  });
  assert.equal(geometry.gap, 18);
  assert.ok(geometry.height < 144);
  assert.equal(context.posts.length, 0);
  assert.deepEqual(context.errors, []);
});

test('direct history supports filters, locked pagination, refresh reset, back/forward and narrow screens', { timeout: 30_000 }, async (t) => {
  const { page, context, baseUrl } = await fixture(t);
  context.items.push(change(999, context.now, { changedAt: new Date(context.now - 2 * DAY_MS).toISOString(), groupName: '旧记录' }));
  await page.goto(`${baseUrl}/rate-changes`, { waitUntil: 'networkidle' });
  assert.match(await page.locator('#rate-change-page-info').innerText(), /共 126 条/);
  await page.locator('#rate-change-next').click();
  await loaded(page, 'history');
  assert.match(await page.locator('#rate-change-page-info').innerText(), /第 2 \/ 3 页/);
  assert.equal(context.queries.at(-1).searchParams.get('asOf'), new Date(context.now).toISOString());
  assert.equal(context.queries.at(-1).searchParams.get('snapshot'), '500');
  assert.equal(new URL(page.url()).searchParams.get('snapshot'), '500');
  await page.locator('#refresh-rate-changes').click();
  await loaded(page, 'history');
  assert.equal(context.queries.at(-1).searchParams.has('asOf'), false);
  assert.equal(context.queries.at(-1).searchParams.has('snapshot'), false);
  assert.equal(context.queries.at(-1).searchParams.get('page'), '1');
  await select(page, 'rate-filter-site', SITE_A);
  await loaded(page, 'history');
  assert.match(await page.locator('#rate-change-page-info').innerText(), /共 63 条/);
  await select(page, 'rate-filter-direction', 'down');
  await loaded(page, 'history');
  assert.match(await page.locator('#rate-change-history-status').innerText(), /暂无符合筛选条件/);
  await select(page, 'rate-filter-direction', 'up');
  await loaded(page, 'history');
  assert.equal(context.queries.at(-1).searchParams.get('direction'), 'up');
  assert.equal(context.queries.at(-1).searchParams.get('siteId'), SITE_A);
  await page.locator('#rate-filter-query').fill('分组 0');
  await page.waitForResponse((response) => new URL(response.url()).searchParams.get('q') === '分组 0');
  await loaded(page, 'history');
  assert.equal(await page.locator('#rate-change-history-list .rate-history-row').count(), 1);
  await page.goBack();
  await loaded(page, 'history');
  assert.equal(await page.locator('#rate-filter-query').inputValue(), '');
  await page.goForward();
  await loaded(page, 'history');
  assert.equal(await page.locator('#rate-filter-query').inputValue(), '分组 0');
  await page.goto(`${baseUrl}/rate-changes?q=${encodeURIComponent('旧记录')}`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#rate-change-history-list .rate-history-row').count(), 1);
  assert.ok(await page.locator('#rate-change-history-list time').innerText());
  await select(page, 'rate-filter-window', '24h');
  await loaded(page, 'history');
  assert.equal(await page.locator('#rate-change-history-list .rate-history-row').count(), 0);
  assert.equal(context.queries.at(-1).searchParams.get('window'), '24h');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#rate-filter-window').inputValue(), '24h');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => {
    const panel = document.getElementById('rate-changes-panel').getBoundingClientRect();
    return { left: panel.left, right: panel.right, width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  });
  assert.ok(mobile.left >= 0 && mobile.right <= mobile.width);
  assert.equal(mobile.scrollWidth, mobile.width);
  await page.locator('#rate-changes-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/aum-rate-ui-fake-history-mobile.png', fullPage: true });
  assert.equal(context.posts.length, 0);
  assert.deepEqual(context.errors, []);
});

test('history loading/error/retry and concurrent filters keep stale responses out', { timeout: 30_000 }, async (t) => {
  const { page, context, baseUrl } = await fixture(t, { count: 5 });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  context.listHook = () => held;
  await page.goto(`${baseUrl}/rate-changes`, { waitUntil: 'domcontentloaded' });
  await page.locator('#rate-change-history-status').getByText('正在读取倍率变更…').waitFor();
  context.failRates = true;
  context.listHook = null;
  release();
  await page.locator('#rate-change-history-status').getByText('重试', { exact: true }).waitFor();
  assert.match(await page.locator('#rate-change-history-status').innerText(), /读取倍率变更失败/);
  assert.equal(await page.locator('#rate-change-prev').isDisabled(), true);
  context.failRates = false;
  await page.locator('#rate-change-history-status button').click();
  await loaded(page, 'history');
  assert.equal(await page.locator('#rate-change-history-list .rate-history-row').count(), 5);
  const pendingResponses = [];
  // 旧请求即使忽略客户端取消仍返回；最终页面只接受新筛选。
  context.listHook = (options) => options.q === '分组 1' ? new Promise((resolve) => pendingResponses.push(resolve)) : null;
  await page.locator('#rate-filter-query').fill('分组 1');
  await page.waitForRequest((request) => new URL(request.url()).searchParams.get('q') === '分组 1');
  await page.locator('#rate-filter-query').fill('分组 2');
  await page.waitForResponse((response) => new URL(response.url()).searchParams.get('q') === '分组 2');
  await loaded(page, 'history');
  for (const done of pendingResponses) done();
  await page.waitForFunction(() => document.querySelector('#rate-change-history-list .rate-history-group')?.textContent === '分组 2');
  assert.equal(await page.locator('#rate-change-history-list .rate-history-row').count(), 1);
  assert.deepEqual(context.errors, []);
});

test('polling is 45s, pauses hidden/off-route and foreground refresh drops expired records even on errors', { timeout: 30_000 }, async (t) => {
  const { page, context, baseUrl } = await fixture(t, { count: 2, setupPage: async (page) => {
    await page.addInitScript(() => {
      const intervals = new Map();
      const nativeSet = window.setInterval.bind(window);
      const nativeClear = window.clearInterval.bind(window);
      let counter = 900_000;
      window.rateHidden = false;
      Object.defineProperty(document, 'hidden', { get: () => window.rateHidden, configurable: true });
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 45_000) { const id = ++counter; intervals.set(id, callback); return id; }
        return nativeSet(callback, delay, ...args);
      };
      window.clearInterval = (id) => { if (intervals.has(id)) intervals.delete(id); else nativeClear(id); };
      window.rateTimers = intervals;
    });
  } });
  context.items[0].changedAt = new Date(context.now - DAY_MS + 1000).toISOString();
  await page.goto(`${baseUrl}/sites`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#rate-change-dashboard .rate-event').count(), 2);
  assert.equal(await page.evaluate(() => window.rateTimers.size), 1);
  const initial = context.queries.length;
  await page.evaluate(() => { window.rateHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await page.evaluate(() => window.rateTimers.size), 0);
  assert.equal(context.queries.length, initial);
  context.now += 2000;
  await page.evaluate(() => { window.rateHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await loaded(page);
  assert.equal(await page.locator('#rate-change-dashboard .rate-event').count(), 1);
  context.failRates = true;
  await page.evaluate(() => { for (const callback of window.rateTimers.values()) callback(); });
  await page.locator('#rate-change-dashboard-status button').waitFor();
  assert.equal(await page.locator('#rate-change-dashboard .rate-event').count(), 0);
  context.failRates = false;
  await page.locator('#rate-change-dashboard-status button').click();
  await loaded(page);
  assert.equal(await page.locator('#rate-change-dashboard .rate-event').count(), 1);
  await page.locator('a[data-tab="groups"]').click();
  assert.equal(await page.evaluate(() => window.rateTimers.size), 0);
  context.now += DAY_MS;
  await page.locator('a[data-tab="sites"]').click();
  await loaded(page);
  assert.match(await page.locator('#rate-change-dashboard-status').innerText(), /最近24小时暂无倍率变更/);
  assert.equal(await page.locator('#rate-change-dashboard .rate-event').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#rate-change-card').scrollIntoViewIfNeeded();
  const card = await page.locator('#rate-change-card').boundingBox();
  assert.ok(card.x >= 0 && card.x + card.width <= 390);
  await page.screenshot({ path: '/tmp/aum-rate-ui-fake-sites-mobile.png', fullPage: true });
  assert.equal(context.posts.length, 0);
  assert.deepEqual(context.errors, []);
});

test('table refresh and sync reload records without turning history errors into sync failures', { timeout: 30_000 }, async (t) => {
  const { page, context, baseUrl } = await fixture(t, { count: 1 });
  await page.goto(`${baseUrl}/sites`, { waitUntil: 'networkidle' });
  const initial = context.queries.length;
  context.items.unshift(change(5, context.now));
  await page.locator('#refresh-sites-table').click();
  await page.waitForFunction(() => !document.getElementById('refresh-sites-table').disabled);
  await loaded(page);
  assert.equal(await page.locator('#rate-change-dashboard .rate-event').count(), 2);
  assert.ok(context.queries.length > initial);
  assert.equal(context.posts.length, 0);
  context.failRates = true;
  await page.locator('#refresh-sites').click();
  await page.waitForFunction(() => !document.getElementById('refresh-sites').disabled);
  await page.locator('#rate-change-dashboard-status button').waitFor();
  assert.equal(await page.locator('#toast-region').getByText('同步完成', { exact: true }).count(), 1);
  assert.equal(await page.locator('#toast-region').getByText('同步失败', { exact: true }).count(), 0);
  assert.equal(context.posts.filter((request) => request.path.endsWith('/snapshot/refresh')).length, 2);
  // 即使旧快照 reload 失败，已成功同步落库的倍率事件仍需独立重读。
  context.failRates = false;
  context.failSnapshots = true;
  context.items.unshift(change(8, context.now));
  await page.locator('#sites-table [data-action="refresh"]').first().click();
  await page.waitForFunction(() => !document.getElementById('refresh-sites').disabled);
  await loaded(page);
  assert.equal(await page.locator('#rate-change-dashboard .rate-event').count(), 3);
  assert.equal(await page.locator('#toast-region').getByText('同步失败', { exact: true }).count(), 1);
  assert.deepEqual(context.errors, []);
});

const headerOrder = (page) => page.locator('#rate-change-history-head th').evaluateAll((nodes) => nodes.map((node) => node.dataset.column));
const waitSaved = (page) => page.locator('#rate-column-status').getByText('列顺序已保存到数据库', { exact: true }).waitFor();

test('six-column history highlights platform, site identity and rate changes without unsafe links or lost timestamps', { timeout: 30_000 }, async (t) => {
  const { page, context, baseUrl } = await fixture(t, { count: 5, setupPage: async (page) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) { window.copiedRateUrl = value; } } }); });
  } });
  Object.assign(context.items[0], { groupName: 'Claude 长分组名（含备注、限速与计费说明）'.repeat(3), platform: 'anthropic', siteName: '星河 API', oldMultiplier: .06, newMultiplier: .1, rawOldMultiplier: .06, rawNewMultiplier: .1 });
  Object.assign(context.items[1], { platform: 'grok' });
  Object.assign(context.items[2], { platform: 'gemini', siteUrl: '', siteName: '已删除的历史站点' });
  Object.assign(context.items[3], { platform: '<img src=x onerror="window.rateXss=true">', siteUrl: 'javascript:window.rateXss=true', groupName: '<svg onload="window.rateXss=true">' });
  Object.assign(context.items[4], { platform: 'openai', siteUrl: 'https://user:pass@private.invalid/path?token=private' });
  await page.goto(`${baseUrl}/rate-changes`, { waitUntil: 'networkidle' });
  assert.deepEqual(await headerOrder(page), ['platform', 'group', 'site', 'change', 'old', 'new']);
  const row = page.locator('#rate-change-history-list tr').first();
  assert.equal(await row.locator('td').count(), 6);
  assert.equal(await row.locator('[data-column=platform]').innerText(), 'Anthropic');
  assert.match(await row.locator('[data-column=group]').innerText(), /分钟前/);
  assert.match(await row.locator('[data-column=change]').innerText(), /↑ 上涨 66.67%/);
  assert.equal(await row.locator('[data-column=old]').innerText(), '0.06×');
  assert.equal(await row.locator('[data-column=new]').innerText(), '0.1×');
  assert.equal(await row.locator('[data-column=site] strong').innerText(), '星河 API');
  assert.equal(await row.locator('a').getAttribute('href'), sites[0].url);
  assert.equal(await row.locator('a').getAttribute('rel'), 'noopener noreferrer');
  await row.locator('[data-action=copy-site-url]').click();
  assert.equal(await page.evaluate(() => window.copiedRateUrl), sites[0].url);
  assert.match(await page.locator('#toast-region').innerText(), /链接已复制/);
  const deleted = page.locator('#rate-change-history-list tr').nth(2);
  assert.match(await deleted.innerText(), /链接不可用/); assert.equal(await deleted.locator('a,button').count(), 0);
  assert.equal(await page.locator('#rate-change-history-table img').count(), 0);
  assert.equal(await page.locator('#rate-change-history-table a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.rateXss), undefined);
  assert.match(await page.locator('#rate-change-history-list tr').nth(3).innerText(), /未识别/);
  assert.equal(await page.locator('#rate-change-history-list tr').nth(4).locator('a').count(), 0);
  for (const width of [1920, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.locator('#rate-change-history-table').evaluate((table) => ({
      head: [...table.querySelectorAll('th')].map((el) => ({ x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width })),
      body: [...table.querySelector('tbody tr').children].map((el) => ({ x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width })),
      documentWidth: document.documentElement.scrollWidth,
    }));
    assert.deepEqual(geometry.head, geometry.body); assert.equal(geometry.documentWidth, width);
    await page.screenshot({ path: `/tmp/aum-columns-validation/history-${width}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.equal(await page.locator('#rate-change-history-scroll').evaluate((el) => el.scrollWidth > el.clientWidth), true);
  await page.locator('#rate-change-history-scroll').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.locator('#rate-changes-panel').screenshot({ path: '/tmp/aum-columns-validation/history-mobile.png' });
  assert.equal(context.posts.length, 0);
  assert.deepEqual(context.errors, []);
});

test('column read/save failures remain explicit and retry never resets another preference', { timeout: 30_000 }, async (t) => {
  const { page, context, baseUrl } = await fixture(t, { count: 2 });
  context.failPreferenceLoad = true;
  context.preferences.set('group-management', { groupPlatformFilter: 'anthropic' });
  await page.goto(`${baseUrl}/rate-changes`, { waitUntil: 'networkidle' });
  assert.match(await page.locator('#rate-column-status').innerText(), /读取失败/);
  assert.equal(await page.locator('.rate-column-handle:disabled').count(), 6);
  assert.equal(await page.locator('#rate-change-history-list tr').count(), 2);
  assert.equal(context.posts.length, 0);
  context.failPreferenceLoad = false;
  await page.locator('#rate-column-retry').click();
  await page.waitForFunction(() => !document.querySelector('.rate-column-handle').disabled);
  context.failPreferenceSave = true;
  await page.getByRole('button', { name: '左移站点', exact: true }).click();
  await page.locator('#rate-column-status').getByText('列顺序未保存，点击重试').waitFor();
  assert.deepEqual(await headerOrder(page), ['platform', 'site', 'group', 'change', 'old', 'new']);
  assert.equal(context.preferences.has('rate-change-history'), false);
  context.failPreferenceSave = false;
  await page.locator('#rate-column-retry').click(); await waitSaved(page);
  assert.deepEqual(context.preferences.get('rate-change-history').columnOrder, await headerOrder(page));
  assert.deepEqual(context.preferences.get('group-management'), { groupPlatformFilter: 'anthropic' });
  await page.reload({ waitUntil: 'networkidle' });
  assert.deepEqual(await headerOrder(page), ['platform', 'site', 'group', 'change', 'old', 'new']);
  assert.deepEqual(context.errors, []);
});

test('drag, keyboard and touch buttons persist order through PostgreSQL and a fresh browser context', { skip: !process.env.GROUP_RATE_TEST_DATABASE_URL, timeout: 30_000 }, async (t) => {
  const { Pool } = await import('pg');
  const { randomUUID } = await import('node:crypto');
  const { createUiPreferencesRepository } = await import('../src/db.mjs');
  const schema = `rate_browser_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.GROUP_RATE_TEST_DATABASE_URL });
  await admin.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString: process.env.GROUP_RATE_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const repository = createUiPreferencesRepository(pool);
  await pool.query('create table ui_preferences (preference_key text primary key, preferences jsonb not null, updated_at timestamptz not null default now())');
  const { page, context, baseUrl } = await fixture(t, { count: 3, preferenceRepository: repository });
  t.after(async () => { await pool.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
  await page.goto(`${baseUrl}/rate-changes`, { waitUntil: 'networkidle' });
  const source = page.locator('th[data-column=site] .rate-column-handle');
  const target = page.locator('th[data-column=platform]');
  await source.dragTo(target); await waitSaved(page);
  assert.deepEqual(await headerOrder(page), ['site', 'platform', 'group', 'change', 'old', 'new']);
  await page.locator('th[data-column=new] .rate-column-handle').focus();
  await page.keyboard.press('Alt+ArrowLeft'); await waitSaved(page);
  assert.deepEqual(await headerOrder(page), ['site', 'platform', 'group', 'change', 'new', 'old']);
  assert.equal(await page.evaluate(() => document.activeElement.closest('th').dataset.column), 'new');
  await page.getByRole('button', { name: '右移模型平台', exact: true }).click(); await waitSaved(page);
  const finalOrder = ['site', 'group', 'platform', 'change', 'new', 'old'];
  assert.deepEqual(await headerOrder(page), finalOrder);
  const saved = (await pool.query('select preferences from ui_preferences where preference_key=$1', ['rate-change-history'])).rows[0].preferences;
  assert.deepEqual(saved, { columnOrder: finalOrder });
  assert.deepEqual(await page.locator('#rate-change-history-list tr').first().locator('td').evaluateAll((nodes) => nodes.map((n) => n.dataset.column)), finalOrder);
  await page.reload({ waitUntil: 'networkidle' }); assert.deepEqual(await headerOrder(page), finalOrder);
  const fresh = await page.context().browser().newContext();
  try {
    const freshPage = await fresh.newPage();
    await freshPage.goto(`${baseUrl}/rate-changes`, { waitUntil: 'networkidle' });
    assert.deepEqual(await headerOrder(freshPage), finalOrder);
  } finally { await fresh.close(); }
  await page.locator('a[data-tab="sites"]').click();
  const external = ['old', 'new', 'change', 'platform', 'site', 'group'];
  await repository.upsertPreference('rate-change-history', { columnOrder: external });
  await page.locator('a[data-tab="rate-changes"]').click();
  await page.waitForFunction((order) => [...document.querySelectorAll('#rate-change-history-head th')].map(x => x.dataset.column).join('|') === order.join('|'), external);
  assert.deepEqual(await headerOrder(page), external);
  const refreshed = ['group', 'site', 'platform', 'old', 'new', 'change'];
  await repository.upsertPreference('rate-change-history', { columnOrder: refreshed });
  await page.locator('#refresh-rate-changes').click();
  await page.waitForFunction((order) => [...document.querySelectorAll('#rate-change-history-head th')].map(x => x.dataset.column).join('|') === order.join('|'), refreshed);
  assert.deepEqual(await headerOrder(page), refreshed);
  assert.ok(context.posts.every((p) => p.path === '/api/ui-preferences/rate-change-history'));
  assert.deepEqual(context.errors, []);
});
