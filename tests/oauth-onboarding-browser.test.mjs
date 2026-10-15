import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { defaultImportOptions } from '../src/oauth-import-options.mjs';
import { onboardingError } from '../src/oauth-onboarding-store.mjs';
import { chromium } from 'playwright';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const PROXY = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const EMAIL = 'existing@example.test';
const PASSWORD = 'offline-password-marker';
const TOTP = 'JBSWY3DPEHPK3PXP';
const group = (id, name, extra = {}) => ({ id, name, platform: 'openai', status: 'active', ...extra });
const job = (extra = {}) => ({
  id: JOB, email: EMAIL, mySiteId: SITE_A, proxyId: null, groupIds: [11, 12],
  status: 'running', stage: 'password', errorCode: '', message: '', remoteAccountId: null,
  createdAt: '2026-10-06T04:00:00Z', updatedAt: '2026-10-06T04:00:00Z', ...extra,
});
const role = (page, name) => page.locator(`[data-role="${name}"]`);
const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function fixture(t, { width = 1440, pollIntervalMs = 60_000, ignoreAbort = false, useBoundary = false, setup } = {}) {
  const state = {
    options: {
      mySites: [{ id: SITE_A, name: '星河 API' }, { id: SITE_B, name: '北辰 API' }],
      proxies: [{ id: PROXY, name: '测试代理', protocol: 'socks5', status: 'active', expiresAt: null }],
    },
    groups: {
      [SITE_A]: [group(11, '日常使用'), group(12, '备用分组'), group(13, '其他平台', { platform: 'anthropic' }), group(14, '停用分组', { status: 'inactive' })],
      [SITE_B]: [group(21, '北辰专属')],
    },
    preferences: {}, atomicSchedulable: true, atomicProtection: true, batches: new Map(), jobs: [], requests: [], reconciliationBodies: [], submissions: [], errors: [], external: [],
    onPreferences: null, onGroups: null, onSubmit: null, onJobs: null, onLookup: null, onReconcile: null, onOptions: null,
  };
  const assets = new Map(await Promise.all(['/styles.css', '/src/client-route.mjs', '/src/oauth-onboarding.css', '/src/oauth-onboarding-view.mjs', '/src/oauth-credential-input.mjs', '/src/oauth-import-options-view.mjs', '/src/oauth-import-options.mjs'].map(async (path) => [path, await readFile(new URL(`..${path}`, import.meta.url), 'utf8')])));
  const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/src/oauth-onboarding.css"><style>#host{height:100vh;min-width:0}</style></head><body><main id="host" class="panel-view"></main><script type="module">
    import { mountOAuthOnboarding } from '/src/oauth-onboarding-view.mjs';
    const transport = (path, init) => {
      window.observedSignals.push(init.signal);
      window.fetchCalls.push({ path, method: init.method, cache: init.cache, credentials: init.credentials });
      if (${ignoreAbort}) { const {signal, ...rest} = init; return fetch(path, rest); }
      return fetch(path, init);
    };
    window.observedSignals = [];
    window.fetchCalls = [];
    window.accepted = [];
    window.view = mountOAuthOnboarding(document.getElementById('host'), { fetchImpl: transport, pollIntervalMs: ${pollIntervalMs}, onAccepted: (id) => { window.accepted.push({ id, input: document.querySelector('[data-role=credential-line]').value }); } });
    window.ready = window.view.activate();
  </script></body></html>`;
  const boundary = useBoundary ? (await import('../src/oauth-onboarding-http.mjs')).handleOAuthOnboarding : null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return;
      }
      if (assets.has(url.pathname)) {
        res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
        res.end(assets.get(url.pathname)); return;
      }
      state.requests.push({ path: url.pathname, search: url.search, method: req.method });
      if (boundary) {
        await boundary(req, res, url, {
          options: async () => state.options,
          groups: async (id) => state.groups[id] ?? [],
          list: async () => state.jobs,
          listPage: async () => ({ jobs: state.jobs, nextCursor: null }),
          get: async (id) => state.jobs.find((item) => item.id === id),
          preferences: async (id) => ({ preferences: state.preferences[id] ?? { groupIds: [], importOptions: defaultImportOptions() }, capabilities: { atomicSchedulable: state.atomicSchedulable, atomicProtection: state.atomicProtection } }),
          getBatch: async (id) => {
            if (!state.batches.has(id)) throw onboardingError('NOT_FOUND', '批次不存在', 404);
            const batch = state.batches.get(id);
            return { ...batch, jobs: batch.jobs.map((j) => state.jobs.find((current) => current.id === j.id) ?? j) };
          },
          submitBatch: async (body) => {
            state.submissions.push(JSON.parse(JSON.stringify(body)));
            const batch = { id: body.requestId, jobs: body.accounts.map((account, index) => job({ id: `${body.requestId}-${index}`, batchId: body.requestId, email: account.email, mySiteId: body.mySiteId, proxyId: body.proxyId, groupIds: body.groupIds, status: 'queued', stage: 'validating' })) };
            state.batches.set(batch.id, batch); state.jobs.unshift(...batch.jobs);
            return batch;
          },
          reconcile: async (id) => {
            const updated = { ...state.jobs.find((item) => item.id === id), status: 'succeeded', stage: 'done', remoteAccountId: 91 };
            state.jobs = state.jobs.map((item) => item.id === id ? updated : item);
            return updated;
          },
        });
        return;
      }
      if (req.method === 'POST' && !/^application\/json/i.test(req.headers['content-type'] ?? '')) return json(res, { error: '请使用 JSON 请求' }, 415);
      if (url.pathname === '/api/oauth-onboarding/options') {
        if (state.onOptions) return await state.onOptions(req, res);
        return json(res, state.options);
      }
      if (url.pathname === '/api/oauth-onboarding/groups') {
        const siteId = url.searchParams.get('mySiteId');
        if (state.onGroups) return await state.onGroups(siteId, req, res);
        return json(res, { groups: state.groups[siteId] ?? [] });
      }
      if (url.pathname === '/api/oauth-onboarding/jobs' && req.method === 'GET') {
        if (state.onJobs) return await state.onJobs(req, res);
        return json(res, { jobs: state.jobs });
      }
      if (url.pathname === '/api/oauth-onboarding/preferences') {
        const id = url.searchParams.get('mySiteId');
        if (state.onPreferences) return await state.onPreferences(id, req, res);
        return json(res, { preferences: state.preferences[id] ?? { groupIds: [], importOptions: defaultImportOptions() }, capabilities: { atomicSchedulable: state.atomicSchedulable, atomicProtection: state.atomicProtection } });
      }
      if (url.pathname === '/api/oauth-onboarding/batches' && req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks)); state.submissions.push(body);
        if (state.onSubmit) return await state.onSubmit(body, req, res);
        const batch = state.batches.get(body.requestId) ?? { id: body.requestId, jobs: body.accounts.map((account, index) => job({ id: `${body.requestId}-${index}`, batchId: body.requestId, email: account.email, mySiteId: body.mySiteId, proxyId: body.proxyId, groupIds: body.groupIds, status: 'queued', stage: 'validating' })) };
        if (!state.batches.has(batch.id)) state.jobs.unshift(...batch.jobs);
        state.batches.set(batch.id, batch);
        state.preferences[body.mySiteId] = { groupIds: body.groupIds, importOptions: body.importOptions };
        return json(res, { batch }, 202);
      }
      const batchMatch = url.pathname.match(/^\/api\/oauth-onboarding\/batches\/([^/]+)$/);
      if (batchMatch) {
        if (state.onLookup) return await state.onLookup(batchMatch[1], req, res);
        const stored = state.batches.get(batchMatch[1]);
        const batch = stored && { ...stored, jobs: stored.jobs.map((j) => state.jobs.find((current) => current.id === j.id) ?? j) };
        return batch ? json(res, { batch }) : json(res, { error: '批次不存在' }, 404);
      }
      const match = url.pathname.match(/^\/api\/oauth-onboarding\/jobs\/([^/]+)(\/reconcile)?$/);
      if (match) {
        if (match[2]) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          state.reconciliationBodies.push(JSON.parse(Buffer.concat(chunks)));
          if (state.onReconcile) return await state.onReconcile(match[1], req, res);
          const found = state.jobs.find((item) => item.id === match[1]);
          const updated = job({ ...found, status: 'succeeded', stage: 'done', remoteAccountId: 91 });
          state.jobs = state.jobs.map((item) => item.id === updated.id ? updated : item);
          return json(res, { job: updated });
        }
        if (state.onLookup) return await state.onLookup(match[1], req, res);
        const found = state.jobs.find((item) => item.id === match[1]);
        return found ? json(res, { job: found }) : json(res, { error: '任务不存在' }, 404);
      }
      json(res, { error: '本地测试没有该接口' }, 404);
    } catch (error) {
      state.errors.push(error.message);
      if (!res.headersSent) json(res, { error: '本地测试异常' }, 500); else res.destroy();
    }
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(state.external, [], '浏览器不得访问本地 HTTP 以外的站点');
    assert.deepEqual(state.errors, [], '页面和本地服务不应出现未处理异常');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.route('**/*', async (route) => {
    if (!route.request().url().startsWith(`${baseUrl}/`)) {
      state.external.push(route.request().url()); await route.abort();
    } else await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.addInitScript(() => {
    window.storageWrites = [];
    const record = (kind) => function (...args) { window.storageWrites.push([kind, ...args.map(String)]); throw new Error('Storage is forbidden in this fixture'); };
    Storage.prototype.setItem = record('storage');
    IDBFactory.prototype.open = record('indexedDB');
    if (window.caches) window.caches.open = record('cache');
    if (navigator.serviceWorker) navigator.serviceWorker.register = record('serviceWorker');
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: record('cookie') });
  });
  if (setup) await setup({ state, page });
  await page.goto(baseUrl);
  await page.evaluate(() => window.ready);
  return { page, state, baseUrl };
}

async function selectSite(page, site = SITE_A) {
  await role(page, 'site').selectOption(site);
  await page.waitForFunction(() => !document.querySelector('[data-role="groups-fieldset"]').disabled);
}

async function fill(page, { proxy = '', text = `${EMAIL}|${PASSWORD}|${TOTP}` } = {}) {
  await role(page, 'credential-line').fill(text);
  await role(page, 'parse-credentials').click();
  if (!(await role(page, 'proxy').isDisabled())) await role(page, 'proxy').selectOption(proxy);
}

async function chooseGroups(page, ids = [11, 12]) {
  for (const id of ids) await role(page, 'groups').locator(`input[value="${id}"]`).check();
}

async function assertNoSecrets(page) {
  const snapshot = await page.evaluate(() => ({
    password: document.querySelector('[data-role="password"]')?.value ?? '',
    totp: document.querySelector('[data-role="totp"]')?.value ?? '',
    line: document.querySelector('[data-role="credential-line"]')?.value ?? '',
    html: document.documentElement.outerHTML,
    datasets: [...document.querySelectorAll('*')].map((node) => JSON.stringify(node.dataset)).join(''),
    local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), writes: window.storageWrites,
  }));
  assert.equal(snapshot.password, '');
  assert.equal(snapshot.totp, '');
  assert.equal(snapshot.line, '');
  assert.deepEqual(snapshot.writes, []);
  for (const value of [snapshot.html, snapshot.datasets, snapshot.local, snapshot.session]) {
    assert.equal(value.includes(PASSWORD), false);
    assert.equal(value.includes(TOTP), false);
  }
}


const option = (page, name) => page.locator(`[data-option="${name}"]`);
async function waitAccepted(page) {
  await page.waitForFunction(() => document.querySelector('[data-role="submit-message"]').textContent.includes('批次已创建'));
}
async function waitLookup(page) {
  await page.waitForFunction(() => !document.querySelector('[data-role="lookup"]').hidden && !document.querySelector('[data-role="lookup"]').disabled);
}
async function pasteCredentials(page, text) {
  await role(page, 'credential-line').evaluate((input, value) => {
    const data = new DataTransfer(); data.setData('text/plain', value);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

for (const width of [1440, 390]) {
  test(`batch OAuth UI ${width}px: only multiline credentials, count-only feedback, exact common payload and reachable layout`, { timeout: 30_000 }, async (t) => {
    const { page, state } = await fixture(t, { width });
    await selectSite(page);
    assert.equal(await page.locator('[name="email"], [name="password"], [name="totpSecret"]').count(), 0);
    assert.equal(await role(page, 'credential-line').evaluate((input) => input.tagName), 'TEXTAREA');
    assert.equal(await role(page, 'credential-line').getAttribute('autocomplete'), 'off');
    assert.equal(await role(page, 'groups').locator('input').count(), 2);
    assert.equal(await role(page, 'submit').isDisabled(), true);
    const raw = `${EMAIL}--- ${PASSWORD} ---${TOTP}\r\ninvalid secret-line\r\nsecond@example.test|another-password|${TOTP}\n${EMAIL.toUpperCase()}|duplicate-password|${TOTP}`;
    await pasteCredentials(page, raw);
    assert.equal(await role(page, 'credential-message').innerText(), '解析成功 2 · 失败 2');
    assert.equal(await role(page, 'credential-line').inputValue(), raw.replaceAll('\r\n', '\n'));
    assert.equal((await page.locator('body').innerText()).includes('secret-line'), false);
    assert.equal((await page.locator('body').innerText()).includes(PASSWORD), false);
    await role(page, 'proxy').selectOption(width === 1440 ? PROXY : '');
    await role(page, 'search').fill('日常'); await chooseGroups(page, [11]);
    await role(page, 'search').fill('备用'); await chooseGroups(page, [12]);
    await role(page, 'search').fill('');
    assert.equal(await role(page, 'group-count').innerText(), '已选 2 个');
    assert.equal(await option(page, 'model-list').locator('input:checked').count(), 6);
    await option(page, 'custom-model').fill('local-custom'); await option(page, 'add-model').click();
    await option(page, 'concurrency').fill('77'); await option(page, 'loadFactor').fill('');
    await option(page, 'fingerprintMode').selectOption('session'); await option(page, 'schedulable').uncheck();
    const contentHeight = await page.locator('.oauth-onboarding').evaluate((root) => root.scrollHeight);
    await page.setViewportSize({ width, height: contentHeight + 32 });
    await page.locator('.oauth-onboarding').evaluate((root) => root.scrollTo(0, 0));
    await page.screenshot({ path: `/tmp/oauth-batch-import-${width === 1440 ? 'desktop' : 'mobile'}.png`, fullPage: true });
    await page.setViewportSize({ width, height: 900 });
    await role(page, 'submit').click(); await waitAccepted(page);
    assert.equal(state.submissions.length, 1);
    const body = state.submissions[0];
    assert.match(body.requestId, /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/);
    assert.deepEqual(Object.keys(body).sort(), ['accounts', 'groupIds', 'importOptions', 'mySiteId', 'proxyId', 'requestId']);
    assert.deepEqual(body.groupIds, [11, 12]); assert.equal(body.mySiteId, SITE_A);
    assert.equal(body.proxyId, width === 1440 ? PROXY : null);
    assert.deepEqual(body.accounts, [{ email: EMAIL, password: ` ${PASSWORD} `, totpSecret: TOTP }, { email: 'second@example.test', password: 'another-password', totpSecret: TOTP }]);
    assert.deepEqual(body.importOptions, { ...defaultImportOptions(), models: [...defaultImportOptions().models, 'local-custom'], concurrency: 77, loadFactor: null, fingerprintMode: 'session', schedulable: false });
    assert.equal(await role(page, 'confirmation').locator('a').getAttribute('href'), `/oauth-tasks?batch=${body.requestId}`);
    assert.equal(await page.locator('.oauth-job').count(), 0);
    await assertNoSecrets(page);
    assert.equal(state.requests.some((request) => request.method === 'PUT'), false);
    await role(page, 'confirmation').scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, width: innerWidth,
      panels: [...document.querySelectorAll('.oauth-form-main, .oauth-submit-summary')].map((item) => ({ x: item.getBoundingClientRect().x, y: item.getBoundingClientRect().y })),
    }));
    assert.ok(geometry.scroll <= geometry.width + 1);
    assert.equal(geometry.panels.length, 2);
    const calls = await page.evaluate(() => window.fetchCalls);
    assert.ok(calls.every((call) => call.cache === 'no-store' && call.credentials === 'same-origin'));
  });
}

test('preferences and groups load concurrently, restore only after both, isolate sites and reject invalid groups explicitly', { timeout: 30_000 }, async (t) => {
  const { page, state } = await fixture(t);
  const pending = {};
  state.onGroups = (id, req, res) => { pending.groups = res; };
  state.onPreferences = (id, req, res) => { pending.preferences = res; };
  await role(page, 'site').selectOption(SITE_A);
  await page.waitForTimeout(80);
  assert.ok(pending.groups && pending.preferences, '两个请求必须同时发出，不能串行等待');
  json(pending.preferences, { preferences: { groupIds: [11, 999], importOptions: { ...defaultImportOptions(), concurrency: 88 } }, capabilities: { atomicSchedulable: true, atomicProtection: true } });
  await page.waitForTimeout(30);
  assert.equal(await role(page, 'groups-fieldset').evaluate((input) => input.disabled), true);
  json(pending.groups, { groups: state.groups[SITE_A] });
  await page.waitForFunction(() => !document.querySelector('[data-role="groups-fieldset"]').disabled);
  assert.equal(await role(page, 'groups').locator('input:checked').count(), 0);
  assert.match(await role(page, 'groups-message').innerText(), /失效.*重新选择/);
  assert.equal(await option(page, 'concurrency').inputValue(), '88');
  await fill(page); assert.equal(await role(page, 'submit').isDisabled(), true);
  await chooseGroups(page, [11]); assert.equal(await role(page, 'submit').isDisabled(), false);
  state.onGroups = null; state.onPreferences = null;
  state.preferences[SITE_B] = { groupIds: [21], importOptions: { ...defaultImportOptions(), priority: 9 } };
  await selectSite(page, SITE_B);
  assert.equal(await option(page, 'concurrency').inputValue(), '50');
  assert.equal(await role(page, 'group-count').innerText(), '已选 1 个');
  await page.locator('.oauth-advanced summary').click();
  assert.equal(await option(page, 'priority').inputValue(), '9');
  await role(page, 'proxy').selectOption(PROXY);
  await page.evaluate(() => window.view.deactivate()); await page.evaluate(() => window.view.activate());
  assert.equal(await role(page, 'proxy').inputValue(), '', '代理不可从偏好或上次页面恢复');
});

test('old target groups/preferences success and failure cannot replace latest state without abort support', { timeout: 30_000 }, async (t) => {
  const pending = [];
  const { page, state } = await fixture(t, { ignoreAbort: true });
  await selectSite(page); await chooseGroups(page, [11]);
  state.onGroups = (id, req, res) => { pending.push({ id, res }); };
  await role(page, 'site').selectOption(SITE_B);
  assert.equal(await role(page, 'group-count').innerText(), '已选 0 个');
  await role(page, 'site').selectOption(SITE_A); await page.waitForTimeout(50);
  json(pending[1].res, { groups: state.groups[SITE_A] });
  await role(page, 'groups').locator('input[value="11"]').waitFor();
  json(pending[0].res, { groups: state.groups[SITE_B] }); await page.waitForTimeout(50);
  assert.equal(await role(page, 'groups').locator('input[value="21"]').count(), 0);
  assert.equal(await role(page, 'groups').locator('input:checked').count(), 0);
  await role(page, 'site').selectOption(SITE_B); await role(page, 'site').selectOption(SITE_A); await page.waitForTimeout(50);
  json(pending[3].res, { groups: state.groups[SITE_A] }); await role(page, 'groups').locator('input[value="11"]').waitFor();
  json(pending[2].res, { error: '旧站点错误不可覆盖' }, 503); await page.waitForTimeout(50);
  assert.doesNotMatch(await role(page, 'groups-message').innerText(), /旧站点错误/);
});

test('capability false preserves saved false and blocks until explicit enable; real plan enum and advanced options submit accurately', async (t) => {
  const { page, state } = await fixture(t);
  state.atomicSchedulable = false;
  state.preferences[SITE_A] = { groupIds: [11], importOptions: { ...defaultImportOptions(), schedulable: false } };
  await selectSite(page); await fill(page);
  assert.equal(await option(page, 'schedulable').isDisabled(), false);
  assert.equal(await option(page, 'schedulable').isChecked(), false);
  assert.equal(await role(page, 'submit').isDisabled(), true);
  assert.equal(state.submissions.length, 0);
  assert.match(await option(page, 'capability-message').innerText(), /升级 Sub2.*显式开启调度/);
  await option(page, 'schedulable').check();
  assert.equal(await option(page, 'schedulable').isDisabled(), true);
  assert.equal(await role(page, 'submit').isDisabled(), false);
  assert.equal(await option(page, 'planType').inputValue(), '');
  await page.locator('.oauth-advanced summary').click();
  await option(page, 'priority').fill('5'); await option(page, 'rateMultiplier').fill('0');
  await option(page, 'wsMode').selectOption('http_bridge');
  await option(page, 'planType').selectOption('self_serve_business_prolite');
  assert.match(await option(page, 'planType').locator('option:checked').innerText(), /Business Premium/);
  await option(page, 'autoPauseOnExpired').uncheck();
  await role(page, 'submit').click(); await waitAccepted(page);
  assert.deepEqual(state.submissions[0].importOptions, { ...defaultImportOptions(), schedulable: true, priority: 5, rateMultiplier: 0, wsMode: 'http_bridge', planType: 'self_serve_business_prolite', autoPauseOnExpired: false });
});

test('explicit mapping/unrestricted modes and invalid whitelist never silently allow all models', async (t) => {
  const { page, state } = await fixture(t);
  await selectSite(page); await fill(page); await chooseGroups(page);
  for (const input of await option(page, 'model-list').locator('input').all()) await input.uncheck();
  await role(page, 'submit').click();
  assert.match(await role(page, 'submit-message').innerText(), /至少选择一个模型/);
  assert.equal(state.submissions.length, 0);
  await option(page, 'modelMode').selectOption('mapping');
  await option(page, 'modelMapping').fill('{"alias":"gpt-6-astra"}');
  await role(page, 'submit').click(); await waitAccepted(page);
  assert.deepEqual(state.submissions[0].importOptions.modelMapping, { alias: 'gpt-6-astra' });
  await fill(page, { text: `another@example.test|${PASSWORD}|${TOTP}` });
  await option(page, 'modelMode').selectOption('unrestricted');
  await role(page, 'submit').click(); await waitAccepted(page);
  assert.equal(state.submissions[1].importOptions.modelMode, 'unrestricted');
  assert.deepEqual(state.submissions[1].importOptions.modelMapping, {});
});

test('lost POST response queries original batch ID without automatically re-posting and clears secrets immediately', async (t) => {
  const { page, state } = await fixture(t);
  state.onSubmit = (body, req, res) => {
    const batch = { id: body.requestId, jobs: [job({ id: `${body.requestId}-0`, groupIds: body.groupIds, status: 'queued', stage: 'validating' })] };
    state.batches.set(batch.id, batch); state.jobs = batch.jobs; res.destroy();
  };
  await selectSite(page); await fill(page); await chooseGroups(page);
  await role(page, 'submit').click(); await waitAccepted(page);
  assert.equal(await page.evaluate(() => window.fetchCalls.filter((call) => call.method === 'POST').length), 1);
  const id = state.submissions[0].requestId;
  assert.deepEqual([...new Set(state.submissions.map((body) => body.requestId))], [id]);
  assert.equal(state.requests.filter((request) => request.path === `/api/oauth-onboarding/batches/${id}`).length, 1);
  assert.equal(await role(page, 'lookup').isVisible(), false);
  await assertNoSecrets(page);
});

test('unconfirmed batch forbids retry before lookup, locks metadata and retains same key across lifecycle with fresh secrets', async (t) => {
  const { page, state } = await fixture(t);
  state.onSubmit = (body, req, res) => json(res, { error: '结果不明' }, 503);
  let lookupResponse;
  state.onLookup = (id, req, res) => { lookupResponse = res; };
  await selectSite(page); await fill(page); await chooseGroups(page);
  await role(page, 'submit').click(); await page.waitForTimeout(80);
  assert.ok(lookupResponse); assert.equal(await role(page, 'submit').isDisabled(), true);
  assert.equal(await role(page, 'credential-line').isDisabled(), true);
  for (const name of ['site', 'proxy', 'groups-fieldset']) assert.equal(await role(page, name).evaluate((input) => input.disabled), true);
  await pasteCredentials(page, `other@example.test|evil-secret|${TOTP}`);
  assert.equal(state.submissions.length, 1); await assertNoSecrets(page);
  json(lookupResponse, { error: '批次不存在' }, 404); await waitLookup(page);
  const id = state.submissions[0].requestId;
  await page.evaluate(() => window.view.deactivate()); await assertNoSecrets(page);
  state.onLookup = null; state.onSubmit = null;
  await page.evaluate(() => window.view.activate()); await waitLookup(page);
  assert.equal(await role(page, 'credential-line').inputValue(), '');
  await fill(page, { text: `different@example.test|${PASSWORD}|${TOTP}` });
  await role(page, 'submit').click();
  assert.match(await role(page, 'submit-message').innerText(), /账号及顺序不变/); assert.equal(state.submissions.length, 1);
  await fill(page); await role(page, 'submit').click(); await waitAccepted(page);
  assert.equal(state.submissions[1].requestId, id);
  assert.deepEqual(state.submissions[1].importOptions, state.submissions[0].importOptions);
  await assertNoSecrets(page);
});

test('non-404 lookup failure cannot permit same-key resubmission or new ID', async (t) => {
  const { page, state } = await fixture(t);
  state.onSubmit = (body, req, res) => json(res, { error: '提交结果待确认' }, 503);
  state.onLookup = (id, req, res) => json(res, { error: '查询不可用' }, 503);
  await selectSite(page); await fill(page); await chooseGroups(page);
  await role(page, 'submit').click(); await waitLookup(page);
  assert.equal(await role(page, 'submit').isDisabled(), true);
  assert.equal(await role(page, 'credential-line').isDisabled(), true);
  await role(page, 'lookup').click(); await waitLookup(page);
  assert.equal(state.submissions.length, 1); await assertNoSecrets(page);
});

test('import does not load history and an ordinary admission conflict remains same-key lookup-only', async (t) => {
  const { page, state } = await fixture(t);
  state.onSubmit = (body, req, res) => json(res, { error: '账号已有结果不明任务，请前往入池任务只读对账' }, 409);
  state.onLookup = (id, req, res) => json(res, { error: '暂时无法查询' }, 503);
  await selectSite(page); await fill(page); await chooseGroups(page); await role(page, 'submit').click(); await waitLookup(page);
  assert.equal(await role(page, 'submit').isDisabled(), true);
  assert.equal(await page.getByRole('heading', { name: '任务记录' }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: '任务进度' }).count(), 0);
  assert.equal(state.requests.some((req) => req.path.endsWith('/jobs')), false);
  assert.equal(state.reconciliationBodies.length, 0);
  assert.equal(state.submissions.length, 1);
  await assertNoSecrets(page);
});

test('deactivate aborts requests, stops lookup polling, clears secrets and rejects stale options', async (t) => {
  const { page, state } = await fixture(t, { ignoreAbort: true, pollIntervalMs: 80 });
  await selectSite(page); await fill(page);
  let response;
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  state.onOptions = (req, res) => { response = res; started(); };
  await role(page, 'reload').click(); await pending;
  await page.evaluate(() => window.view.deactivate()); await assertNoSecrets(page);
  assert.ok(await page.evaluate(() => window.observedSignals.at(-1).aborted));
  const count = state.requests.length;
  json(response, { mySites: [{ id: SITE_A, name: 'stale-site' }], proxies: [] });
  await page.waitForTimeout(180);
  assert.equal(state.requests.length, count);
  assert.equal((await role(page, 'site').textContent()).includes('stale-site'), false);
  await pasteCredentials(page, `${EMAIL}|${PASSWORD}|${TOTP}`); await assertNoSecrets(page);
});

test('navigation during POST releases secrets, aborts transport and later verifies accepted batch without re-post', async (t) => {
  const { page, state } = await fixture(t, { ignoreAbort: true });
  let pending;
  state.onSubmit = (body, req, res) => { pending = { body, res }; };
  await selectSite(page); await fill(page); await chooseGroups(page);
  await role(page, 'submit').click(); await page.waitForTimeout(50);
  await assertNoSecrets(page);
  await page.evaluate(() => window.view.deactivate()); await assertNoSecrets(page);
  const batch = { id: pending.body.requestId, jobs: [job({ id: `${pending.body.requestId}-0`, status: 'succeeded', stage: 'done' })] };
  state.batches.set(batch.id, batch); state.jobs = batch.jobs;
  json(pending.res, { batch }, 202); await page.waitForTimeout(50);
  await page.evaluate(() => window.view.activate()); await waitAccepted(page);
  assert.equal(state.submissions.length, 1); await assertNoSecrets(page);
});

test('controlled errors are text, transport exceptions never echo credentials and failed options remain empty', async (t) => {
  const { page, state } = await fixture(t);
  state.onOptions = (req, res) => json(res, { error: '<b>不可用</b>' }, 503);
  await page.evaluate(() => window.view.activate());
  assert.equal(await role(page, 'site').locator('option').count(), 1);
  assert.equal(await role(page, 'site').isDisabled(), true);
  assert.equal(await role(page, 'options-message').innerText(), '<b>不可用</b>');
  assert.equal(await role(page, 'options-message').locator('b').count(), 0);
  state.onOptions = null; await page.evaluate(() => window.view.activate()); await selectSite(page); await fill(page); await chooseGroups(page);
  await page.evaluate((secret) => {
    const original = window.fetch;
    window.fetch = (path, init) => init?.method === 'POST' ? Promise.reject(new Error(secret)) : original(path, init);
  }, PASSWORD);
  await role(page, 'submit').click(); await waitLookup(page);
  assert.equal((await page.locator('body').innerText()).includes(PASSWORD), false);
  await assertNoSecrets(page);
});

test('definite validation rejection allows a new corrected request, invalid success remains same-key uncertain', async (t) => {
  const { page, state } = await fixture(t);
  state.onSubmit = (body, req, res) => json(res, { error: '请检查参数' }, 400);
  await selectSite(page); await fill(page); await chooseGroups(page); await role(page, 'submit').click();
  await page.waitForFunction(() => document.querySelector('[data-role="submit-message"]').textContent === '请检查参数');
  assert.equal(await role(page, 'lookup').isVisible(), false); await assertNoSecrets(page);
  const id = state.submissions[0].requestId;
  state.onSubmit = (body, req, res) => json(res, { batch: { id: 'wrong', jobs: [] } }, 202);
  await fill(page); await role(page, 'submit').click(); await waitLookup(page);
  assert.notEqual(state.submissions[1].requestId, id);
  assert.equal(await role(page, 'lookup').isVisible(), true); await assertNoSecrets(page);
});

test('actual same-origin JSON boundary accepts batch and exposes the batch task link', async (t) => {
  const { page, state } = await fixture(t, { useBoundary: true });
  await selectSite(page); await fill(page); await chooseGroups(page); await role(page, 'submit').click(); await waitAccepted(page);
  assert.equal(state.submissions.length, 1); assert.equal(state.submissions[0].accounts[0].password, PASSWORD);
  assert.equal(await role(page, 'confirmation').locator('a').getAttribute('href'), `/oauth-tasks?batch=${state.submissions[0].requestId}`);
  assert.equal(state.submissions.length, 1); await assertNoSecrets(page);
});



test('unavailable proxies are excluded, theme and mobile fields stay local', async (t) => {
  const { page, state } = await fixture(t, { width: 390 });
  state.options.proxies.push({ id: 'expired', name: '到期', protocol: 'http', status: 'active', expiresAt: '2020-01-01' }, { id: 'disabled', name: '禁用', protocol: 'http', status: 'inactive' });
  await page.evaluate(() => window.view.activate());
  assert.equal(await role(page, 'proxy').locator('option').count(), 2);
  await selectSite(page);
  await page.evaluate(() => document.documentElement.style.setProperty('--green', 'rgb(23, 88, 66)'));
  await role(page, 'credential-line').scrollIntoViewIfNeeded();
  assert.equal(await role(page, 'credential-line').evaluate((element) => getComputedStyle(element).fontSize), '16px');
  await option(page, 'schedulable').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
});

test('raw and parsed credentials clear on deactivate, pagehide, destroy; real pagehide does not cancel accepted backend tasks', async (t) => {
  const { page, state, baseUrl } = await fixture(t);
  for (const action of ['deactivate', 'pagehide']) {
    await selectSite(page); await fill(page);
    await role(page, 'credential-line').fill(`${EMAIL}|${PASSWORD}|${TOTP}`);
    await page.evaluate((action) => action === 'pagehide' ? window.dispatchEvent(new Event('pagehide')) : window.view.deactivate(), action);
    await assertNoSecrets(page);
    await pasteCredentials(page, `${EMAIL}|${PASSWORD}|${TOTP}`); await assertNoSecrets(page);
    await page.evaluate(() => window.view.activate());
  }
  await selectSite(page); await fill(page); await chooseGroups(page); await role(page, 'submit').click(); await waitAccepted(page);
  await fill(page, { text: `new@example.test|${PASSWORD}|${TOTP}` });
  await page.evaluate(() => {
    window.addEventListener('pagehide', () => { window.hideWasClean = document.querySelector('[data-role="credential-line"]').value === ''; });
  });
  await page.goto(`${baseUrl}/?next`);
  assert.equal(state.jobs.length, 1, '已接收任务不应因关页被取消');
  await selectSite(page); await fill(page);
  await page.evaluate(() => { window.heldLine = document.querySelector('[data-role="credential-line"]'); window.view.destroy(); });
  assert.equal(await page.evaluate(() => window.heldLine.value), ''); await assertNoSecrets(page);
});

test('partial failures never echo credentials, editing invalidates parsed accounts and batch limits reject whole input', async (t) => {
  const { page, state } = await fixture(t);
  await selectSite(page); await chooseGroups(page);
  await pasteCredentials(page, `${EMAIL}|${PASSWORD}|${TOTP}\ninvalid-${PASSWORD}\n${EMAIL}|other-password|${TOTP}`);
  assert.equal(await role(page, 'credential-message').innerText(), '解析成功 1 · 失败 2');
  assert.equal((await page.locator('body').innerText()).includes(PASSWORD), false);
  await role(page, 'credential-line').fill('not-valid');
  assert.equal(await role(page, 'submit').isDisabled(), true);
  await role(page, 'parse-credentials').click();
  assert.equal(await role(page, 'credential-message').innerText(), '解析成功 0 · 失败 1');
  await role(page, 'credential-line').fill('');
  await pasteCredentials(page, Array.from({ length: 31 }, (_, index) => `${index}@example.test|${PASSWORD}|${TOTP}`).join('\n'));
  assert.match(await role(page, 'credential-message').innerText(), /最多 30/); assert.equal(await role(page, 'submit').isDisabled(), true);
  await pasteCredentials(page, '中'.repeat(44_000));
  assert.match(await role(page, 'credential-message').innerText(), /128 KiB/); assert.equal(state.submissions.length, 0);
  assert.equal(await role(page, 'submit').isDisabled(), true);
  await page.evaluate(() => window.view.deactivate());
  await assertNoSecrets(page);
});

test('native multiline drag/drop parses raw lines and preserves password boundary hyphens', async (t) => {
  const { page, state } = await fixture(t);
  await selectSite(page);
  const text = `${EMAIL}|-abc-|${TOTP}\nnext@example.test|abc----xyz|${TOTP}`;
  await page.evaluate((text) => {
    const source = document.createElement('button'); source.id = 'drag-source'; source.type = 'button'; source.textContent = '拖放'; source.draggable = true;
    source.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', text));
    document.querySelector('[data-role="form"]').prepend(source);
  }, text);
  await page.locator('#drag-source').dragTo(role(page, 'credential-line'));
  assert.equal(await role(page, 'credential-message').innerText(), '解析成功 2 · 失败 0');
  assert.equal(await role(page, 'credential-line').inputValue(), text);
  await chooseGroups(page); await role(page, 'submit').click(); await waitAccepted(page);
  assert.deepEqual(state.submissions[0].accounts.map((account) => account.password), ['-abc-', 'abc----xyz']);
  await assertNoSecrets(page);
});

test('target rollback never silently changes persisted schedulable=false; upgrading recovers original false submission', async (t) => {
  const { page, state } = await fixture(t);
  await selectSite(page); await fill(page); await chooseGroups(page);
  await option(page, 'schedulable').uncheck();
  await role(page, 'submit').click(); await waitAccepted(page);
  assert.equal(state.preferences[SITE_A].importOptions.schedulable, false);
  state.atomicSchedulable = false; // 上次接受 false 后，目标回滚到不支持原子创建的版本。
  await page.evaluate(() => window.view.activate());
  await fill(page, { text: `new@example.test|${PASSWORD}|${TOTP}` });
  assert.equal(await option(page, 'schedulable').isChecked(), false);
  assert.equal(await role(page, 'submit').isDisabled(), true);
  assert.equal(state.submissions.length, 1);
  assert.equal(state.preferences[SITE_A].importOptions.schedulable, false);
  assert.match(await option(page, 'capability-message').innerText(), /记忆的设置为关闭调度/);
  state.atomicSchedulable = true;
  await page.evaluate(() => window.view.activate());
  await fill(page, { text: `new@example.test|${PASSWORD}|${TOTP}` });
  assert.equal(await option(page, 'schedulable').isChecked(), false);
  await role(page, 'submit').click(); await waitAccepted(page);
  assert.equal(state.submissions[1].importOptions.schedulable, false);
  assert.equal(state.requests.some((request) => request.method === 'PUT'), false);
});


test('each confirmed submission link targets its batch without retaining task history or credentials', async (t) => {
  const { page, state } = await fixture(t);
  await selectSite(page); await chooseGroups(page);
  for (const prefix of ['first-', 'second-']) {
    await fill(page, { text: Array.from({ length: 30 }, (_, i) => `${prefix}${i}@example.test|${PASSWORD}|${TOTP}`).join('\n') });
    await role(page, 'submit').click(); await waitAccepted(page);
    assert.equal(await role(page, 'confirmation').locator('a').getAttribute('href'), `/oauth-tasks?batch=${state.submissions.at(-1).requestId}`);
    await assertNoSecrets(page);
  }
  assert.equal(state.jobs.length, 60);
  assert.equal(state.requests.some((req) => req.path.endsWith('/jobs')), false);
  assert.equal(await page.locator('.oauth-job').count(), 0);
});



test('paste and parse retain full text, additional paste inserts at selection and device is the initial default', async (t) => {
  const { page, state } = await fixture(t);
  await selectSite(page); await chooseGroups(page);
  assert.equal(await option(page, 'fingerprintMode').inputValue(), 'device');
  assert.equal(await option(page, 'fingerprintMode').locator('option:checked').innerText(), '仅设备');
  const first = `${EMAIL}| ${PASSWORD} |${TOTP}`;
  const second = `\nsecond@example.test|other-password|${TOTP}`;
  await pasteCredentials(page, first);
  assert.equal(await role(page, 'credential-line').inputValue(), first);
  await role(page, 'parse-credentials').click();
  assert.equal(await role(page, 'credential-line').inputValue(), first);
  await pasteCredentials(page, second);
  assert.equal(await role(page, 'credential-line').inputValue(), first + second);
  assert.equal(await role(page, 'credential-message').innerText(), '解析成功 2 · 失败 0');
  await role(page, 'credential-line').evaluate((input) => input.setSelectionRange(0, input.value.indexOf('|')));
  await pasteCredentials(page, 'replaced@example.test');
  assert.equal(await role(page, 'credential-line').inputValue(), first.replace(EMAIL, 'replaced@example.test') + second);
  await role(page, 'submit').click(); await waitAccepted(page);
  assert.equal(state.submissions[0].importOptions.accountProtection, false);
  assert.equal(state.submissions[0].importOptions.fingerprintMode, 'device');
  assert.equal(state.submissions[0].accounts[0].password, ` ${PASSWORD} `);
  await assertNoSecrets(page);
});

test('old target cannot silently enable account protection or override the fingerprint', async (t) => {
  const { page, state } = await fixture(t);
  state.atomicProtection = false;
  await selectSite(page); await chooseGroups(page); await fill(page);
  assert.equal(await option(page, 'fingerprintMode').inputValue(), 'device');
  assert.equal(await role(page, 'submit').isDisabled(), true);
  assert.match(await option(page, 'capability-message').innerText(), /关闭账号保护.*升级 Sub2/);
  assert.equal(state.submissions.length, 0);
  state.atomicProtection = true;
  await page.evaluate(() => window.view.activate());
  await fill(page); await chooseGroups(page);
  assert.equal(await role(page, 'submit').isDisabled(), false);
});


test('one target is selected and groups restored automatically; target control and static instructions are absent', async (t) => {
  const { page } = await fixture(t, { setup: ({ state }) => {
    state.options.mySites = [state.options.mySites[0]];
    state.preferences[SITE_A] = { groupIds: [11, 12], importOptions: defaultImportOptions() };
  } });
  assert.equal(await role(page, 'site-field').isVisible(), false);
  assert.equal(await role(page, 'site').inputValue(), SITE_A);
  assert.equal(await role(page, 'groups-fieldset').isDisabled(), false);
  assert.equal(await role(page, 'groups').locator('input:checked').count(), 2);
  assert.equal(await role(page, 'groups').locator('small').count(), 0);
  assert.equal(await page.locator('.oauth-notice, [data-role="credential-hint"], .oauth-import-options p.oauth-muted').count(), 0);
  assert.ok((await role(page, 'summary-details').innerText()).includes('星河 API'));
  await fill(page);
  assert.equal(await role(page, 'submit').innerText(), '创建 1 个账号');
  assert.equal(await role(page, 'summary-count').innerText(), '1');
  await role(page, 'clear-credentials').click();
  assert.equal(await role(page, 'summary-count').innerText(), '0');
  assert.equal(await role(page, 'credential-line').inputValue(), '');
  assert.equal(await role(page, 'submit').isDisabled(), true);
});

test('zero targets block creation without a selector, multiple targets require an explicit choice', async (t) => {
  const { page, state } = await fixture(t);
  assert.equal(await role(page, 'site-field').isVisible(), true);
  assert.equal(await role(page, 'site').inputValue(), '');
  assert.equal(await role(page, 'submit').isDisabled(), true);
  state.options.mySites = [];
  await role(page, 'reload').click();
  await page.waitForFunction(() => document.querySelector('[data-role="options-message"]').textContent.includes('暂无可用'));
  assert.equal(await role(page, 'site-field').isVisible(), false);
  assert.equal(await role(page, 'submit').isDisabled(), true);
});

test('a removed target is not silently replaced by the sole remaining target; explicit recovery loads its groups', async (t) => {
  const { page, state } = await fixture(t);
  await selectSite(page, SITE_A);
  state.options.mySites = [state.options.mySites[1]];
  await role(page, 'reload').click();
  await role(page, 'use-only-site').waitFor();
  assert.equal(await role(page, 'site').inputValue(), '');
  assert.equal(await role(page, 'site-field').isVisible(), false);
  assert.equal(await role(page, 'submit').isDisabled(), true);
  assert.equal(await role(page, 'groups').locator('input').count(), 0);
  await role(page, 'use-only-site').click();
  await page.waitForFunction(() => !document.querySelector('[data-role="groups-fieldset"]').disabled);
  assert.equal(await role(page, 'site').inputValue(), SITE_B);
  assert.equal(await role(page, 'groups').innerText(), '北辰专属');
});

test('group chips remove selections, selected-only filtering is exact, and desktop options share a row', async (t) => {
  const { page } = await fixture(t, { setup: ({ state }) => {
    state.groups[SITE_A].push(group(15, '第三组'), group(16, '第四组'));
  } });
  await selectSite(page); await chooseGroups(page);
  await role(page, 'only-selected').check();
  assert.equal(await role(page, 'groups').locator('input').count(), 2);
  await role(page, 'selected-groups').getByRole('button', { name: '移除分组 日常使用', exact: true }).click();
  assert.equal(await role(page, 'groups').locator('input').count(), 1);
  assert.equal(await role(page, 'group-count').innerText(), '已选 1 个');
  await role(page, 'only-selected').uncheck();
  const boxes = await role(page, 'groups').locator('label').evaluateAll((items) => items.map((item) => { const r = item.getBoundingClientRect(); return { x: r.x, y: r.y }; }));
  assert.equal(boxes[0].y, boxes[2].y);
  assert.ok(boxes[2].x > boxes[0].x);
  assert.equal((await role(page, 'groups').innerText()).includes('#'), false);
  await role(page, 'search').fill('11');
  assert.equal(await role(page, 'groups').locator('input').count(), 0);
});

for (const lost of [false, true]) {
  test(`acceptance callback fires once after secrets clear, including lookup recovery (${lost})`, async (t) => {
    const { page, state } = await fixture(t);
    if (lost) state.onSubmit = (body, _req, res) => { state.batches.set(body.requestId, { id: body.requestId, jobs: [job({ id: `${body.requestId}-0`, status: 'queued' })] }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{'); };
    await selectSite(page); await chooseGroups(page); await fill(page);
    await role(page, 'submit').click(); await waitAccepted(page);
    assert.deepEqual(await page.evaluate(() => window.accepted), [{ id: state.submissions[0].requestId, input: '' }]);
    assert.equal(state.submissions.length, 1);
    await assertNoSecrets(page);
  });
}

test('unknown or late submission results do not trigger navigation callbacks', async (t) => {
  const { page, state } = await fixture(t, { ignoreAbort: true });
  let release;
  state.onSubmit = async (_body, _req, res) => { await new Promise((resolve) => { release = resolve; }); json(res, { error: 'unavailable' }, 503); };
  await selectSite(page); await chooseGroups(page); await fill(page);
  await role(page, 'submit').click();
  await page.waitForFunction(() => document.querySelector('[data-role="credential-line"]').value === '');
  assert.deepEqual(await page.evaluate(() => window.accepted), []);
  await page.evaluate(() => window.view.deactivate());
  release(); await page.waitForTimeout(80);
  assert.deepEqual(await page.evaluate(() => window.accepted), []);
});
