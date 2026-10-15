import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { handleOAuthOnboarding } from '../src/oauth-onboarding-http.mjs';
import { onboardingError } from '../src/oauth-onboarding-store.mjs';

const BATCH = '44444444-4444-4444-8444-444444444444';
const OLD = '55555555-5555-4555-8555-555555555555';
const SITE = '11111111-1111-4111-8111-111111111111';
const OTHER_SITE = '22222222-2222-4222-8222-222222222222';
const JOB = '66666666-6666-4666-8666-666666666666';
const role = (page, name) => page.locator(`[data-role="${name}"]`);
const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data));
};
const job = (extra = {}) => ({
  id: JOB, email: 'existing@example.test', accountName: '星河账号', batchId: BATCH,
  mySiteId: '11111111-1111-4111-8111-111111111111', groupIds: [11], status: 'failed', stage: 'password',
  message: '', remoteAccountId: null, canRerun: true, createdAt: '2026-10-07T01:00:00Z',
  startedAt: '2026-10-07T01:01:00Z', finishedAt: '2026-10-07T01:02:00Z', ...extra,
});
const batch = (extra = {}) => ({ id: BATCH, createdAt: '2026-10-07T01:00:00Z', legacy: false, sourceBatchId: null, jobs: [job()], ...extra });
function summary(batch, email = '') {
  const matched = batch.jobs.filter((job) => job.email.toLowerCase().includes(email.toLowerCase()));
  const statusCounts = {};
  for (const job of batch.jobs) statusCounts[job.status] = (statusCounts[job.status] ?? 0) + 1;
  const { jobs, ...fields } = batch;
  return { ...fields, total: jobs.length, matchedCount: matched.length, statusCounts,
    canRerun: !batch.legacy && jobs.every((job) => job.canRerun && !['queued', 'running', 'pushing'].includes(job.status)) };
}
async function fixture(t, { width = 1440, pollIntervalMs = 60_000, ignoreAbort = false, focusedId = null, routePrefix = '', setup } = {}) {
  const state = {
    batches: new Map([[BATCH, batch()]]), requests: [], reruns: [], reconciles: [], errors: [],
    sites: [{ id: SITE, name: '默认目标' }, { id: OTHER_SITE, name: '另一个目标' }],
    onOptions: null, onList: null, onDetail: null, onRerun: null, onReconcile: null,
  };
  setup?.(state);
  const assets = new Map(await Promise.all(['/styles.css', '/src/oauth-onboarding.css', '/src/oauth-tasks-layout.css', '/src/client-route.mjs', '/src/oauth-tasks-view.mjs'].map(async (path) => [path, await readFile(new URL(`..${path}`, import.meta.url), 'utf8')])));
  if (routePrefix) assets.set('/src/client-route.mjs', assets.get('/src/client-route.mjs').replaceAll("'/oauth-accounts'", `'${routePrefix}/oauth-accounts'`));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/src/oauth-onboarding.css"><link rel="stylesheet" href="/src/oauth-tasks-layout.css"><style>#host{height:100vh;min-width:0}</style></head><body><main id="host" class="panel-view"></main><script type="module">
    import { mountOAuthTasks } from '/src/oauth-tasks-view.mjs';
    window.signals = []; window.fetchCalls = []; window.storageWrites = [];
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(...args) { window.storageWrites.push(args); return originalSet.apply(this, args); };
    window.view = mountOAuthTasks(document.getElementById('host'), { pollIntervalMs: ${pollIntervalMs}, fetchImpl: (path, init) => {
      window.signals.push(init.signal); window.fetchCalls.push({path, method:init.method, cache:init.cache, credentials:init.credentials});
      if (${ignoreAbort}) { const {signal, ...rest} = init; return fetch(path, rest); }
      return fetch(path, init);
    } }); window.ready = window.view.activate({ batchId: ${JSON.stringify(focusedId)} });
  </script></body></html>`;
  const service = {
    async options() { return { mySites: state.sites, proxies: [] }; },
    async listBatches({ email, before, status, mySiteId, createdFrom, createdBefore }) {
      const rows = [...state.batches.values()].filter((batch) =>
        (!email || batch.jobs.some((job) => job.email.toLowerCase().includes(email.toLowerCase())))
        && (!status || batch.jobs.some((job) => job.status === status))
        && (!mySiteId || batch.jobs[0]?.mySiteId === mySiteId)
        && (!createdFrom || Date.parse(batch.createdAt) >= Date.parse(createdFrom))
        && (!createdBefore || Date.parse(batch.createdAt) < Date.parse(createdBefore)));
      const offset = before ? rows.findIndex((batch) => batch.id === before) + 1 : 0;
      const page = rows.slice(offset, offset + 30);
      return { batches: page.map((batch) => summary(batch, email)), nextCursor: rows.length > offset + 30 ? page.at(-1).id : null };
    },
    async getBatch(id, { email = '' }) {
      const found = state.batches.get(id);
      if (!found) throw onboardingError('NOT_FOUND', '批次不存在', 404);
      return { ...summary(found, email), jobs: found.jobs.filter((job) => !email || job.email.toLowerCase().includes(email.toLowerCase())) };
    },
    async rerunBatch(id, body) { return rerun('batches', id, body); },
    async rerunJob(id, body) { return rerun('jobs', id, body); },
    async reconcile(id) {
      const found = [...state.batches.values()].find((batch) => batch.jobs.some((job) => job.id === id));
      const oldJob = found.jobs.find((job) => job.id === id);
      const updated = { ...oldJob, status: 'succeeded', stage: 'done', remoteAccountId: 91 };
      found.jobs = found.jobs.map((job) => job.id === id ? updated : job);
      return updated;
    },
  };
  function rerun(kind, id, body) {
    const source = kind === 'batches' ? state.batches.get(id) : [...state.batches.values()].find((batch) => batch.jobs.some((job) => job.id === id));
    const jobs = kind === 'batches' ? source.jobs : source.jobs.filter((job) => job.id === id);
    if (state.batches.has(body.requestId)) return state.batches.get(body.requestId);
    const created = batch({ id: body.requestId, sourceBatchId: source.id,
      jobs: jobs.map((job, index) => ({ ...job, id: `${body.requestId}-${index}`, batchId: body.requestId, sourceJobId: job.id, status: 'queued', stage: 'validating', canRerun: false, remoteAccountId: null, startedAt: null, finishedAt: null })) });
    state.batches = new Map([[created.id, created], ...state.batches]);
    return { ...summary(created), jobs: created.jobs };
  }
  state.acceptRerun = rerun;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return; }
      if (assets.has(url.pathname)) { res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(assets.get(url.pathname)); return; }
      state.requests.push({ path: url.pathname, email: url.searchParams.get('email'), before: url.searchParams.get('before'), method: req.method, status: url.searchParams.get('status'), mySiteId: url.searchParams.get('mySiteId'), createdFrom: url.searchParams.get('createdFrom') });
      if (url.pathname.endsWith('/options') && state.onOptions) return await state.onOptions(url, req, res);
      if (url.pathname.endsWith('/batches') && state.onList) return await state.onList(url, req, res);
      const detail = url.pathname.match(/\/batches\/([^/]+)$/);
      if (detail && state.onDetail) return await state.onDetail(detail[1], url, req, res);
      const action = url.pathname.match(/\/(batches|jobs)\/([^/]+)\/(rerun|reconcile)$/);
      if (action) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        if (action[3] === 'rerun') {
          state.reruns.push({ kind: action[1], id: action[2], body });
          if (state.onRerun) return await state.onRerun(action[1], action[2], body, req, res);
          return json(res, { batch: rerun(action[1], action[2], body) }, 202);
        }
        state.reconciles.push({ id: action[2], body });
        if (state.onReconcile) return await state.onReconcile(action[2], body, req, res);
        return json(res, { job: await service.reconcile(action[2]) });
      }
      await handleOAuthOnboarding(req, res, url, service);
    } catch (error) { state.errors.push(error); if (!res.headersSent) json(res, { error: 'fixture error' }, 500); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
  t.after(async () => {
    await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(state.errors, []); assert.deepEqual(pageErrors, []);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => window.ready);
  return { page, state };
}
async function expand(page, id = BATCH) {
  const batch = page.locator(`[data-batch-id="${id}"]`);
  const toggle = batch.locator('.oauth-batch-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await batch.locator('.oauth-job').first().waitFor();
  return batch;
}
async function confirm(page, button) {
  await button.click();
  assert.equal(await role(page, 'confirmation').isVisible(), true);
  assert.match(await role(page, 'confirm-message').innerText(), /创建新远端账号.*原任务及结果不明记录会保留/);
  await role(page, 'confirm').click();
}
async function accepted(page) {
  await page.waitForFunction(() => document.querySelector('[data-role="message"]').textContent.includes('新批次已接受'));
}
async function waitLookup(page) {
  await page.waitForFunction(() => !document.querySelector('[data-role="attempt"]').hidden && !document.querySelector('[data-role="lookup"]').disabled);
}

for (const width of [1440, 390]) {
  test(`batch task page ${width}px: expand, names/email/results/times, legacy read-only and safe themed layout`, async (t) => {
    const { page, state } = await fixture(t, { width, setup(state) {
      state.batches.set(OLD, batch({ id: OLD, legacy: true, jobs: [job({ id: 'legacy', email: 'legacy@example.test', accountName: '', canRerun: true })] }));
      state.batches.set(BATCH, batch({ sourceBatchId: OLD, jobs: [job({ accountName: '<img src=x onerror="window.xss=1">', message: '<script>bad()</script>', status: 'succeeded', remoteAccountId: 91, sourceJobId: 'old-job' })] }));
    } });
    const card = await expand(page);
    assert.equal(await card.locator('.oauth-batch-toggle').evaluate((element) => getComputedStyle(element, '::before').content), '"›"');
    assert.match(await card.innerText(), /<img src=x onerror="window.xss=1">/);
    assert.match(await card.innerText(), /existing@example.test/);
    assert.match(await card.innerText(), /入池成功/);
    assert.match(await card.innerText(), /远端账号 ID：91/);
    assert.match(await card.innerText(), /任务创建：.*开始：.*结束：/s);
    assert.match(await card.innerText(), /来源任务：old-job/);
    assert.doesNotMatch(await card.innerText(), /来源批次/);
    assert.equal(await page.locator('.oauth-task-page > .oauth-notice').count(), 0);
    const createLink = page.locator('[data-oauth-create-link]');
    assert.equal(await createLink.getAttribute('href'), '/oauth-accounts');
    assert.equal(await createLink.innerText(), '新建入池');
    assert.equal(await card.locator('img,script').count(), 0);
    assert.equal(await card.locator('time[datetime]').count(), 4);
    await card.locator('.oauth-batch-toggle').click();
    assert.equal(await card.locator('.oauth-job-list').isVisible(), false);
    const legacy = await expand(page, OLD);
    assert.equal(await legacy.getByRole('button', { name: '整批重跑' }).count(), 0);
    assert.equal(await legacy.getByRole('button', { name: '重跑此账号' }).count(), 0);
    assert.match(await legacy.innerText(), /历史只读/);
    assert.doesNotMatch(await legacy.innerText(), /不支持重跑|旧任务.*仅可查看/s);
    assert.equal(state.reruns.length, 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.evaluate(() => document.documentElement.style.setProperty('--green', 'rgb(23, 88, 66)'));
    assert.equal(await role(page, 'email').evaluate((element) => getComputedStyle(element).fontSize), width === 390 ? '16px' : '12px');
    if (width === 1440) {
      const positions = await card.locator('.oauth-batch-row').evaluate((row) => [...row.children].map((child) => {
        const box = child.getBoundingClientRect(); return { top: box.top, bottom: box.bottom };
      }));
      assert.ok(Math.max(...positions.map((box) => box.top)) <= Math.min(...positions.map((box) => box.bottom)), 'batch title/time/status/action share one desktop row');
    }
    await page.screenshot({ path: `/tmp/oauth-tasks-${width}.png`, fullPage: true });
    assert.deepEqual(await page.evaluate(() => window.storageWrites), []);
    assert.ok((await page.evaluate(() => window.fetchCalls)).every((call) => call.cache === 'no-store' && call.credentials === 'same-origin'));
  });
}

test('stable batch cursor pages, literal email search and filtered expansion keep older batches reachable', async (t) => {
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.clear();
    for (let i = 0; i < 65; i++) state.batches.set(`batch-${i}`, batch({ id: `batch-${i}`, jobs: [job({ id: `job-${i}`, email: `user${i}@example.test` }), job({ id: `percent-${i}`, email: `literal%_${i}@example.test` })] }));
  } });
  assert.equal(await page.locator('.oauth-batch').count(), 30);
  await role(page, 'next').click(); await page.locator('[data-batch-id="batch-30"]').waitFor();
  assert.equal(await page.locator('.oauth-batch').count(), 30);
  assert.ok(state.requests.some((req) => req.before === 'batch-29'));
  await role(page, 'next').click(); await page.locator('[data-batch-id="batch-64"]').waitFor();
  assert.equal(await page.locator('.oauth-batch').count(), 5); assert.equal(await role(page, 'next').isDisabled(), true);
  await page.evaluate(() => window.view.deactivate());
  await page.evaluate(() => window.view.activate());
  assert.match(await role(page, 'page').innerText(), /第 3 页/);
  await role(page, 'prev').click(); await page.locator('[data-batch-id="batch-30"]').waitFor();
  await role(page, 'email').fill('%_64'); await role(page, 'filter').evaluate((form) => form.requestSubmit());
  await page.locator('[data-batch-id="batch-64"]').waitFor();
  assert.equal(await page.locator('.oauth-batch').count(), 1);
  const card = await expand(page, 'batch-64');
  assert.equal(await card.locator('.oauth-job').count(), 1);
  assert.match(await card.innerText(), /匹配 1 个/);
  assert.match(await card.innerText(), /literal%_64/); assert.doesNotMatch(await card.innerText(), /user64/);
  assert.ok(state.requests.some((req) => req.email === '%_64' && !req.before));
  assert.ok(state.requests.some((req) => req.path.endsWith('/batch-64') && req.email === '%_64'));
  await role(page, 'email').fill('not-present'); await role(page, 'filter').evaluate((form) => form.requestSubmit());
  await page.getByText('没有匹配邮箱的批次。').waitFor();
  await page.evaluate(() => window.view.activate({ batchId: 'batch-64' }));
  const focused = await expand(page, 'batch-64');
  assert.equal(await focused.locator('.oauth-job').count(), 2);
  assert.equal(await role(page, 'email').inputValue(), '');
});

test('single and whole-batch rerun require explicit confirmation, send only requestId and retain old/source records', async (t) => {
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.set(BATCH, batch({ jobs: [job(), job({ id: 'second-job', email: 'second@example.test' })] }));
  } });
  const card = await expand(page);
  await card.getByRole('button', { name: '重跑此账号' }).first().click();
  assert.equal(state.reruns.length, 0);
  await role(page, 'cancel').click(); assert.equal(state.reruns.length, 0);
  await confirm(page, card.getByRole('button', { name: '重跑此账号' }).first()); await accepted(page);
  assert.equal(state.reruns.length, 1);
  const single = state.reruns[0]; assert.equal(single.kind, 'jobs'); assert.equal(single.id, JOB);
  assert.deepEqual(Object.keys(single.body), ['requestId']);
  assert.match(single.body.requestId, /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/);
  assert.equal(state.batches.get(single.body.requestId).jobs.length, 1);
  assert.equal(state.batches.get(BATCH).jobs[0].status, 'failed');
  assert.match(await role(page, 'batches').innerText(), new RegExp(`来源任务：${JOB}`));
  assert.equal(await role(page, 'refresh').isDisabled(), false);
  await page.evaluate((batchId) => window.view.activate({ batchId }), BATCH);
  await confirm(page, page.locator(`[data-batch-id="${BATCH}"]`).getByRole('button', { name: '整批重跑' })); await accepted(page);
  assert.equal(state.reruns[1].kind, 'batches'); assert.equal(state.reruns[1].id, BATCH);
  assert.notEqual(state.reruns[1].body.requestId, single.body.requestId);
  assert.equal(state.batches.get(state.reruns[1].body.requestId).jobs.length, 2);
  assert.equal(state.batches.get(BATCH).jobs.length, 2);
  assert.equal(state.requests.some((req) => req.path.includes('preferences')), false);
});

test('uncertain records permit explicit new admission but remain uncertain; running and credential-less tasks never rerun', async (t) => {
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.set(BATCH, batch({ jobs: [job({ status: 'uncertain', stage: 'pushing' }), job({ id: 'running', status: 'running', canRerun: false }), job({ id: 'no-secret', status: 'failed', canRerun: false })] }));
  } });
  const card = await expand(page);
  assert.equal(await card.getByRole('button', { name: '整批重跑' }).count(), 0);
  assert.equal(await card.getByRole('button', { name: '重跑此账号' }).count(), 0);
  assert.equal(await card.locator('[data-job-id="running"] button').count(), 0);
  assert.equal(await card.locator('[data-job-id="no-secret"] button').count(), 0);
  await confirm(page, card.getByRole('button', { name: '再次入池', exact: true })); await accepted(page);
  assert.equal(state.batches.get(BATCH).jobs[0].status, 'uncertain');
  assert.equal(state.reruns[0].kind, 'jobs'); assert.equal(state.reruns[0].id, JOB);
});

test('search does not silently turn whole-batch rerun into a partial rerun', async (t) => {
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.set(BATCH, batch({ jobs: [job(), job({ id: 'other', email: 'other@example.test' })] }));
  } });
  await role(page, 'email').fill('existing'); await role(page, 'filter').evaluate((form) => form.requestSubmit());
  const card = await expand(page);
  assert.equal(await card.locator('.oauth-job').count(), 1);
  await card.getByRole('button', { name: '整批重跑' }).click();
  assert.match(await role(page, 'confirm-message').innerText(), /整批 2 个账号（不受邮箱搜索影响）/);
  await role(page, 'confirm').click(); await accepted(page);
  assert.equal(state.batches.get(state.reruns[0].body.requestId).jobs.length, 2);
});

test('lost rerun response checks the original request batch, never automatically re-posts', async (t) => {
  const { page, state } = await fixture(t);
  state.onRerun = (kind, id, body, req, res) => { state.acceptRerun(kind, id, body); res.destroy(); };
  const card = await expand(page); await confirm(page, card.getByRole('button', { name: '整批重跑' })); await accepted(page);
  assert.equal(await page.evaluate(() => window.fetchCalls.filter((call) => call.method === 'POST').length), 1);
  assert.equal(new Set(state.reruns.map((call) => call.body.requestId)).size, 1);
  assert.equal(state.batches.size, 2);
  assert.ok(state.requests.some((req) => req.method === 'GET' && req.path.endsWith(state.reruns[0].body.requestId)));
  assert.equal(state.batches.get(BATCH).jobs[0].status, 'failed');
});

test('404 verification permits only original-key replay; non-404 cannot permit a retry or new request', async (t) => {
  const { page, state } = await fixture(t);
  state.onRerun = (kind, id, body, req, res) => json(res, { error: '结果不明' }, 503);
  const card = await expand(page); await confirm(page, card.getByRole('button', { name: '整批重跑' })); await waitLookup(page);
  await role(page, 'retry').waitFor();
  const requestId = state.reruns[0].body.requestId;
  assert.equal(await card.getByRole('button', { name: '整批重跑' }).isDisabled(), true);
  await page.evaluate(() => window.view.deactivate()); await page.evaluate(() => window.view.activate());
  await role(page, 'retry').waitFor();
  state.onRerun = null; await role(page, 'retry').click(); await accepted(page);
  assert.equal(state.reruns.length, 2); assert.equal(state.reruns[1].body.requestId, requestId);
  await page.evaluate((batchId) => window.view.activate({ batchId }), BATCH);
  state.onRerun = (kind, id, body, req, res) => json(res, { error: '暂不可用' }, 503);
  state.onDetail = (id, url, req, res) => json(res, { error: '暂不可用' }, 503);
  await confirm(page, page.locator(`[data-batch-id="${BATCH}"]`).getByRole('button', { name: '整批重跑' })); await waitLookup(page);
  assert.equal(await role(page, 'retry').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: '整批重跑' }).first().isDisabled(), true);
  const count = state.reruns.length;
  await role(page, 'lookup').click(); await waitLookup(page); assert.equal(state.reruns.length, count);
});

test('controlled snapshot/key/group refusal is displayed as text and malformed success remains query-only', async (t) => {
  const { page, state } = await fixture(t);
  const hostile = '<img src=x onerror="window.xss=1">目标或代理快照已改变，不能重跑';
  state.onRerun = (kind, id, body, req, res) => json(res, { error: hostile }, 400);
  const card = await expand(page); await confirm(page, card.getByRole('button', { name: '整批重跑' }));
  await page.getByText(hostile, { exact: true }).waitFor();
  assert.equal(await role(page, 'message').locator('img').count(), 0);
  assert.equal(await role(page, 'attempt').isVisible(), false);
  assert.equal(state.batches.size, 1);
  state.onRerun = (kind, id, body, req, res) => json(res, { batch: { id: 'wrong', jobs: [] } }, 202);
  state.onDetail = (id, url, req, res) => json(res, { error: '未知' }, 503);
  await confirm(page, card.getByRole('button', { name: '整批重跑' })); await waitLookup(page);
  assert.equal(await role(page, 'retry').isVisible(), false);
  assert.match(await role(page, 'attempt-message').innerText(), /未知/);
  assert.equal(state.reruns.length, 2);
});

test('read-only reconciliation wins over stale detail and list responses without rerun or credential payload', async (t) => {
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.set(BATCH, batch({ legacy: true, jobs: [job({ status: 'uncertain', message: '<img src=x onerror="window.xss=1">' })] }));
  } });
  const card = await expand(page);
  let oldDetail;
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  state.onDetail = (id, url, req, res) => { oldDetail = res; started(); };
  await role(page, 'refresh').click(); await pending;
  await card.getByRole('button', { name: '只读对账' }).click();
  await page.getByText('远端账号 ID：91').waitFor();
  json(oldDetail, { batch: { ...summary(state.batches.get(BATCH)), jobs: [job({ status: 'uncertain' })] } });
  await page.waitForTimeout(100);
  assert.match(await card.innerText(), /入池成功/);
  assert.equal(await card.locator('img').count(), 0);
  assert.deepEqual(state.reconciles, [{ id: JOB, body: {} }]); assert.equal(state.reruns.length, 0);
  assert.equal(await role(page, 'refresh').isDisabled(), false);
});

test('search generations isolate out-of-order list/detail success and errors even if transport ignores AbortSignal', async (t) => {
  const { page, state } = await fixture(t, { ignoreAbort: true });
  let staleList;
  state.onList = (url, req, res) => {
    if (url.searchParams.get('email') === 'old') { staleList = res; return; }
    return json(res, { batches: [summary(batch({ id: OLD, jobs: [job({ email: 'new@example.test' })] }))], nextCursor: null });
  };
  await role(page, 'email').fill('old'); await role(page, 'filter').evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(30);
  await role(page, 'email').fill('new'); await role(page, 'filter').evaluate((form) => form.requestSubmit());
  await page.locator(`[data-batch-id="${OLD}"]`).waitFor();
  json(staleList, { batches: [summary(batch())], nextCursor: BATCH }); await page.waitForTimeout(60);
  assert.equal(await page.locator(`[data-batch-id="${BATCH}"]`).count(), 0);
  assert.equal(await role(page, 'next').isDisabled(), true);
  state.batches.set(OLD, batch({ id: OLD, jobs: [job({ email: 'new@example.test' })] }));
  let staleDetail;
  state.onDetail = (id, url, req, res) => { staleDetail = res; };
  await page.locator(`[data-batch-id="${OLD}"] .oauth-batch-toggle`).click(); await page.waitForTimeout(30);
  await role(page, 'email').fill('latest'); await role(page, 'filter').evaluate((form) => form.requestSubmit());
  json(staleDetail, { error: 'stale-detail-error' }, 400); await page.waitForTimeout(80);
  assert.equal((await role(page, 'message').innerText()).includes('stale-detail-error'), false);
});

test('deactivate/pagehide stop polls, abort reads and prevent stale state after remount; destroy removes listener and UI', async (t) => {
  const { page, state } = await fixture(t, { ignoreAbort: true, pollIntervalMs: 80 });
  let stale;
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  state.onList = (url, req, res) => { stale = res; started(); };
  await pending;
  await page.evaluate(() => window.view.deactivate());
  assert.equal(await page.evaluate(() => window.signals.at(-1).aborted), true);
  const count = state.requests.length;
  await page.waitForTimeout(180); assert.equal(state.requests.length, count);
  state.onList = null;
  await page.evaluate(() => window.view.activate());
  json(stale, { batches: [summary(batch({ id: OLD }))], nextCursor: OLD }); await page.waitForTimeout(50);
  assert.equal(await page.locator(`[data-batch-id="${OLD}"]`).count(), 0);
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  const afterHide = state.requests.length; await page.waitForTimeout(180); assert.equal(state.requests.length, afterHide);
  await page.evaluate(() => window.view.destroy()); assert.equal(await page.locator('.oauth-task-page').count(), 0);
  assert.equal(state.reruns.length, 0); assert.deepEqual(await page.evaluate(() => window.storageWrites), []);
});

test('navigation during rerun aborts transport, preserves original request and verifies once on return', async (t) => {
  const { page, state } = await fixture(t, { ignoreAbort: true });
  let response;
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  state.onRerun = (kind, id, body, req, res) => { state.acceptRerun(kind, id, body); response = res; started(); };
  const card = await expand(page); await confirm(page, card.getByRole('button', { name: '整批重跑' })); await pending;
  await page.evaluate(() => window.view.deactivate());
  assert.equal(await page.evaluate(() => window.signals.at(-1).aborted), true);
  json(response, { batch: { ...summary(state.batches.get(state.reruns[0].body.requestId)), jobs: state.batches.get(state.reruns[0].body.requestId).jobs } }, 202);
  await page.waitForTimeout(50);
  await page.evaluate(() => window.view.activate()); await accepted(page);
  assert.equal(state.reruns.length, 1);
  assert.ok(state.requests.some((req) => req.method === 'GET' && req.path.endsWith(state.reruns[0].body.requestId)));
});

test('all public statuses have Chinese labels and task times tolerate legacy null values', async (t) => {
  const { page } = await fixture(t, { focusedId: BATCH, setup(state) {
    state.batches.set(BATCH, batch({ legacy: true, jobs: ['queued', 'running', 'pushing', 'succeeded', 'failed', 'needs_attention', 'uncertain'].map((status, index) => job({ id: `status-${index}`, status, startedAt: null, finishedAt: null })) }));
  } });
  for (const label of ['排队中', '登录授权中', '正在入池', '入池成功', '任务失败', '需要人工处理', '结果不明']) assert.ok((await role(page, 'batches').innerText()).includes(label));
  assert.match(await role(page, 'batches').innerText(), /开始：—/);
  assert.match(await role(page, 'batches').innerText(), /结束：—/);
});

test('definite pre-admission rejection releases the intent and leaves unrelated tasks usable', async (t) => {
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.set(OLD, batch({ id: OLD, jobs: [job({ id: 'other-job', batchId: OLD, email: 'other@example.test' })] }));
  } });
  for (const [status, code] of [[409, 'PROXY_CHANGED'], [409, 'CREDENTIALS_UNAVAILABLE'], [503, 'CREDENTIAL_KEY_UNAVAILABLE'], [409, 'ACCOUNT_BUSY']]) {
    state.onRerun = (kind, id, body, req, res) => json(res, { code, error: `未接收：${code}` }, status);
    await confirm(page, page.locator(`[data-batch-id="${BATCH}"]`).getByRole('button', { name: '整批重跑' }));
    await page.getByText(`未接收：${code}`, { exact: true }).waitFor();
    assert.equal(await role(page, 'attempt').isVisible(), false);
    assert.equal(await page.locator(`[data-batch-id="${OLD}"]`).getByRole('button', { name: '整批重跑' }).isDisabled(), false);
    const rejectedId = state.reruns.at(-1).body.requestId;
    assert.equal(state.requests.some(req => req.path.endsWith(rejectedId)), false);
  }
  await page.evaluate(() => window.view.deactivate()); await page.evaluate(() => window.view.activate());
  state.onRerun = null;
  await confirm(page, page.locator(`[data-batch-id="${OLD}"]`).getByRole('button', { name: '整批重跑' }));
  await accepted(page);
  assert.equal(state.batches.size, 3);
  assert.equal(new Set(state.reruns.map(call => call.body.requestId)).size, 5);
});

test('a rejected retry cannot erase the original ambiguous delivery or mint another request ID', async (t) => {
  const { page, state } = await fixture(t);
  state.onRerun = (kind, id, body, req, res) => json(res, { error: '未知提交结果' }, 503);
  await confirm(page, page.locator(`[data-batch-id="${BATCH}"]`).getByRole('button', { name: '整批重跑' }));
  await role(page, 'retry').waitFor();
  const requestId = state.reruns[0].body.requestId;
  state.onRerun = (kind, id, body, req, res) => json(res, { code: 'PROXY_CHANGED', error: '代理已变化' }, 409);
  await role(page, 'retry').click();
  await page.waitForFunction(() => document.querySelector('[data-role="retry"]').hidden === false && !document.querySelector('[data-role="retry"]').disabled);
  assert.equal(await role(page, 'attempt').isVisible(), true);
  assert.equal(state.reruns.length, 2);
  assert.equal(state.reruns[1].body.requestId, requestId);
  assert.equal(await page.locator(`[data-batch-id="${BATCH}"]`).getByRole('button', { name: '整批重跑' }).isDisabled(), true);
  state.onRerun = null; await role(page, 'retry').click(); await accepted(page);
  assert.equal(new Set(state.reruns.map(call => call.body.requestId)).size, 1);
  assert.equal(state.batches.size, 2);
});


test('successful batch and account reruns stay secondary but require the original explicit confirmation', async (t) => {
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.set(BATCH, batch({ jobs: [job({ status: 'succeeded', stage: 'done', remoteAccountId: 91 })] }));
  } });
  const card = await expand(page);
  assert.match(await card.getByRole('button', { name: '整批重跑' }).getAttribute('class'), /oauth-rerun-subtle/);
  assert.match(await card.getByRole('button', { name: '重跑此账号' }).getAttribute('class'), /oauth-rerun-subtle/);
  await card.getByRole('button', { name: '整批重跑' }).click();
  assert.equal(state.reruns.length, 0);
  assert.match(await role(page, 'confirm-message').innerText(), /创建新远端账号/);
  await role(page, 'cancel').click();
  await confirm(page, card.getByRole('button', { name: '重跑此账号' }));
  await accepted(page);
  assert.equal(state.reruns.length, 1);
});

test('page summary does not imply global totals and last refresh survives a failed list read', async (t) => {
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.clear();
    for (let i = 0; i < 31; i++) state.batches.set(`batch-${i}`, batch({ id: `batch-${i}`, jobs: [job({ id: `job-${i}`, email: `user${i}@example.test` })] }));
  } });
  assert.equal(await role(page, 'summary').innerText(), '本页 30 批 · 30 个账号');
  const updated = await role(page, 'updated').getAttribute('datetime');
  assert.ok(updated && Number.isFinite(Date.parse(updated)));
  state.onList = (url, req, res) => json(res, { error: '读取失败' }, 503);
  await role(page, 'refresh').click();
  await page.getByText('读取失败', { exact: true }).waitFor();
  assert.equal(await role(page, 'updated').getAttribute('datetime'), updated);
  assert.equal(await role(page, 'summary').innerText(), '列表未读取成功 · 筛选结果不可用');
  assert.equal(await page.locator('.oauth-batch').count(), 0);
  state.onList = null;
  await role(page, 'email').fill('user30@');
  await role(page, 'filter').evaluate((form) => form.requestSubmit());
  await page.locator('[data-batch-id="batch-30"]').waitFor();
  assert.equal(await role(page, 'summary').innerText(), '邮箱全量检索 · 本页 1 批 · 1 个账号 · 匹配 1 个');
  assert.match(await role(page, 'page').innerText(), /第 1 页/);
  assert.ok(state.requests.some((req) => req.email === 'user30@' && !req.before));
});

test('focused batch stays expanded outside the first cursor page and is excluded from page totals', async (t) => {
  const { page, state } = await fixture(t, { focusedId: 'batch-34', setup(state) {
    state.batches.clear();
    for (let i = 0; i < 35; i++) state.batches.set(`batch-${i}`, batch({ id: `batch-${i}`, jobs: [job({ id: `job-${i}` })] }));
  } });
  const focused = page.locator('[data-batch-id="batch-34"]');
  assert.equal(await focused.locator('.oauth-batch-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await focused.locator('.oauth-job').count(), 1);
  assert.equal(await page.locator('.oauth-batch').count(), 31);
  assert.equal(await role(page, 'summary').innerText(), '本页 30 批 · 30 个账号 · 另定位 1 批（不计入本页）');
  await role(page, 'refresh').click();
  await page.waitForFunction(() => !document.querySelector('[data-role="refresh"]').disabled);
  assert.equal(await focused.locator('.oauth-job').count(), 1);
  assert.equal(state.reruns.length, 0);
});


test('state/site/time filtering reaches batches beyond the current page and resets cursor on every filter change', async (t) => {
  const recent = new Date(Date.now() - 60 * 60_000).toISOString();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.clear();
    for (let i = 0; i < 35; i++) state.batches.set(`other-${i}`, batch({ id: `other-${i}`, createdAt: recent,
      jobs: [job({ id: `other-job-${i}`, status: 'succeeded' })] }));
    state.batches.set('recent-target', batch({ id: 'recent-target', createdAt: recent,
      jobs: [job({ id: 'matching-job', status: 'failed', mySiteId: OTHER_SITE }), job({ id: 'mixed-job', status: 'succeeded', mySiteId: OTHER_SITE })] }));
    state.batches.set('old-target', batch({ id: 'old-target', createdAt: old, jobs: [job({ mySiteId: OTHER_SITE })] }));
    state.batches.set('recent-other', batch({ id: 'recent-other', createdAt: recent }));
  } });
  assert.equal(await page.locator('[data-batch-id="recent-target"]').count(), 0);
  await role(page, 'next').click(); await page.locator('[data-batch-id="other-30"]').waitFor();
  await role(page, 'status').selectOption('failed');
  await page.locator('[data-batch-id="recent-target"]').waitFor();
  assert.match(await role(page, 'page').innerText(), /第 1 页/);
  assert.equal(await page.locator('.oauth-batch').count(), 3);
  await role(page, 'period').selectOption('7');
  await page.locator('[data-batch-id="old-target"]').waitFor({ state: 'detached' });
  await role(page, 'site').selectOption(OTHER_SITE);
  await page.waitForFunction(() => document.querySelectorAll('.oauth-batch').length === 1 && !document.querySelector('[data-role="refresh"]').disabled);
  assert.equal(await page.locator('[data-batch-id="recent-target"]').count(), 1);
  assert.equal(await role(page, 'summary').innerText(), '服务端全量筛选 · 本页 1 批 · 2 个账号');
  const req = state.requests.filter((req) => req.path.endsWith('/batches')).at(-1);
  assert.equal(req.status, 'failed'); assert.equal(req.mySiteId, OTHER_SITE); assert.equal(req.before, null);
  assert.ok(Math.abs(Date.parse(req.createdFrom) - (Date.now() - 7 * 86_400_000)) < 5000);
  const card = await expand(page, 'recent-target');
  assert.equal(await card.locator('.oauth-job').count(), 2, 'status filters batch presence, not detail job membership');
  await card.getByRole('button', { name: '整批重跑' }).click();
  assert.equal(state.reruns.length, 0);
  assert.match(await role(page, 'confirm-message').innerText(), /整批 2 个账号.*列表筛选不改变整批重跑范围/);
});

test('time cutoff remains stable during filtered cursor pagination and refresh', async (t) => {
  const recent = new Date(Date.now() - 60_000).toISOString();
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.clear();
    for (let i = 0; i < 35; i++) state.batches.set(`recent-${i}`, batch({ id: `recent-${i}`, createdAt: recent }));
  } });
  await role(page, 'period').selectOption('1');
  await page.waitForFunction(() => !document.querySelector('[data-role="refresh"]').disabled);
  const from = state.requests.filter((req) => req.path.endsWith('/batches')).at(-1).createdFrom;
  await role(page, 'next').click(); await page.locator('[data-batch-id="recent-34"]').waitFor();
  assert.equal(state.requests.filter((req) => req.path.endsWith('/batches')).at(-1).createdFrom, from);
  await role(page, 'refresh').click(); await page.waitForFunction(() => !document.querySelector('[data-role="refresh"]').disabled);
  assert.equal(state.requests.filter((req) => req.path.endsWith('/batches')).at(-1).createdFrom, from);
  assert.equal(await page.locator('.oauth-batch').count(), 5);
});

test('a failed real filter shows an error rather than unfiltered or fabricated empty results', async (t) => {
  const { page, state } = await fixture(t);
  state.onList = (url, req, res) => json(res, { error: '筛选暂时失败' }, 503);
  await role(page, 'status').selectOption('uncertain');
  await page.getByText('筛选暂时失败', { exact: true }).waitFor();
  assert.equal(await page.locator('.oauth-batch').count(), 0);
  assert.equal(await role(page, 'summary').innerText(), '列表未读取成功 · 筛选结果不可用');
  assert.equal(await page.getByText('没有符合筛选条件的批次。', { exact: true }).count(), 0);
  assert.equal(await role(page, 'next').isDisabled(), true);
  state.onList = null;
  await role(page, 'refresh').click(); await page.getByText('没有符合筛选条件的批次。', { exact: true }).waitFor();
  assert.equal(await role(page, 'status').inputValue(), 'uncertain');
  assert.ok(state.requests.filter((req) => req.path.endsWith('/batches') && req.status === 'uncertain').length >= 2);
});

test('options failure disables site filtering without fake candidates and refresh can recover', async (t) => {
  const { page, state } = await fixture(t, { setup(state) {
    state.onOptions = (url, req, res) => json(res, { error: '站点读取失败' }, 503);
  } });
  assert.equal(await role(page, 'site').isDisabled(), true);
  assert.equal(await role(page, 'site-filter').isVisible(), true);
  assert.equal(await role(page, 'options-message').innerText(), '站点读取失败');
  assert.equal(await role(page, 'site').locator('option').count(), 1);
  assert.equal(await page.locator('.oauth-batch').count(), 1, 'independent list read is still real server data');
  state.onOptions = null;
  await role(page, 'refresh').click(); await page.waitForFunction(() => !document.querySelector('[data-role="site"]').disabled);
  assert.equal(await role(page, 'site').locator('option').count(), 3);
  await role(page, 'site').selectOption(SITE);
  await page.waitForFunction(() => !document.querySelector('[data-role="refresh"]').disabled);
  state.sites = [{ id: OTHER_SITE, name: '另一个目标' }];
  await role(page, 'refresh').click(); await page.waitForFunction(() => !document.querySelector('[data-role="site"]').disabled);
  assert.equal(await role(page, 'site').inputValue(), SITE);
  assert.equal(await role(page, 'site').locator('option:checked').innerText(), '已选站点（当前不可用）');
  assert.equal(state.requests.filter((req) => req.path.endsWith('/batches')).at(-1).mySiteId, SITE);
});

test('focused activation clears every old filter and pending debounce without hiding or narrowing the new batch', async (t) => {
  const { page, state } = await fixture(t);
  await role(page, 'status').selectOption('succeeded');
  await role(page, 'period').selectOption('1');
  await role(page, 'site').selectOption(OTHER_SITE);
  await role(page, 'email').fill('not-this-batch');
  await page.evaluate((id) => window.view.activate({ batchId: id }), BATCH);
  const focused = page.locator(`[data-batch-id="${BATCH}"]`);
  assert.equal(await focused.locator('.oauth-job').count(), 1);
  assert.equal(await focused.locator('.oauth-batch-toggle').getAttribute('aria-expanded'), 'true');
  for (const name of ['email', 'status', 'period', 'site']) assert.equal(await role(page, name).inputValue(), '');
  await page.waitForTimeout(300);
  assert.equal(await focused.locator('.oauth-job').count(), 1);
  const req = state.requests.filter((req) => req.path.endsWith('/batches')).at(-1);
  for (const name of ['email', 'status', 'mySiteId', 'createdFrom', 'before']) assert.equal(req[name], null);
});

test('filter versions ignore out-of-order failed status reads even when transport does not honor abort', async (t) => {
  const { page, state } = await fixture(t, { ignoreAbort: true });
  const pending = [];
  state.onList = (url, req, res) => { pending.push({ status: url.searchParams.get('status'), res }); };
  await role(page, 'status').selectOption('uncertain');
  await page.waitForFunction(() => window.fetchCalls.some((call) => call.path.includes('status=uncertain')));
  while (!pending.length) await new Promise((resolve) => setTimeout(resolve, 5));
  await role(page, 'status').selectOption('failed');
  while (pending.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  json(pending[1].res, { batches: [summary(state.batches.get(BATCH))], nextCursor: null });
  await page.locator(`[data-batch-id="${BATCH}"]`).waitFor();
  json(pending[0].res, { error: '过期的筛选失败' }, 503);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.oauth-batch').count(), 1);
  assert.equal(await role(page, 'message').innerText(), '');
  assert.equal(await role(page, 'summary').innerText(), '服务端全量筛选 · 本页 1 批 · 1 个账号');
});

test('new onboarding link uses rewritten APP_PATHS under the production upstream prefix', async (t) => {
  const { page } = await fixture(t, { routePrefix: '/upstream' });
  assert.equal(await page.locator('[data-oauth-create-link]').getAttribute('href'), '/upstream/oauth-accounts');
});

for (const width of [1440, 390]) {
  test(`mixed seven-state batches ${width}px: compact grouped summary, precise expanded statuses and controlled layout`, async (t) => {
    const states = ['queued', 'running', 'pushing', 'succeeded', 'failed', 'needs_attention', 'uncertain'];
    const { page } = await fixture(t, { width, setup(state) {
      state.batches.set(BATCH, batch({ jobs: states.map((status, index) => job({ id: `mixed-${index}`, status })) }));
      state.batches.set(OLD, batch({ id: OLD, jobs: ['succeeded', 'failed', 'needs_attention', 'uncertain'].map((status, index) => job({ id: `terminal-${index}`, status })) }));
    } });
    if (width === 1440) await page.locator('#host').evaluate((host) => { host.style.width = 'calc(100vw - 240px)'; });
    const card = page.locator(`[data-batch-id="${BATCH}"]`);
    const counts = card.locator('.oauth-batch-counts');
    assert.deepEqual(await counts.locator('.oauth-status').allTextContents(), ['待对账 1', '需处理 2', '进行中 3', '成功 1']);
    const exact = await counts.getAttribute('aria-label');
    for (const label of ['排队中', '登录授权中', '正在入池', '入池成功', '任务失败', '需要人工处理', '结果不明']) assert.ok(exact.includes(label));
    assert.equal(await card.getByRole('button', { name: '整批重跑' }).count(), 0);
    const terminal = page.locator(`[data-batch-id="${OLD}"]`);
    assert.equal(await terminal.getByRole('button', { name: '整批重跑' }).count(), 1);
    if (width === 1440) {
      for (const current of [card, terminal]) {
        const boxes = await current.locator('.oauth-batch-row').evaluate((row) => [...row.children, ...row.querySelectorAll('.oauth-batch-counts .oauth-status')].map((child) => {
          const box = child.getBoundingClientRect(); return { top: box.top, bottom: box.bottom };
        }));
        assert.ok(Math.max(...boxes.map((box) => box.top)) <= Math.min(...boxes.map((box) => box.bottom)), 'all status pills/title/time/actions remain on one main desktop line');
        assert.equal(await current.locator('.oauth-batch-counts').evaluate((element) => getComputedStyle(element).flexWrap), 'nowrap');
        assert.ok(await current.locator('.oauth-batch-row').evaluate((row) => row.scrollWidth <= row.clientWidth + 1));
      }
    }
    await expand(page);
    assert.equal(await card.locator('.oauth-job').count(), 7);
    for (const label of ['排队中', '登录授权中', '正在入池', '入池成功', '任务失败', '需要人工处理', '结果不明']) assert.ok((await card.locator('.oauth-job-list').innerText()).includes(label));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `/tmp/oauth-tasks-mixed-${width}.png`, fullPage: true });
  });
}

test('accepted rerun clears all active filters so its queued batch cannot be hidden on refresh', async (t) => {
  const recent = new Date(Date.now() - 60_000).toISOString();
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.set(BATCH, batch({ createdAt: recent }));
  } });
  await role(page, 'status').selectOption('failed');
  await role(page, 'period').selectOption('7');
  await role(page, 'site').selectOption(SITE);
  await role(page, 'email').fill('existing');
  await role(page, 'filter').evaluate((form) => form.requestSubmit());
  await page.locator(`[data-batch-id="${BATCH}"]`).waitFor();
  await confirm(page, page.locator(`[data-batch-id="${BATCH}"]`).getByRole('button', { name: '整批重跑' }));
  await accepted(page);
  const id = state.reruns[0].body.requestId;
  for (const name of ['email', 'status', 'period', 'site']) assert.equal(await role(page, name).inputValue(), '');
  await role(page, 'refresh').click();
  await page.waitForFunction(() => !document.querySelector('[data-role="refresh"]').disabled);
  const card = page.locator(`[data-batch-id="${id}"]`);
  assert.equal(await card.locator('.oauth-job').count(), 1);
  assert.equal(await card.locator('.oauth-batch-toggle').getAttribute('aria-expanded'), 'true');
  const request = state.requests.filter((req) => req.path.endsWith('/batches')).at(-1);
  for (const name of ['email', 'status', 'mySiteId', 'createdFrom', 'before']) assert.equal(request[name], null);
});


for (const count of [0, 1]) {
  test(`${count} available sites hide an unused site filter without auto-filtering out historical targets`, async (t) => {
    const { page, state } = await fixture(t, { setup(state) {
      state.sites = count ? [{ id: SITE, name: '唯一候选' }] : [];
      state.batches.set(OLD, batch({ id: OLD, jobs: [job({ id: 'historical-site-job', mySiteId: OTHER_SITE })] }));
    } });
    assert.equal(await role(page, 'site-filter').isVisible(), false);
    assert.equal(await role(page, 'site').inputValue(), '');
    assert.equal(await role(page, 'clear-site').isVisible(), false);
    assert.equal(await page.locator('.oauth-batch').count(), 2);
    assert.ok(state.requests.filter((req) => req.path.endsWith('/batches')).every((req) => req.mySiteId === null));
    await role(page, 'refresh').click();
    await page.waitForFunction(() => !document.querySelector('[data-role="refresh"]').disabled && !document.querySelector('[data-role="site"]').disabled);
    assert.equal(await role(page, 'site-filter').isVisible(), false);
    assert.equal(await page.locator(`[data-batch-id="${OLD}"]`).count(), 1);
    assert.equal(state.requests.filter((req) => req.path.endsWith('/batches')).at(-1).mySiteId, null);
  });

  test(`${count} remaining sites preserve a selected historical filter until explicit clearing`, async (t) => {
    const { page, state } = await fixture(t, { setup(state) {
      state.batches.set(OLD, batch({ id: OLD, jobs: [job({ id: 'other-site-job', mySiteId: OTHER_SITE })] }));
    } });
    await role(page, 'site').selectOption(SITE);
    await page.waitForFunction(() => !document.querySelector('[data-role="refresh"]').disabled);
    state.sites = count ? [{ id: OTHER_SITE, name: '唯一剩余站点' }] : [];
    await role(page, 'refresh').click();
    await page.waitForFunction(() => !document.querySelector('[data-role="refresh"]').disabled && !document.querySelector('[data-role="site"]').disabled);
    assert.equal(await role(page, 'site-filter').isVisible(), true);
    assert.equal(await role(page, 'site').inputValue(), SITE);
    assert.equal(await role(page, 'site').locator('option:checked').innerText(), '已选站点（当前不可用）');
    assert.equal(await role(page, 'clear-site').isVisible(), true);
    assert.equal(state.requests.filter((req) => req.path.endsWith('/batches')).at(-1).mySiteId, SITE);
    assert.equal(await page.locator('.oauth-batch').count(), 1);
    await role(page, 'clear-site').click();
    await page.waitForFunction(() => !document.querySelector('[data-role="refresh"]').disabled);
    assert.equal(await role(page, 'site-filter').isVisible(), false);
    assert.equal(await role(page, 'site').inputValue(), '');
    assert.equal(await page.locator('.oauth-batch').count(), 2);
    assert.equal(state.requests.filter((req) => req.path.endsWith('/batches')).at(-1).mySiteId, null);
    assert.equal(state.reruns.length, 0);
  });
}

test('failed site refresh preserves the filter and provides explicit clearing even while the selector is disabled', async (t) => {
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.set(OLD, batch({ id: OLD, jobs: [job({ id: 'other-site-job', mySiteId: OTHER_SITE })] }));
  } });
  await role(page, 'site').selectOption(SITE);
  await page.waitForFunction(() => !document.querySelector('[data-role="refresh"]').disabled);
  state.onOptions = (url, req, res) => json(res, { error: '站点候选刷新失败' }, 503);
  await role(page, 'refresh').click();
  await page.getByText('站点候选刷新失败', { exact: true }).waitFor();
  assert.equal(await role(page, 'site-filter').isVisible(), true);
  assert.equal(await role(page, 'site').isDisabled(), true);
  assert.equal(await role(page, 'site').inputValue(), SITE);
  assert.equal(await role(page, 'clear-site').isEnabled(), true);
  assert.equal(state.requests.filter((req) => req.path.endsWith('/batches')).at(-1).mySiteId, SITE);
  await role(page, 'clear-site').click();
  await page.waitForFunction(() => !document.querySelector('[data-role="refresh"]').disabled);
  assert.equal(await role(page, 'site-filter').isVisible(), true, 'failure keeps the recovery control visible');
  assert.equal(await role(page, 'site').inputValue(), '');
  assert.equal(await page.locator('.oauth-batch').count(), 2);
  assert.equal(state.requests.filter((req) => req.path.endsWith('/batches')).at(-1).mySiteId, null);
  state.onOptions = null; state.sites = [{ id: SITE, name: '唯一候选' }];
  await role(page, 'refresh').click();
  await page.waitForFunction(() => !document.querySelector('[data-role="site"]').disabled);
  assert.equal(await role(page, 'site-filter').isVisible(), false);
  assert.equal(await role(page, 'options-message').innerText(), '');
});

test('same-job automatic retry remains active, displays bounded waiting progress and cannot be manually replayed', async (t) => {
  const { page, state } = await fixture(t, { setup(state) {
    state.batches.set(BATCH, batch({ jobs: [job({ status: 'running', stage: 'retry_wait', finishedAt: null, canRerun: false,
      message: '遇到访问挑战，等待 15 秒后自动从头重试一次（1/1）' })] }));
  } });
  const card = await expand(page);
  assert.match(await card.innerText(), /等待自动重试/);
  assert.match(await card.innerText(), /15 秒.*1\/1/);
  assert.equal(await card.getByRole('button', { name: '整批重跑' }).count(), 0);
  assert.equal(await card.getByRole('button', { name: '重跑此账号' }).count(), 0);
  assert.equal(await page.locator('.oauth-batch').count(), 1);
  assert.equal(state.reruns.length, 0);
});
