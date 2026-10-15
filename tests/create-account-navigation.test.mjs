import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { chromium } from 'playwright';

import { createRequestHandler } from '../src/http.mjs';

const site = { id: 'upstream', name: '本地模拟上游', type: 'sub2api', url: 'https://upstream.example.test' };
const upstreamGroup = { id: 'upstream-group', name: '上游分组', platform: 'openai', multiplier: 1, enabled: true };
const mySites = ['A', 'B'].map((id) => ({ id, name: `我的站点${id}`, type: 'sub2api', url: `https://${id.toLowerCase()}.example.test` }));
const groupA = { id: 'group-A', name: 'A分组', platform: 'openai', rateMultiplier: 1 };
const groupB = { id: 'group-B', name: 'B分组', platform: 'anthropic', rateMultiplier: 2 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function fixture(t, { accounts = [] } = {}) {
  const requests = [];
  let deferGroupRequests = false;
  const arrivals = [];
  const submissions = [];
  const pageErrors = [];
  const externalRequests = [];
  const snapshot = {
    siteId: site.id, groups: [upstreamGroup], tokens: [{ key: 'offline-test-key', groupId: upstreamGroup.id }],
    balanceAmount: 20, balanceCurrency: 'USD', refreshedAt: '2026-10-15T00:00:00.000Z',
    probe: { ok: true, latencyMs: 20, status: 'healthy', checkedAt: '2026-10-15T00:00:00.000Z' },
  };
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: {
      async listSites() { return [site]; },
      async getSiteById(id) { return id === site.id ? site : null; },
    },
    snapshotService: { async getLatestSnapshot() { return snapshot; } },
    groupModelSettingsRepository: { async listBySiteIds() { return []; } },
    proxyRepository: { async listProxies() { return []; } },
    uiPreferencesRepository: {
      async getPreference(preferenceKey) { return { preferenceKey, preferences: {}, updatedAt: null }; },
      async getAutoRefreshSettings() { return { preferences: { enabled: false } }; },
    },
    mySites: {
      repository: { async listMySites() { return mySites; } },
      accountRepository: { async listAccounts() { return accounts; } },
      proxyService: { async listProxyLinks() { return []; } },
      service: {
        async listLinkedAccountsRemote() { return []; },
        async listRemoteGroups(mySiteId) {
          if (!deferGroupRequests) return [];
          const request = { mySiteId, ...deferred() };
          const index = requests.push(request) - 1;
          arrivals[index]?.resolve(request);
          return request.promise;
        },
        async createAccountLink(input) {
          submissions.push(input);
          return { id: `account-${submissions.length}`, ...input };
        },
      },
    },
  }));
  let browser;
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      for (const request of requests) request.resolve([]);
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, [], 'all requests must stay on the local mock server');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto(`${base}/groups`, { waitUntil: 'networkidle' });
  deferGroupRequests = true;
  const open = () => page.locator('[data-action="open-create-account"]').click();
  const submit = page.locator('#create-account-submit');
  const siteSelect = page.locator('#create-account-my-site');
  const groupSelect = page.locator('#create-account-my-group');
  const modal = page.locator('#create-account-modal');
  const requestAt = async (index, mySiteId) => {
    arrivals[index] ??= deferred();
    const request = requests[index] ?? await arrivals[index].promise;
    assert.equal(request.mySiteId, mySiteId);
    return request;
  };
  const settle = async (request, groups, error = null) => {
    const received = page.waitForResponse((response) => (
      new URL(response.url()).pathname === `/api/my-sites/${request.mySiteId}/groups`
    ));
    if (error) request.reject(new Error(error));
    else request.resolve(groups);
    const response = await received;
    assert.equal(response.status(), error ? 502 : 200);
    await response.finished();
    // 等浏览器消费响应并完成渲染，再检查迟到响应是否污染界面。
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const assertGroup = async (group) => {
    assert.equal(await groupSelect.inputValue(), group.id);
    assert.deepEqual(await groupSelect.locator('option').evaluateAll((options) => options.map((option) => option.value)), [group.id]);
    assert.equal(await submit.isEnabled(), true);
    assert.equal(await page.locator('#create-account-responses-field').isVisible(), group.platform === 'openai');
  };
  const forceSubmit = () => page.locator('#create-account-form').dispatchEvent('submit');
  return { page, open, submit, siteSelect, groupSelect, modal, requestAt, settle, assertGroup, forceSubmit, submissions };
}

test('late A success cannot overwrite B groups or submit a B site with an A group', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.open();
  const a = await f.requestAt(0, 'A');
  assert.equal(await f.submit.isDisabled(), true);
  await f.forceSubmit();
  assert.deepEqual(f.submissions, []);
  await f.siteSelect.selectOption('B');
  const b = await f.requestAt(1, 'B');
  assert.equal(await f.submit.isDisabled(), true);
  await f.settle(b, [groupB]);
  await f.assertGroup(groupB);
  await f.settle(a, [groupA]);
  await f.assertGroup(groupB);
  const posted = f.page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/my-site-accounts');
  await f.submit.click();
  assert.equal((await posted).status(), 201);
  await f.modal.waitFor({ state: 'hidden' });
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.submissions[0], {
    mySiteId: 'B', myGroupId: groupB.id, upstreamSiteId: site.id, upstreamGroupId: upstreamGroup.id,
    poolMode: true, poolModeRetryCount: 3, responsesMode: null,
    excludedModels: ['gpt-5.6-luna', 'gpt-image-1', 'gpt-image-2', 'gpt-image-1.5'],
  });
});

test('late A error leaves ready B groups and does not show an obsolete error', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.open();
  const a = await f.requestAt(0, 'A');
  await f.siteSelect.selectOption('B');
  const b = await f.requestAt(1, 'B');
  await f.settle(b, [groupB]);
  await f.settle(a, null, 'obsolete A failure');
  await f.assertGroup(groupB);
  assert.equal(await f.page.locator('#toast-region').getByText('读取我的站点分组失败', { exact: true }).count(), 0);
});

test('A to B to A accepts only the latest A request generation', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.open();
  const oldA = await f.requestAt(0, 'A');
  await f.siteSelect.selectOption('B');
  const b = await f.requestAt(1, 'B');
  await f.siteSelect.selectOption('A');
  const newA = await f.requestAt(2, 'A');
  const currentGroup = { ...groupA, id: 'new-A', name: 'A最新分组' };
  await f.settle(newA, [currentGroup]);
  await f.settle(oldA, [groupA]);
  await f.settle(b, [groupB]);
  await f.assertGroup(currentGroup);
});

for (const lateError of [false, true]) {
  test(`closing and reopening the same upstream ignores old session ${lateError ? 'errors' : 'groups'}`, { timeout: 30_000 }, async (t) => {
    const f = await fixture(t);
    await f.open();
    const oldA = await f.requestAt(0, 'A');
    if (lateError) await f.page.keyboard.press('Escape');
    else await f.page.locator('[data-close-create-account-modal]').first().click();
    await f.modal.waitFor({ state: 'hidden' });
    await f.open();
    const newA = await f.requestAt(1, 'A');
    await f.settle(oldA, [groupA], lateError ? 'closed session failure' : null);
    assert.equal(await f.submit.isDisabled(), true);
    assert.equal(await f.groupSelect.inputValue(), '');
    assert.equal(await f.page.locator('#toast-region').getByText('读取我的站点分组失败', { exact: true }).count(), 0);
    const currentGroup = { ...groupA, id: 'reopened-A', name: '重开后分组' };
    await f.settle(newA, [currentGroup]);
    await f.assertGroup(currentGroup);
  });
}

test('current failure and loading block submission until another site loads successfully', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.open();
  const a = await f.requestAt(0, 'A');
  await f.settle(a, null, 'current A failure');
  assert.equal(await f.submit.isDisabled(), true);
  await f.page.locator('#toast-region').getByText('current A failure', { exact: true }).waitFor();
  await f.forceSubmit();
  assert.deepEqual(f.submissions, []);
  await f.siteSelect.selectOption('B');
  const b = await f.requestAt(1, 'B');
  await f.forceSubmit();
  assert.deepEqual(f.submissions, []);
  await f.settle(b, [groupB]);
  await f.assertGroup(groupB);
});

test('submit validates selected group membership even for a dispatched submit event', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.open();
  await f.settle(await f.requestAt(0, 'A'), [groupA]);
  await f.assertGroup(groupA);
  await f.groupSelect.evaluate((select) => {
    select.add(new Option('foreign B group', 'group-B'));
    select.value = 'group-B';
  });
  await f.forceSubmit();
  assert.deepEqual(f.submissions, []);
  // 不派发 change，验证提交入口本身也拒绝站点与已加载分组来源不一致。
  await f.groupSelect.selectOption(groupA.id);
  await f.siteSelect.evaluate((select) => { select.value = 'B'; });
  await f.forceSubmit();
  assert.deepEqual(f.submissions, []);
});

test('empty groups and groups already linked to this upstream keep submission disabled', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t, { accounts: [{
    id: 'existing', mySiteId: 'B', myGroupId: groupB.id,
    upstreamSiteId: site.id, upstreamGroupId: upstreamGroup.id,
  }] });
  await f.open();
  await f.settle(await f.requestAt(0, 'A'), []);
  assert.equal(await f.submit.isDisabled(), true);
  await f.forceSubmit();
  await f.siteSelect.selectOption('B');
  await f.settle(await f.requestAt(1, 'B'), [groupB]);
  assert.equal(await f.submit.isDisabled(), true);
  await f.forceSubmit();
  assert.deepEqual(f.submissions, []);
});
