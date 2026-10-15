import { APP_PATHS } from './client-route.mjs';

const API = '/api/oauth-onboarding';
const STATUS = {
  queued: '排队中', running: '登录授权中', pushing: '正在入池', succeeded: '入池成功',
  failed: '任务失败', needs_attention: '需要人工处理', uncertain: '结果不明 · 待对账',
};
const STAGE = {
  retry_wait: '等待自动重试', validating: '校验账号与分组', proxy: '准备代理', warmup: '建立 HTTP 会话', csrf: '初始化登录会话',
  authorizing: '开始协议授权', email: '验证账号', password: '验证密码', totp: '验证 TOTP', consent: '确认授权',
  exchanging: '兑换授权凭证', pushing: '创建生产账号', done: '已完成',
};
const TERMINAL = new Set(['succeeded', 'failed', 'needs_attention', 'uncertain']);
// These local service errors are raised before a new batch is committed, not by an upstream write.
const REJECTED_BEFORE_ADMISSION = new Set([
  'INVALID_INPUT', 'JOB_NOT_FOUND', 'LEGACY_TASK_READ_ONLY', 'CREDENTIAL_KEY_UNAVAILABLE',
  'CREDENTIALS_UNAVAILABLE', 'BATCH_SNAPSHOT_MISMATCH', 'TARGET_UNAVAILABLE', 'TARGET_INSECURE',
  'TARGET_CHANGED', 'PROXY_UNAVAILABLE', 'PROXY_CHANGED', 'GROUP_UNAVAILABLE',
  'ATOMIC_PROTECTION_UNSUPPORTED', 'ATOMIC_SCHEDULABLE_UNSUPPORTED', 'ACCOUNT_BUSY', 'CAPACITY',
  'INVALID_CREDENTIALS', 'INVALID_IMPORT_OPTIONS', 'SHUTTING_DOWN',
]);
let mountNumber = 0;
class ControlledError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
function errorText(error, fallback) { return error instanceof ControlledError ? error.message : fallback; }
function node(document, tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = String(text);
  return element;
}

/** 独立批次任务页。重跑意图仅留非秘密 requestId/来源；离页取消传输，不取消已接受任务。 */
export function mountOAuthTasks(container, { fetchImpl = fetch, pollIntervalMs = 3000 } = {}) {
  const document = container.ownerDocument;
  const window = document.defaultView;
  const prefix = `oauth-tasks-${++mountNumber}`;
  const root = node(document, 'section', 'oauth-onboarding oauth-task-page');
  root.hidden = true;
  root.innerHTML = `
    <header class="oauth-heading"><div><p class="eyebrow">OPENAI OAUTH / TASKS</p><h2>入池任务</h2></div><a class="primary-action oauth-create-link" href="${APP_PATHS.oauthAccounts}" data-oauth-create-link>新建入池</a></header>
    <section class="oauth-card">
      <form data-role="filter" class="oauth-task-toolbar">
        <label class="oauth-search-label">搜索邮箱<input data-role="email" type="search" autocomplete="off" maxlength="254" placeholder="搜索全部批次的邮箱"></label>
        <label class="oauth-task-filter-label">包含任务状态<select data-role="status"><option value="">全部状态</option></select></label>
        <label class="oauth-task-filter-label">批次创建时间<select data-role="period"><option value="">全部时间</option><option value="1">最近 24 小时</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option></select></label>
        <div data-role="site-filter" class="oauth-task-filter-label"><label for="${prefix}-site">目标站点</label><div class="oauth-task-site-control"><select id="${prefix}-site" data-role="site" disabled><option value="">正在加载站点…</option></select><button data-role="clear-site" class="text-button" type="button" aria-label="清空站点筛选" hidden>清空</button></div></div>
        <button class="secondary-action" type="submit">搜索</button><button data-role="refresh" class="text-button" type="button">刷新任务</button>
      </form>
      <p data-role="options-message" class="oauth-feedback" role="status" aria-live="polite"></p>
      <div class="oauth-task-list-meta"><p data-role="summary" class="oauth-muted"></p><time data-role="updated" class="oauth-muted">尚未刷新</time></div>
      <p class="oauth-feedback" data-role="message" role="status" aria-live="polite"></p>
      <section data-role="confirmation" class="oauth-rerun-confirmation" aria-label="确认重跑" hidden><h3>确认再次入池</h3><p data-role="confirm-message"></p><div class="oauth-actions"><button data-role="confirm" type="button" class="primary-action">确认创建新任务</button><button data-role="cancel" type="button" class="secondary-action">取消</button></div></section>
      <div data-role="attempt" class="oauth-current" hidden><p data-role="attempt-message" role="status" aria-live="polite"></p><div class="oauth-actions"><button data-role="lookup" type="button" class="secondary-action">查询本次重跑</button><button data-role="retry" type="button" class="secondary-action" hidden>使用同一请求重试</button></div></div>
      <div data-role="batches" class="oauth-batch-list"></div>
      <nav class="oauth-actions oauth-pagination" aria-label="批次分页"><button data-role="prev" class="secondary-action" type="button">上一页</button><span data-role="page" class="oauth-muted"></span><button data-role="next" class="secondary-action" type="button">下一页</button></nav>
    </section>`;
  container.append(root);
  const refs = Object.fromEntries([...root.querySelectorAll('[data-role]')].map((element) => [element.dataset.role, element]));
  for (const [value, label] of Object.entries(STATUS)) {
    const option = node(document, 'option', '', label); option.value = value; refs.status.append(option);
  }
  const requests = new Set();
  const details = new Map();
  const detailVersions = new Map();
  const expanded = new Set();
  const reconciling = new Set();
  const interval = Math.max(25, Number(pollIntervalMs) || 3000);
  let active = false;
  let destroyed = false;
  let generation = 0;
  let readGeneration = 0;
  let listVersion = 0;
  let timer;
  let searchTimer;
  let email = '';
  let status = '';
  let mySiteId = '';
  let createdFrom = null;
  let listFailed = false;
  let optionsVersion = 0;
  let siteCount = null;
  let optionsFailed = false;
  let cursors = [null];
  let nextCursor = null;
  let batches = [];
  let focusedId = null;
  let loading = false;
  let confirmation = null;
  let attempt = null;
  let sending = false;
  let checking = false;
  let updatedAt = null;
  let retryAllowed = false;

  function current(version) { return active && !destroyed && generation === version; }
  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetchImpl(`${API}${path}`, {
        method, signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new ControlledError(response.status, typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : '请求未完成，请稍后查询。', data?.code);
      return data;
    } finally { window.clearTimeout(timeout); requests.delete(controller); }
  }
  function query() { return email ? `?email=${encodeURIComponent(email)}` : ''; }
  function validBatch(batch, id) {
    return batch?.id === id && Array.isArray(batch.jobs) && batch.jobs.length > 0 &&
      batch.jobs.every((job) => typeof job.id === 'string' && Object.hasOwn(STATUS, job.status));
  }
  function badge(status) {
    const key = Object.hasOwn(STATUS, status) ? status : 'unknown';
    return node(document, 'span', `oauth-status oauth-status-${key}`, STATUS[key] ?? '未知状态');
  }
  function time(label, value) {
    const date = new Date(value);
    const element = node(document, 'time', 'oauth-muted', `${label}：${value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—'}`);
    if (value && Number.isFinite(date.getTime())) element.dateTime = date.toISOString();
    return element;
  }
  function updateControls() {
    refs['site-filter'].hidden = !optionsFailed && siteCount !== null && siteCount <= 1 && !refs.site.value;
    refs['clear-site'].hidden = !refs.site.value;
    refs['clear-site'].disabled = !active;
    refs.refresh.disabled = !active || loading;
    refs.prev.disabled = !active || loading || cursors.length < 2;
    refs.next.disabled = !active || loading || !nextCursor;
    refs.page.textContent = `第 ${cursors.length} 页 · 每页最多 30 批`;
    const accountCount = batches.reduce((count, batch) => count + (Number(batch.total) || 0), 0);
    const matchedCount = batches.reduce((count, batch) => count + (Number(batch.matchedCount) || 0), 0);
    const pinned = focusedId && details.has(focusedId) && !batches.some((batch) => batch.id === focusedId);
    refs.summary.textContent = `${status || mySiteId || createdFrom ? '服务端全量筛选 · ' : email ? '邮箱全量检索 · ' : ''}本页 ${batches.length} 批 · ${accountCount} 个账号${email ? ` · 匹配 ${matchedCount} 个` : ''}${pinned ? ' · 另定位 1 批（不计入本页）' : ''}`;
    if (listFailed) refs.summary.textContent = '列表未读取成功 · 筛选结果不可用';
    else if (loading && !batches.length) refs.summary.textContent = '正在读取筛选结果…';
    refs.updated.textContent = updatedAt ? `列表更新 ${updatedAt.toLocaleTimeString('zh-CN', { hour12: false })}${loading ? ' · 刷新中…' : ''}` : loading ? '正在刷新…' : '尚未刷新';
    if (updatedAt) refs.updated.dateTime = updatedAt.toISOString();
    else refs.updated.removeAttribute('datetime');
    refs.confirmation.hidden = !confirmation;
    refs.attempt.hidden = !attempt;
    refs.lookup.disabled = !active || sending || checking;
    refs.lookup.textContent = checking ? '正在查证…' : '查询本次重跑';
    refs.retry.hidden = !retryAllowed;
    refs.retry.disabled = !active || sending || checking || !retryAllowed;
  }
  function askRerun(kind, id, label) {
    if (!active || attempt || confirmation) return;
    confirmation = { kind, id };
    refs['confirm-message'].textContent = `将再次入池${label}，沿用原参数、目标与代理快照，并创建新远端账号。原任务及结果不明记录会保留；不会检查或复用旧远端账号。整批重跑全有或全无，缺少凭据或仍在执行时将拒绝。`;
    render();
    refs.confirm.focus();
  }
  function jobCard(job, batch) {
    const article = node(document, 'article', 'oauth-job');
    article.dataset.jobId = job.id;
    const heading = node(document, 'div', 'oauth-job-select');
    heading.append(node(document, 'strong', '', job.accountName || job.email), badge(job.status));
    article.append(heading, node(document, 'p', 'oauth-muted', job.email));
    article.append(node(document, 'p', 'oauth-stage', STAGE[job.stage] ?? '等待状态更新'));
    if (job.message) article.append(node(document, 'p', 'oauth-job-message', job.message));
    if (job.remoteAccountId != null) article.append(node(document, 'p', 'oauth-muted', `远端账号 ID：${job.remoteAccountId}`));
    const times = node(document, 'div', 'oauth-task-times');
    times.append(time('任务创建', job.createdAt), time('开始', job.startedAt), time('结束', job.finishedAt));
    article.append(times);
    if (job.sourceJobId) article.append(node(document, 'p', 'oauth-muted', `来源任务：${job.sourceJobId}`));
    if (job.status === 'uncertain') article.append(node(document, 'p', 'oauth-muted', '原结果尚未确认。可先只读对账；显式再次入池会创建新账号，不会把原任务改为成功。'));
    const actions = node(document, 'div', 'oauth-actions');
    if (job.status === 'uncertain') {
      const button = node(document, 'button', 'secondary-action', reconciling.has(job.id) ? '正在对账…' : '只读对账');
      button.type = 'button'; button.disabled = reconciling.has(job.id) || !!attempt || !!confirmation;
      button.addEventListener('click', () => { void reconcile(job.id, batch.id); });
      actions.append(button);
    }
    if (!batch.legacy && job.canRerun === true && TERMINAL.has(job.status)) {
      const button = node(document, 'button', job.status === 'succeeded' ? 'text-button oauth-rerun-subtle' : 'secondary-action', job.status === 'uncertain' ? '再次入池' : '重跑此账号');
      button.type = 'button'; button.disabled = !!attempt || !!confirmation || reconciling.size > 0;
      button.addEventListener('click', () => askRerun('jobs', job.id, `账号 ${job.email}`));
      actions.append(button);
    }
    article.append(actions);
    return article;
  }
  function render() {
    refs.batches.replaceChildren();
    const rows = focusedId && details.has(focusedId)
      ? [details.get(focusedId), ...batches.filter((batch) => batch.id !== focusedId)] : batches;
    if (!rows.length) refs.batches.append(node(document, 'p', 'oauth-muted', loading ? '正在读取批次…' : listFailed ? '列表读取失败，请刷新重试。' : status || mySiteId || createdFrom ? '没有符合筛选条件的批次。' : email ? '没有匹配邮箱的批次。' : '暂无入池任务。'));
    for (const summary of rows) {
      const batch = details.get(summary.id) ?? summary;
      const article = node(document, 'article', 'oauth-batch');
      article.dataset.batchId = summary.id;
      const heading = node(document, 'div', 'oauth-batch-row');
      const toggle = node(document, 'button', 'oauth-batch-toggle', `批次 ${summary.id.slice(0, 8)} · ${summary.total ?? batch.jobs?.length ?? 0} 个账号${email ? ` · 匹配 ${summary.matchedCount ?? batch.jobs?.length ?? 0} 个` : ''}`);
      toggle.type = 'button'; toggle.setAttribute('aria-expanded', String(expanded.has(summary.id)));
      toggle.setAttribute('aria-controls', `${prefix}-${summary.id}`);
      toggle.addEventListener('click', () => {
        if (expanded.has(summary.id)) expanded.delete(summary.id);
        else { expanded.add(summary.id); void loadDetail(summary.id); }
        render();
      });
      if (summary.id === focusedId) toggle.append(node(document, 'span', 'oauth-focus-marker', '当前定位'));
      heading.append(toggle, time('批次创建', summary.createdAt));
      const counts = node(document, 'div', 'oauth-batch-counts');
      const exactStates = Object.entries(summary.statusCounts ?? {}).filter(([, count]) => count > 0)
        .map(([status, count]) => `${STATUS[status] ?? '未知状态'} ${count}`).join('，');
      counts.setAttribute('aria-label', `本批次全部账号状态：${exactStates}`); counts.title = exactStates;
      for (const [key, label, states] of [
        ['uncertain', '待对账', ['uncertain']], ['needs_attention', '需处理', ['failed', 'needs_attention']],
        ['running', '进行中', ['queued', 'running', 'pushing']], ['succeeded', '成功', ['succeeded']],
      ]) {
        const count = states.reduce((total, state) => total + (summary.statusCounts?.[state] ?? 0), 0);
        if (count > 0) counts.append(node(document, 'span', `oauth-status oauth-status-${key}`, `${label} ${count}`));
      }
      heading.append(counts);
      const actions = node(document, 'div', 'oauth-batch-actions');
      if (!summary.legacy && summary.canRerun === true) {
        const succeeded = summary.statusCounts?.succeeded === summary.total;
        const rerun = node(document, 'button', succeeded ? 'text-button oauth-rerun-subtle' : 'secondary-action', '整批重跑');
        rerun.type = 'button'; rerun.disabled = !!attempt || !!confirmation || reconciling.size > 0;
        rerun.title = '沿用原快照，创建新批次与新账号';
        rerun.addEventListener('click', () => askRerun('batches', summary.id, `整批 ${summary.total} 个账号（不受邮箱搜索影响）；列表筛选不改变整批重跑范围`));
        actions.append(rerun);
      } else if (summary.legacy) actions.append(node(document, 'span', 'oauth-muted oauth-read-only', '历史只读'));
      heading.append(actions); article.append(heading);
      const jobs = node(document, 'div', 'oauth-job-list'); jobs.id = `${prefix}-${summary.id}`; jobs.hidden = !expanded.has(summary.id);
      if (Array.isArray(batch.jobs)) for (const job of batch.jobs) jobs.append(jobCard(job, batch));
      else jobs.append(node(document, 'p', 'oauth-muted', '正在读取账号进度…'));
      article.append(jobs); refs.batches.append(article);
    }
    updateControls();
  }
  async function loadDetail(id) {
    const version = generation;
    const readVersion = readGeneration;
    const token = Symbol(); detailVersions.set(id, token);
    try {
      const data = await request(`/batches/${encodeURIComponent(id)}${query()}`);
      if (!current(version) || readGeneration !== readVersion || detailVersions.get(id) !== token) return;
      if (data.batch?.id !== id || !Array.isArray(data.batch.jobs)) throw new Error('Invalid batch');
      details.set(id, data.batch);
      batches = batches.map((batch) => batch.id === id ? { ...data.batch, jobs: undefined } : batch);
      render();
    } catch (error) {
      if (current(version) && readGeneration === readVersion && detailVersions.get(id) === token) refs.message.textContent = errorText(error, '批次详情读取失败，请刷新。');
    }
  }
  async function loadOptions() {
    const version = generation;
    const token = ++optionsVersion;
    refs.site.disabled = true;
    try {
      const data = await request('/options');
      if (!current(version) || token !== optionsVersion) return;
      if (!Array.isArray(data.mySites) || data.mySites.some((site) => typeof site.id !== 'string' || typeof site.name !== 'string')) throw new Error('Invalid sites');
      const selected = refs.site.value;
      const all = node(document, 'option', '', '全部站点'); all.value = '';
      refs.site.replaceChildren(all);
      for (const site of data.mySites) {
        const option = node(document, 'option', '', site.name); option.value = site.id; refs.site.append(option);
      }
      // A deleted historical target remains a valid read filter, not an implicit switch to all sites.
      if (selected && !data.mySites.some((site) => site.id === selected)) {
        const option = node(document, 'option', '', '已选站点（当前不可用）'); option.value = selected; refs.site.append(option);
      }
      refs.site.value = selected;
      siteCount = data.mySites.length; optionsFailed = false;
      refs.site.disabled = false; refs['options-message'].textContent = '';
    } catch (error) {
      if (!current(version) || token !== optionsVersion) return;
      optionsFailed = true;
      refs['options-message'].textContent = errorText(error, '站点候选读取失败，站点筛选暂不可用，请刷新重试。');
      if (!refs.site.value) {
        const option = node(document, 'option', '', '站点加载失败'); option.value = ''; refs.site.replaceChildren(option);
      }
    } finally {
      if (current(version) && token === optionsVersion) updateControls();
    }
  }
  function resetFilters() {
    window.clearTimeout(searchTimer);
    email = ''; status = ''; mySiteId = ''; createdFrom = null;
    refs.email.value = ''; refs.status.value = ''; refs.period.value = ''; refs.site.value = '';
    cursors = [null]; nextCursor = null; listFailed = false;
  }
  async function loadList() {
    if (!active) return;
    const version = generation;
    const readVersion = readGeneration;
    const token = ++listVersion;
    loading = true; updateControls();
    try {
      const params = new URLSearchParams();
      if (email) params.set('email', email);
      if (status) params.set('status', status);
      if (mySiteId) params.set('mySiteId', mySiteId);
      if (createdFrom) params.set('createdFrom', createdFrom);
      if (cursors.at(-1)) params.set('before', cursors.at(-1));
      const data = await request(`/batches${params.size ? `?${params}` : ''}`);
      if (!current(version) || readGeneration !== readVersion || listVersion !== token) return;
      if (!Array.isArray(data.batches) || data.batches.some((batch) => typeof batch.id !== 'string')) throw new Error('Invalid list');
      batches = data.batches; listFailed = false;
      updatedAt = new Date();
      nextCursor = typeof data.nextCursor === 'string' ? data.nextCursor : null;
      refs.message.textContent = '';
      render();
      await Promise.all([...expanded].filter((id) => id === focusedId || batches.some((batch) => batch.id === id)).map(loadDetail));
    } catch (error) {
      if (current(version) && readGeneration === readVersion && listVersion === token) {
        listFailed = true; batches = []; nextCursor = null;
        refs.message.textContent = errorText(error, '批次列表读取失败，请刷新。');
      }
    } finally {
      if (current(version) && readGeneration === readVersion && listVersion === token) { loading = false; render(); }
    }
  }
  function invalidateReads() { readGeneration += 1; listVersion += 1; detailVersions.clear(); }
  function acceptRerun(batch) {
    if (!validBatch(batch, attempt?.requestId)) throw new Error('Mismatched batch');
    invalidateReads();
    resetFilters();
    loading = false; focusedId = batch.id; expanded.clear(); expanded.add(batch.id); details.clear(); details.set(batch.id, batch);
    batches = [batch]; attempt = null; retryAllowed = false; sending = false; checking = false;
    refs.message.textContent = '新批次已接受。原任务记录保留，离页后后台继续执行。';
    render();
  }
  async function lookupAttempt() {
    if (!active || !attempt || sending || checking) return;
    const version = generation;
    const id = attempt.requestId;
    checking = true; retryAllowed = false; updateControls();
    try {
      const data = await request(`/batches/${encodeURIComponent(id)}`);
      if (!current(version) || attempt?.requestId !== id) return;
      acceptRerun(data.batch);
    } catch (error) {
      if (!current(version) || attempt?.requestId !== id) return;
      retryAllowed = error instanceof ControlledError && error.status === 404;
      refs['attempt-message'].textContent = retryAllowed ? '暂未查到新批次。可使用同一请求 ID 重试；不会换键再次入池。' : errorText(error, '重跑结果仍不明，请继续查询；不会自动重新提交。');
    } finally { if (current(version)) { checking = false; render(); } }
  }
  async function sendRerun() {
    if (!active || !attempt || sending || checking) return;
    const version = generation;
    const id = attempt.requestId;
    sending = true; retryAllowed = false;
    refs['attempt-message'].textContent = '正在提交重跑请求…'; render();
    try {
      const data = await request(`/${attempt.kind}/${encodeURIComponent(attempt.id)}/rerun`, { method: 'POST', body: { requestId: id } });
      if (!current(version) || attempt?.requestId !== id) return;
      acceptRerun(data.batch);
    } catch (error) {
      if (!current(version) || attempt?.requestId !== id) return;
      const rejected = error instanceof ControlledError && (REJECTED_BEFORE_ADMISSION.has(error.code)
        || (error.status >= 400 && error.status < 500 && error.status !== 409));
      // A rejection of a retry cannot disprove acceptance of an earlier in-flight request.
      if (rejected && !attempt.uncertain) {
        attempt = null; retryAllowed = false; refs.message.textContent = error.message;
      } else {
        attempt.uncertain = true;
        refs['attempt-message'].textContent = errorText(error, '重跑提交结果不明，正在用原请求 ID 查证；不会换键盲重跑。');
      }
    } finally {
      if (current(version)) { sending = false; render(); if (attempt) await lookupAttempt(); }
    }
  }
  async function reconcile(id, batchId) {
    if (!active || reconciling.has(id)) return;
    const version = generation;
    const readVersion = readGeneration;
    reconciling.add(id); render();
    try {
      const data = await request(`/jobs/${encodeURIComponent(id)}/reconcile`, { method: 'POST', body: {} });
      if (!current(version) || readGeneration !== readVersion) return;
      if (data.job?.id !== id) throw new Error('Mismatched job');
      // 只读对账是最新证据；在它之前发出的列表/详情不能将状态覆盖回 uncertain。
      invalidateReads(); loading = false;
      const batch = details.get(batchId);
      if (batch) {
        const oldJob = batch.jobs.find((job) => job.id === id);
        const statusCounts = { ...batch.statusCounts };
        if (oldJob && oldJob.status !== data.job.status) {
          statusCounts[oldJob.status] = Math.max(0, (statusCounts[oldJob.status] ?? 0) - 1);
          statusCounts[data.job.status] = (statusCounts[data.job.status] ?? 0) + 1;
        }
        details.set(batchId, { ...batch, statusCounts, jobs: batch.jobs.map((job) => job.id === id ? data.job : job) });
        batches = batches.map((item) => item.id === batchId ? { ...item, statusCounts } : item);
      }
      refs.message.textContent = '只读对账完成；未重新创建账号。';
    } catch (error) {
      if (current(version) && readGeneration === readVersion) refs.message.textContent = errorText(error, '对账未完成，请稍后查询或人工核实。');
    } finally { if (current(version)) { reconciling.delete(id); render(); } }
  }
  function schedulePoll(version) {
    window.clearTimeout(timer);
    if (!current(version)) return;
    timer = window.setTimeout(async () => {
      if (!current(version)) return;
      if (attempt) await lookupAttempt();
      if (current(version)) await loadList();
      schedulePoll(version);
    }, interval);
  }
  function deactivate() {
    if (attempt && sending) attempt.uncertain = true;
    active = false; generation += 1; invalidateReads();
    window.clearTimeout(timer); window.clearTimeout(searchTimer);
    for (const controller of requests) controller.abort();
    requests.clear(); reconciling.clear(); confirmation = null;
    sending = false; checking = false; loading = false; retryAllowed = false;
    root.hidden = true; updateControls();
  }
  async function activate({ batchId = null } = {}) {
    if (destroyed) return;
    deactivate(); active = true; root.hidden = false;
    const version = generation;
    focusedId = typeof batchId === 'string' && batchId ? batchId : null;
    details.clear(); batches = []; updatedAt = null; listFailed = false;
    if (focusedId) { resetFilters(); expanded.clear(); expanded.add(focusedId); }
    if (attempt) refs['attempt-message'].textContent = '上次重跑尚未确认，正在用原请求 ID 查证。';
    render();
    await Promise.all([loadList(), loadOptions(), attempt ? lookupAttempt() : Promise.resolve()]);
    schedulePoll(version);
  }
  function applySearch() {
    window.clearTimeout(searchTimer);
    if (!active) return;
    email = refs.email.value.trim(); status = refs.status.value; mySiteId = refs.site.value;
    const days = Number(refs.period.value);
    createdFrom = days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
    cursors = [null]; nextCursor = null; focusedId = null; listFailed = false; updatedAt = null; loading = true;
    invalidateReads(); details.clear(); expanded.clear(); batches = []; confirmation = null;
    render(); void loadList();
  }
  refs.filter.addEventListener('submit', (event) => { event.preventDefault(); applySearch(); });
  refs.email.addEventListener('input', () => {
    // 输入一变化即隔离旧搜索响应，不等待防抖计时结束。
    invalidateReads(); loading = false; updateControls();
    window.clearTimeout(searchTimer); searchTimer = window.setTimeout(applySearch, 250);
  });
  for (const ref of [refs.status, refs.period, refs.site]) ref.addEventListener('change', applySearch);
  refs['clear-site'].addEventListener('click', () => { refs.site.value = ''; applySearch(); });
  refs.refresh.addEventListener('click', () => { void loadList(); void loadOptions(); });
  refs.prev.addEventListener('click', () => { if (cursors.length > 1) { cursors.pop(); invalidateReads(); details.clear(); void loadList(); } });
  refs.next.addEventListener('click', () => { if (nextCursor) { cursors.push(nextCursor); invalidateReads(); details.clear(); void loadList(); } });
  refs.confirm.addEventListener('click', () => {
    if (!active || !confirmation || attempt) return;
    attempt = { ...confirmation, requestId: window.crypto.randomUUID() }; confirmation = null;
    void sendRerun();
  });
  refs.cancel.addEventListener('click', () => { confirmation = null; render(); });
  refs.lookup.addEventListener('click', () => { void lookupAttempt(); });
  refs.retry.addEventListener('click', () => { if (retryAllowed) void sendRerun(); });
  window.addEventListener('pagehide', deactivate);
  function destroy() {
    if (destroyed) return;
    deactivate(); destroyed = true; attempt = null;
    window.removeEventListener('pagehide', deactivate); root.remove();
  }
  return { activate, deactivate, destroy };
}
