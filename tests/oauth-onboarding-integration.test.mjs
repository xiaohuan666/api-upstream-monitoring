import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { defaultImportOptions } from '../src/oauth-import-options.mjs';
import { createRequestHandler } from '../src/http.mjs';

// Full SPA integration: unlike the view's isolated tests, exercise the real navigation and HTTP router.
test('OAuth page survives direct navigation, reload and SPA leave/reenter without retained secrets', { timeout: 30_000 }, async (t) => {
  const target = '11111111-1111-4111-8111-111111111111';
  const jobs = [];
  const batches = new Map();
  let preferences = { groupIds: [], importOptions: defaultImportOptions() };
  const errors = [];
  const handler = createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: { async listSites() { return []; } }, proxyRepository: { async listProxies() { return []; } },
    groupModelSettingsRepository: { async listBySiteIds() { return []; } },
    snapshotService: { async getLatestSnapshot() { return null; } },
    uiPreferencesRepository: {
      async getPreference() { return { preferences: {} }; },
      async getAutoRefreshSettings() { return { preferences: { enabled: false, intervalValue: 10, intervalUnit: 'minutes', rules: [] } }; },
    },
    oauthOnboarding: {
      async options() { return { mySites: [{ id: target, name: '离线目标' }], proxies: [] }; },
      async groups() { return [{ id: 1, name: 'Codex 普通组', platform: 'openai', status: 'active' }, { id: 2, name: 'Codex 备用组', platform: 'openai', status: 'active' }]; },
      async list() { return jobs; },
      async listPage() { return { jobs, nextCursor: null }; },
      async listBatches() {
        return { batches: [...batches.values()].map(({ jobs, ...batch }) => batch), nextCursor: null };
      },
      async preferences() { return { preferences, capabilities: { atomicSchedulable: true, atomicProtection: true } }; },
      async submitBatch(body) {
        assert.equal(body.mySiteId, target);
        assert.deepEqual(body.groupIds, [1, 2]);
        assert.equal(body.proxyId, null);
        assert.equal(body.accounts.length, 2);
        assert.equal(body.accounts[0].password, 'offline-password');
        assert.deepEqual(body.importOptions, defaultImportOptions());
        const batchJobs = body.accounts.map((account, index) => ({ id: `${body.requestId}-${index}`, mySiteId: target, email: account.email, groupIds: body.groupIds, proxyId: null,
          status: 'succeeded', stage: 'done', message: '已完成离线模拟', remoteAccountId: 91, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
        const batch = { id: body.requestId, createdAt: new Date().toISOString(), total: batchJobs.length, matchedCount: batchJobs.length, statusCounts: { succeeded: batchJobs.length }, canRerun: false, legacy: false, jobs: batchJobs };
        batches.set(batch.id, batch);
        preferences = { groupIds: body.groupIds, importOptions: body.importOptions };
        jobs.push(...batchJobs); return batch;
      },
      async getBatch(id) { return batches.get(id); },
      async get(id) { return jobs.find((job) => job.id === id); },
    },
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
  page.setDefaultTimeout(5000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/oauth-accounts`, { waitUntil: 'networkidle' });
  const panel = page.locator('#oauth-accounts-panel');
  assert.equal(await panel.locator('[data-role="site-field"]').isVisible(), false);
  assert.equal(await panel.locator('[name="mySiteId"]').inputValue(), target);
  await panel.locator('[data-role="groups"] input').first().waitFor();
  const credentials = 'offline@example.test|offline-password|GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\nsecond@example.test|another-password|GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  await panel.locator('[data-role="credential-line"]').fill(credentials);
  await panel.locator('[data-role="parse-credentials"]').click();
  assert.equal(await panel.locator('[data-role="credential-message"]').innerText(), '解析成功 2 · 失败 0');
  await page.locator('[data-route-link][data-tab="sites"]').click();
  assert.equal(await panel.locator('[data-role="credential-line"]').inputValue(), '');
  assert.equal(await panel.locator('[data-role="credential-message"]').innerText(), '');
  await page.locator('[data-route-link][data-tab="oauth-accounts"]').click();
  await panel.locator('[data-role="groups"] input').first().waitFor();
  assert.equal(await panel.locator('[data-role="submit"]').isDisabled(), true, '离开 SPA 后解析数组必须清空');
  await panel.locator('[data-role="credential-line"]').fill(credentials);
  await panel.locator('[data-role="parse-credentials"]').click();
  for (const checkbox of await panel.locator('[data-role="groups"] input').all()) await checkbox.check();
  await panel.locator('[data-role="submit"]').click();
  await page.waitForURL((url) => url.pathname === '/oauth-tasks' && url.searchParams.has('batch'));
  assert.equal(await panel.locator('[data-role="credential-line"]').inputValue(), '');
  assert.equal(jobs.length, 2);
  assert.equal(await panel.locator('[data-role="current"]').count(), 0, '导入页不保留任务历史或进度');
  const batchId = [...batches.keys()][0];
  assert.equal(new URL(page.url()).searchParams.get('batch'), batchId);
  const taskPanel = page.locator('#oauth-tasks-panel');
  const taskBatch = taskPanel.locator(`[data-batch-id="${batchId}"]`);
  await taskBatch.getByText('远端账号 ID：91', { exact: true }).first().waitFor();
  assert.equal(await taskBatch.getByText('远端账号 ID：91', { exact: true }).count(), 2);
  assert.equal(await taskBatch.locator('.oauth-job').count(), 2);
  assert.match(await taskBatch.innerText(), /offline@example.test/);
  assert.match(await taskBatch.innerText(), /second@example.test/);
  assert.equal(new URL(page.url()).pathname, '/oauth-tasks');
  assert.equal(new URL(page.url()).searchParams.get('batch'), batchId);
  await page.reload({ waitUntil: 'networkidle' });
  await taskBatch.getByText('远端账号 ID：91', { exact: true }).first().waitFor();
  assert.equal(await taskBatch.getByText('远端账号 ID：91', { exact: true }).count(), 2, '重载独立任务页仍可定位完整批次及远端结果');
  await page.locator('[data-route-link][data-tab="oauth-accounts"]').click();
  assert.equal(await panel.locator('[data-role="site-field"]').isVisible(), false);
  assert.equal(await panel.locator('[name="mySiteId"]').inputValue(), target);
  await page.waitForFunction(() => document.querySelectorAll('[data-role="groups"] input:checked').length === 2);
  assert.equal(await panel.locator('[data-role="submit"]').isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  assert.deepEqual(errors, []);
});
