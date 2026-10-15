import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createRequestHandler } from '../src/http.mjs';

const payload = (concurrency = 5) => ({ settings: { concurrency }, limits: { min: 1, max: 20 } });
const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
const input = (page) => page.locator('#oauth-settings-concurrency');
const save = (page) => page.locator('#settings-oauth-onboarding-panel [type="submit"]');
const reload = (page) => page.locator('[data-oauth-settings-reload]');
const message = (page) => page.locator('#oauth-settings-status');
const waitValue = (page, value) => page.waitForFunction((expected) => document.querySelector('#oauth-settings-concurrency')?.value === String(expected) && !document.querySelector('#oauth-settings-concurrency').disabled, value);

async function fixture(t, { width = 1440, spa = false, prefix = '', ignoreAbort = false, useBoundary = false, setup = () => {} } = {}) {
  const state = { concurrency: 5, requests: [], errors: [], external: [], onGet: null, onPut: null };
  setup(state);
  const validate = useBoundary ? (await import('../src/oauth-execution-settings.mjs')).validateOAuthExecutionSettings : null;
  const handler = createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: { async listSites() { return []; } },
    groupModelSettingsRepository: { async listBySiteIds() { return []; } },
    proxyRepository: { async listProxies() { return []; } },
    uiPreferencesRepository: {
      async getPreference(preferenceKey) { return { preferenceKey, preferences: {} }; },
      async getAutoRefreshSettings() { return { preferences: {} }; },
      async getPricingViewPreferences() { return { preferences: {} }; },
      async getMySitesViewPreferences() { return { preferences: {} }; },
    },
    ...(useBoundary ? { oauthOnboarding: {
      async getExecutionSettings() { return payload(state.concurrency); },
      async saveExecutionSettings(body) { state.concurrency = validate(body).concurrency; return payload(state.concurrency); },
    } } : {}),
  });
  const componentHtml = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/src/oauth-settings.css"></head>
    <body><main id="settings-oauth-onboarding-panel" class="panel-view" aria-labelledby="oauth-settings-heading"></main>
    <script type="module">
      import { mountOAuthSettings } from '/src/oauth-settings-view.mjs';
      window.observedSignals = []; window.fetchCalls = [];
      window.view = mountOAuthSettings(document.querySelector('main'), { fetchImpl: (path, init) => {
        window.observedSignals.push(init.signal);
        window.fetchCalls.push({ path, method: init.method, credentials: init.credentials, cache: init.cache });
        const { signal, ...rest } = init;
        return fetch(path, ${ignoreAbort} ? rest : init);
      }});
      window.ready = window.view.activate();
    </script></body></html>`;
  // 模拟现有 sub_filter 的路径前缀改写；运行真实 app.mjs，而非替代路由器。
  const rewrite = (text) => prefix ? text.replace(/(["'`])\/(api|src|styles\.css|settings|sites|groups|rate-changes|ip-management|oauth-accounts|oauth-tasks)(?=[/"'`?])/g, `$1${prefix}/$2`) : text;
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (prefix && !pathname.startsWith(`${prefix}/`)) return json(res, { error: '请求越出子路径' }, 404);
      if (prefix) req.url = req.url.slice(prefix.length);
      if (prefix) {
        const end = res.end.bind(res);
        const writeHead = res.writeHead.bind(res);
        let responseType = '';
        res.writeHead = (...args) => {
          const headers = args.find((arg) => arg && typeof arg === 'object');
          responseType = headers?.['content-type'] ?? headers?.['Content-Type'] ?? '';
          return writeHead(...args);
        };
        res.end = (content, ...args) => end(content && /text\/html|javascript|text\/css/.test(responseType) ? rewrite(String(content)) : content, ...args);
      }
      if (req.url === '/component') {
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(rewrite(componentHtml)); return;
      }
      if (req.url === '/api/oauth-onboarding/settings') {
        if (useBoundary) return await handler(req, res);
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
        state.requests.push({ method: req.method, body, url: pathname });
        if (req.method === 'GET') {
          if (state.onGet) return state.onGet(req, res);
          return json(res, payload(state.concurrency));
        }
        if (state.onPut) return state.onPut(body, req, res);
        state.concurrency = body.concurrency;
        return json(res, payload(state.concurrency));
      }
      await handler(req, res);
    } catch (error) {
      state.errors.push(error.message);
      if (!res.headersSent) json(res, { error: '测试服务异常' }, 500); else res.destroy();
    }
  });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(state.errors, []);
    assert.deepEqual(state.external, [], '不允许外部请求或子路径越界');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.route('**/*', async (route) => {
    if (!route.request().url().startsWith(`${base}${prefix}/`)) { state.external.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', (error) => state.errors.push(error.message));
  if (spa) await page.addInitScript(({ ignoreAbort }) => {
    const original = window.fetch;
    window.settingsSignals = []; window.settingsRequests = [];
    window.fetch = (url, init) => {
      if (!String(url).endsWith('/api/oauth-onboarding/settings')) return original(url, init);
      window.settingsSignals.push(init.signal);
      const { signal, ...rest } = init;
      const pending = original(url, ignoreAbort ? rest : init);
      window.settingsRequests.push(pending.then((response) => response.clone().json()).catch(() => null));
      return pending;
    };
  }, { ignoreAbort });
  await page.goto(`${base}${prefix}${spa ? '/settings/oauth-onboarding' : '/component'}`, { waitUntil: 'domcontentloaded' });
  await input(page).waitFor();
  return { page, state, base };
}

for (const width of [1440, 390]) {
  test(`OAuth settings validates and saves a compact form at ${width}px`, { timeout: 30_000 }, async (t) => {
    const { page, state } = await fixture(t, { width });
    await waitValue(page, 5);
    assert.match(await page.locator('#oauth-settings-help').innerText(), /所有批次共享并发.*调低不会打断/);
    for (const value of ['', '0', '21', '2.5']) {
      await input(page).fill(value);
      assert.equal(await save(page).isDisabled(), true);
      await page.locator('form').evaluate((form) => form.dispatchEvent(new Event('submit', { cancelable: true })));
      assert.equal(state.requests.filter((request) => request.method === 'PUT').length, 0);
    }
    for (const value of [1, 20]) {
      await input(page).fill(String(value));
      await save(page).click();
      await page.waitForFunction(() => document.querySelector('#oauth-settings-status').textContent === '配置已保存。');
      await waitValue(page, value);
    }
    assert.deepEqual(state.requests.filter((request) => request.method === 'PUT').map((request) => request.body), [{ concurrency: 1 }, { concurrency: 20 }]);
    const transport = await page.evaluate(() => window.fetchCalls);
    assert.ok(transport.every((call) => call.cache === 'no-store' && call.credentials === 'same-origin'));
    const geometry = await page.locator('form').evaluate((form) => [...form.querySelectorAll('input, button')].map((element) => {
      const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth };
    }));
    assert.ok(geometry.every((rect) => rect.left >= 0 && rect.right <= rect.width));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `/tmp/oauth-settings-${width}.png`, fullPage: true });
  });
}

test('load failure blocks saving and reload recovers; malformed response cannot enable saving', { timeout: 30_000 }, async (t) => {
  const { page, state } = await fixture(t, { setup: (state) => { state.onGet = (_req, res) => json(res, { error: '不可用' }, 503); } });
  await message(page).filter({ hasText: '加载失败' }).waitFor();
  assert.equal(await input(page).isDisabled(), true);
  assert.equal(await save(page).isDisabled(), true);
  state.onGet = (_req, res) => json(res, { settings: { concurrency: '5' }, limits: { min: 1, max: 20 } });
  await reload(page).click();
  await page.waitForFunction(() => !document.querySelector('[data-oauth-settings-reload]').disabled);
  assert.equal(await save(page).isDisabled(), true);
  assert.match(await message(page).innerText(), /加载失败/);
  state.onGet = null; state.concurrency = 8;
  await reload(page).click(); await waitValue(page, 8);
  assert.equal(await save(page).isEnabled(), true);
  assert.equal(await message(page).innerText(), '');
});

test('save locks input and duplicate submission, keeps failed input, and safely retries or reloads', { timeout: 30_000 }, async (t) => {
  let release, receivedResolve;
  const received = new Promise((resolve) => { receivedResolve = resolve; });
  const { page, state } = await fixture(t, { setup: (state) => {
    state.onPut = (_body, _req, res) => { release = () => json(res, { error: '保存失败' }, 503); receivedResolve(); };
  } });
  await waitValue(page, 5); await input(page).fill('12'); await save(page).click();
  await page.waitForFunction(() => document.querySelector('form').getAttribute('aria-busy') === 'true');
  assert.equal(await input(page).isDisabled(), true);
  assert.equal(await save(page).isDisabled(), true);
  assert.equal(await reload(page).isDisabled(), true);
  await page.locator('form').evaluate((form) => form.dispatchEvent(new Event('submit', { cancelable: true })));
  await received;
  assert.equal(state.requests.filter((request) => request.method === 'PUT').length, 1);
  release();
  await message(page).filter({ hasText: '保存失败' }).waitFor();
  assert.equal(await input(page).inputValue(), '12');
  assert.equal(await save(page).isEnabled(), true);
  assert.doesNotMatch(await message(page).innerText(), /配置已保存/);
  state.onPut = null;
  await save(page).click();
  await message(page).filter({ hasText: '配置已保存' }).waitFor();
  assert.equal(state.concurrency, 12);
  await input(page).fill('3');
  await reload(page).click(); await waitValue(page, 12);
  assert.deepEqual(state.requests.filter((request) => request.method === 'PUT').map((request) => request.body), [{ concurrency: 12 }, { concurrency: 12 }]);
});

test('network failure and mismatched save response never show success or discard the draft', { timeout: 30_000 }, async (t) => {
  const { page, state } = await fixture(t);
  await waitValue(page, 5); await input(page).fill('9');
  await page.route('**/api/oauth-onboarding/settings', async (route) => {
    if (route.request().method() === 'PUT') await route.abort('failed'); else await route.continue();
  });
  await save(page).click(); await message(page).filter({ hasText: '保存失败' }).waitFor();
  assert.equal(await input(page).inputValue(), '9');
  assert.equal(await save(page).isEnabled(), true);
  await page.unroute('**/api/oauth-onboarding/settings');
  state.onPut = (_body, _req, res) => json(res, payload(5));
  await save(page).click();
  await page.waitForFunction(() => !document.querySelector('[type="submit"]').disabled);
  assert.match(await message(page).innerText(), /保存失败/);
  assert.equal(await input(page).inputValue(), '9');
});

for (const method of ['GET', 'PUT']) {
  for (const ignoreAbort of [false, true]) {
    test(`${method} is aborted on deactivation and ${ignoreAbort ? 'late response is isolated after reactivation' : 'cancellation is silent'}`, { timeout: 30_000 }, async (t) => {
      let release, receivedResolve;
      const received = new Promise((resolve) => { receivedResolve = resolve; });
      const { page, state } = await fixture(t, { ignoreAbort, setup: (state) => {
        const hold = (...args) => {
          const res = args.at(-1);
          release = () => json(res, payload(18)); receivedResolve();
        };
        if (method === 'GET') state.onGet = hold; else state.onPut = hold;
      } });
      if (method === 'PUT') {
        await waitValue(page, 5); await input(page).fill('18'); await save(page).click();
      }
      await received;
      await page.evaluate(() => window.view.deactivate());
      assert.equal(await page.evaluate(() => window.observedSignals.at(-1).aborted), true);
      assert.doesNotMatch(await message(page).innerText(), /失败|配置已保存/);
      const oldDom = await page.locator('#settings-oauth-onboarding-panel').innerHTML();
      if (ignoreAbort) {
        state.onGet = null; state.onPut = null; state.concurrency = 7;
        await page.evaluate(() => { window.second = window.view.activate(); });
        await waitValue(page, 7);
        const response = page.waitForResponse((response) => response.url().endsWith('/settings') && response.request().method() === method);
        release(); await response;
        if (method === 'GET') await page.evaluate(() => window.ready);
        else await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await input(page).inputValue(), '7');
        assert.equal(await save(page).isEnabled(), true);
        assert.equal(await message(page).innerText(), '');
      } else {
        release();
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator('#settings-oauth-onboarding-panel').innerHTML(), oldDom);
      }
    });
  }
}

for (const prefix of ['', '/upstream']) {
  for (const width of [1440, 390]) {
    test(`real SPA settings navigation, refresh, history and scoped visibility at ${prefix || '/'} ${width}px`, { timeout: 30_000 }, async (t) => {
      const { page, state, base } = await fixture(t, { spa: true, prefix, width });
      await waitValue(page, 5);
      await page.evaluate(() => { window.documentIdentity = 'same-document'; });
      const panel = page.locator('#settings-oauth-onboarding-panel');
      const settingsLink = page.locator('[data-setting-route="oauth-onboarding"]');
      const openSettings = async () => {
        if (!await settingsLink.isVisible()) await page.locator('#config-management-link').click();
        await settingsLink.click();
      };
      const assertPanels = async (id) => assert.deepEqual(await page.locator('main.workspace > .panel-view:not(.hidden)').evaluateAll((panels) => panels.map((panel) => panel.id)), [id]);
      assert.equal(await settingsLink.getAttribute('aria-current'), 'page');
      assert.equal(await page.locator('#config-management-link').getAttribute('aria-current'), 'page');
      await assertPanels('settings-oauth-onboarding-panel');
      await input(page).fill('6'); await save(page).click();
      await message(page).filter({ hasText: '配置已保存' }).waitFor();
      await page.reload({ waitUntil: 'networkidle' }); await waitValue(page, 6);
      await page.evaluate(() => { window.documentIdentity = 'same-document'; });
      await page.locator('[data-setting-route="auto-refresh"]').click();
      await page.waitForURL(`**${prefix}/settings/auto-refresh`);
      assert.equal(await panel.isHidden(), true);
      await assertPanels('settings-auto-refresh-panel');
      await page.goBack(); await waitValue(page, 6);
      assert.equal(new URL(page.url()).pathname, `${prefix}/settings/oauth-onboarding`);
      await page.goForward(); await assertPanels('settings-auto-refresh-panel');
      await settingsLink.click(); await waitValue(page, 6);
      assert.equal(await page.evaluate(() => window.documentIdentity), 'same-document', '设置导航和历史切换不能整页重载');
      for (const selector of ['[data-tab="sites"]', '[data-tab="groups"]', '[data-setting-route="proxies"]']) {
        if (selector.includes('setting')) await openSettings();
        await page.locator(selector).click();
        assert.equal(await panel.isHidden(), true);
        assert.equal(await settingsLink.getAttribute('aria-current'), null);
        const geometry = await panel.evaluate((element) => ({ display: getComputedStyle(element).display, height: element.getBoundingClientRect().height }));
        assert.deepEqual(geometry, { display: 'none', height: 0 });
      }
      await openSettings(); await waitValue(page, 6);
      await panel.scrollIntoViewIfNeeded();
      const geometry = await panel.evaluate((element) => {
        const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
      });
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.width, JSON.stringify(geometry));
      assert.equal(geometry.scrollWidth <= geometry.width, true);
      assert.ok(state.requests.every((request) => request.url === `${prefix}/api/oauth-onboarding/settings`));
      await page.screenshot({ path: `/tmp/oauth-settings-spa-${prefix ? 'upstream' : 'root'}-${width}.png`, fullPage: true });
      assert.equal(new URL(page.url()).origin, base);
    });
  }
}

for (const prefix of ['', '/upstream']) {
  for (const method of ['GET', 'PUT']) {
    test(`real SPA aborts ${method} on leave and isolates stale data under ${prefix || '/'}`, { timeout: 30_000 }, async (t) => {
      let release, receivedResolve;
      const received = new Promise((resolve) => { receivedResolve = resolve; });
      const { page, state } = await fixture(t, { spa: true, prefix, ignoreAbort: true, setup: (state) => {
        const hold = (...args) => { const res = args.at(-1); release = () => json(res, payload(19)); receivedResolve(); };
        if (method === 'GET') state.onGet = hold; else state.onPut = hold;
      } });
      if (method === 'PUT') { await waitValue(page, 5); await input(page).fill('19'); await save(page).click(); }
      else {
        assert.equal(await save(page).isDisabled(), true);
        await page.locator('#settings-oauth-onboarding-panel form').evaluate((form) => form.dispatchEvent(new Event('submit', { cancelable: true })));
        assert.equal(state.requests.filter((request) => request.method === 'PUT').length, 0);
      }
      await received;
      const oldIndex = await page.evaluate(() => window.settingsSignals.length - 1);
      await page.locator('[data-tab="sites"]').click();
      assert.equal(await page.evaluate((index) => window.settingsSignals[index].aborted, oldIndex), true);
      assert.equal(await page.locator('#settings-oauth-onboarding-panel').isHidden(), true);
      state.onGet = null; state.onPut = null; state.concurrency = 4;
      await page.locator('#config-management-link').click();
      await page.locator('[data-setting-route="oauth-onboarding"]').click(); await waitValue(page, 4);
      release();
      await page.evaluate(async (index) => { await window.settingsRequests[index]; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, oldIndex);
      assert.equal(await input(page).inputValue(), '4');
      assert.equal(await message(page).innerText(), '');
      assert.equal(await save(page).isEnabled(), true);
    });
  }
}

for (const prefix of ['', '/upstream']) {
  test(`real settings HTTP boundary accepts browser GET/PUT and reload at ${prefix || '/'}`, { timeout: 30_000 }, async (t) => {
    const { page, state } = await fixture(t, { spa: true, prefix, useBoundary: true });
    await waitValue(page, 5);
    await input(page).fill('10');
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/oauth-onboarding/settings') && response.request().method() === 'PUT');
    await save(page).click();
    const response = await saved;
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['cache-control'], 'no-store');
    assert.equal(response.request().headers()['content-type'], 'application/json');
    assert.deepEqual(response.request().postDataJSON(), { concurrency: 10 });
    assert.deepEqual(await response.json(), payload(10));
    await message(page).filter({ hasText: '配置已保存' }).waitFor();
    assert.equal(state.concurrency, 10);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle' }); await waitValue(page, 10);
    const loaded = page.waitForResponse((response) => response.url().endsWith('/api/oauth-onboarding/settings') && response.request().method() === 'GET');
    await reload(page).click();
    assert.equal((await loaded).headers()['cache-control'], 'no-store');
    await waitValue(page, 10);
  });
}
