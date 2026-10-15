import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createRequestHandler } from '../src/http.mjs';

test('site form saves hourly ETA threshold and the site list updates its alert', { timeout: 90_000 }, async (t) => {
  let site = {
    id: 'site-1', name: '预警测试', type: 'sub2api', url: 'https://example.test', authToken: 'mock-token',
    baseUrl: 'https://example.test', balanceAlert: 0, depletionAlertHours: 1,
  };
  const snapshot = {
    siteId: site.id, balanceAmount: 30, balanceCurrency: 'CNY',
    refreshedAt: '2026-09-24T01:00:00.000Z',
    previousBalance: { amount: 90, currency: 'CNY', refreshedAt: '2026-09-24T00:00:00.000Z' },
    groups: [], probe: { ok: true, latencyMs: 20, status: 'healthy', checkedAt: '2026-09-24T01:00:00.000Z' },
  };
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: {
      async listSites() { return [site]; },
      async getSiteById(id) { return id === site.id ? site : null; },
      async updateSite(id, input) {
        site = { ...site, depletionAlertHours: Number(input.depletion_alert_hours) };
        return site;
      },
    },
    groupModelSettingsRepository: { async listBySiteIds() { return []; } },
    proxyRepository: { async listProxies() { return []; } },
    uiPreferencesRepository: {
      async getPreference(preferenceKey) { return { preferenceKey, preferences: {}, updatedAt: null }; },
      async getAutoRefreshSettings() { return { preferenceKey: 'auto-refresh', preferences: { enabled: false, intervalValue: 10, intervalUnit: 'minutes' }, updatedAt: null }; },
    },
    snapshotService: { async getLatestSnapshot() { return snapshot; } },
  }));
  let browser;
  t.after(async () => {
    try { await browser?.close(); } finally {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/sites`, { waitUntil: 'networkidle' });
  const row = page.locator('#sites-table tr').filter({ hasText: site.name });
  const eta = row.locator('.time-line').first();
  await row.getByText('30分钟').waitFor({ timeout: 5000 });
  assert.equal(await eta.evaluate((element) => element.classList.contains('depletion-alert')), true);
  await row.locator('[data-action="edit"]').click({ timeout: 5000 });
  const threshold = page.locator('#site-form [name="depletion_alert_hours"]');
  assert.equal(await threshold.inputValue(), '1');
  await threshold.fill('0.25');
  await page.locator('#site-modal-submit').click({ timeout: 5000 });
  await page.waitForFunction(() => !document.querySelector('#site-modal').open);
  await page.waitForFunction(() => !document.querySelector('#sites-table .depletion-alert'));
  assert.equal(site.depletionAlertHours, 0.25);
  assert.equal(await eta.textContent(), '30分钟');
  await page.locator('#open-site-modal').click();
  assert.equal(await threshold.inputValue(), '1');
});
