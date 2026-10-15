import { APP_PATHS } from './client-route.mjs';
import { parseOAuthCredentialBatch } from './oauth-credential-input.mjs';
import { mountOAuthImportOptions } from './oauth-import-options-view.mjs';

const API = '/api/oauth-onboarding';
const JOB_STATUSES = new Set(['queued', 'running', 'pushing', 'succeeded', 'failed', 'needs_attention', 'uncertain']);
let mountNumber = 0;

class ControlledError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function errorText(error, fallback) {
  // 只展示本应用 JSON 边界给出的受控错误，传输异常可能包含凭据，不能透传。
  return error instanceof ControlledError ? error.message : fallback;
}

function node(document, tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = String(text);
  return element;
}

/**
 * 挂载独立 OAuth 入池页；父页面负责路由及样式引入，离开路由必须 deactivate。
 * requestId 与非秘密输入仅保留在本次挂载内存；不保留密码、TOTP 或序列化请求。
 */
export function mountOAuthOnboarding(container, { fetchImpl = fetch, pollIntervalMs = 3000, onAccepted = () => {} } = {}) {
  const document = container.ownerDocument;
  const window = document.defaultView;
  const prefix = `oauth-onboarding-${++mountNumber}`;
  const root = node(document, 'section', 'oauth-onboarding');
  root.hidden = true;
  // 模板全部为固定文案；站点、分组、任务及错误一律通过 textContent 渲染。
  root.innerHTML = `
    <header class="oauth-heading"><div><p class="eyebrow">OPENAI OAUTH</p><h2>批量账号入池</h2></div><a href="${APP_PATHS.oauthTasks}" data-route-link class="secondary-action">入池任务</a></header>
    <form autocomplete="off" data-role="form" class="oauth-layout oauth-import-layout">
      <section class="oauth-form-main">
        <div class="oauth-card-heading"><h3>账号与入池设置</h3><button type="button" class="text-button" data-role="reload">重新加载选项</button></div>
        <p class="oauth-feedback" data-role="options-message" role="status" aria-live="polite"></p>
        <button type="button" class="secondary-action" data-role="use-only-site" hidden>使用当前可用站点</button>
        <div class="oauth-credential-input">
          <label>批量账号<textarea data-role="credential-line" rows="5" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="每行：账号---密码---2FA 或 账号|密码|2FA"></textarea></label>
          <div class="oauth-parse-actions"><button type="button" class="secondary-action" data-role="parse-credentials">解析账号</button><button type="button" class="text-button" data-role="clear-credentials">清空</button><p class="oauth-feedback" data-role="credential-message" role="status" aria-live="polite"></p></div>
        </div>
        <div class="oauth-fields oauth-destination-fields">
          <label data-role="site-field" hidden>目标站点<select data-role="site" name="mySiteId" required></select></label>
          <label>代理<select data-role="proxy" name="proxyId"></select></label>
        </div>
        <fieldset class="oauth-groups" data-role="groups-fieldset"><legend>分组 <span data-role="group-count">已选 0 个</span></legend>
          <div class="oauth-group-toolbar"><label class="oauth-search-label">搜索分组<input data-role="search" type="search" autocomplete="off" placeholder="按分组名称搜索"></label><label class="oauth-selected-toggle"><input data-role="only-selected" type="checkbox">仅看已选</label></div>
          <div class="oauth-selected-groups" data-role="selected-groups" aria-label="已选分组"></div>
          <p class="oauth-feedback" data-role="groups-message" role="status" aria-live="polite"></p>
          <div class="oauth-group-list" data-role="groups"></div>
        </fieldset>
        <div data-role="import-options"></div>
      </section>
      <aside class="oauth-submit-summary" aria-label="提交摘要">
        <h3>本次入池</h3>
        <div class="oauth-summary-count"><strong data-role="summary-count">0</strong><span>个有效账号</span></div>
        <dl data-role="summary-details" class="oauth-summary-details"></dl>
        <p class="oauth-feedback" data-role="submit-message" role="status" aria-live="polite"></p>
        <div data-role="confirmation" class="oauth-confirmation" aria-live="polite"></div>
        <div class="oauth-actions"><button type="submit" class="primary-action" data-role="submit">创建账号</button><button type="button" class="secondary-action" data-role="lookup" hidden>查询本次提交</button></div>
      </aside>
    </form>`;
  container.append(root);
  const refs = Object.fromEntries([...root.querySelectorAll('[data-role]')].map((element) => [element.dataset.role, element]));
  for (const role of ['site', 'proxy', 'search', 'credential-line', 'credential-message']) {
    refs[role].id = `${prefix}-${role}`;
  }
  refs['credential-line'].setAttribute('aria-describedby', `${prefix}-credential-message`);
  const importView = mountOAuthImportOptions(refs['import-options'], { onChange: () => { message('submit-message', ''); updateControls(); } });
  const interval = Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 3000;
  const requests = new Set();
  let active = false;
  let destroyed = false;
  let generation = 0;
  let groupsGeneration = 0;
  let groupsController;
  let timer;
  let optionsReady = false;
  let availableSites = [];
  let groupsReady = false;
  let groups = [];
  let selectedGroups = new Set();
  let attempt = null;
  let submitting = false;
  let checking = false;
  let parsedAccounts = [];
  let missingGroups = false;
  let retryAllowed = false;

  function isCurrent(version) { return active && !destroyed && generation === version; }
  function clearParsedAccounts() {
    for (const account of parsedAccounts) { account.password = ''; account.totpSecret = ''; account.email = ''; }
    parsedAccounts.length = 0;
  }
  function clearSecrets() {
    clearParsedAccounts();
    refs['credential-line'].value = '';
    message('credential-message', '');
  }
  function message(role, text) { refs[role].textContent = text; }

  async function request(path, { method = 'GET', body, controller = new AbortController() } = {}) {
    requests.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const init = {
        method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body } : {}),
      };
      // fetch 在调用时接管请求体；视图不能在等待响应期间持有秘密字符串。
      let pending;
      try { pending = fetchImpl(`${API}${path}`, init); } finally { body = undefined; delete init.body; }
      const response = await pending;
      const data = await response.json();
      if (!response.ok) {
        const controlled = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : '请求未完成，请稍后查询。';
        throw new ControlledError(response.status, controlled);
      }
      return data;
    } finally {
      window.clearTimeout(timeout);
      requests.delete(controller);
    }
  }

  function canParseCredentials() {
    return active && !destroyed && optionsReady && (!attempt || retryAllowed) && !submitting && !checking;
  }

  function fillCredentials(input) {
    if (!canParseCredentials()) { clearSecrets(); return; }
    clearParsedAccounts();
    refs['credential-line'].value = input;
    try {
      const parsed = parseOAuthCredentialBatch(input);
      parsedAccounts = parsed.accounts;
      message('credential-message', `解析成功 ${parsed.successCount} · 失败 ${parsed.failureCount}`);
    } catch (error) { message('credential-message', error.message); }
    message('submit-message', '');
    refs.confirmation.replaceChildren();
    updateControls();
  }

  function insertCredentials(text) {
    if (!canParseCredentials()) { clearSecrets(); return; }
    const input = refs['credential-line'];
    input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
    const cursor = input.selectionStart;
    fillCredentials(input.value);
    input.setSelectionRange(cursor, cursor);
  }

  function updateControls() {
    refs['credential-line'].disabled = !canParseCredentials();
    refs['parse-credentials'].disabled = !canParseCredentials();
    refs['clear-credentials'].disabled = !canParseCredentials();
    const locked = !!attempt || submitting || !optionsReady;
    for (const role of ['site', 'proxy']) refs[role].disabled = locked;
    refs['groups-fieldset'].disabled = locked || !groupsReady;
    importView.setDisabled(locked || !groupsReady);
    refs.submit.disabled = !active || !optionsReady || submitting || checking || !parsedAccounts.length || !importView.canSubmit() ||
      (attempt ? !retryAllowed : !groupsReady || missingGroups || !selectedGroups.size);
    refs.submit.textContent = submitting ? '正在提交…' : attempt ? '使用同一请求重试' : `创建 ${parsedAccounts.length} 个账号`;
    refs.lookup.hidden = !attempt;
    refs.lookup.disabled = submitting || checking || !active;
    refs.lookup.textContent = checking ? '正在查询…' : '查询本次提交';
    refs.reload.disabled = submitting || checking || !active;
    for (const button of refs['selected-groups'].querySelectorAll('button')) button.disabled = locked || !groupsReady;
    renderSummary();
  }

  function renderSummary() {
    refs['summary-count'].textContent = String(parsedAccounts.length);
    let options;
    try { options = importView.read(); } catch { /* 未完成的输入不展示上一份有效参数。 */ }
    const groupNames = groups.filter((group) => selectedGroups.has(group.id)).map((group) => group.name);
    const entries = [
      ['目标站点', refs.site.value ? refs.site.selectedOptions[0]?.textContent : '未选择'],
      ['代理', refs.proxy.selectedOptions[0]?.textContent || '直连（不使用代理）'],
      ['分组', groupNames.join('、') || '未选择'],
    ];
    if (options) entries.push(
      ['模型规则', options.modelMode === 'whitelist' ? options.models.join('、') : options.modelMode === 'mapping' ? '自定义映射' : '不限制模型'],
      ['并发 / 负载', `${options.concurrency} / ${options.loadFactor ?? '站点默认'}`],
      ['调度 / 账号保护', `${options.schedulable ? '开启' : '关闭'} / 关闭`],
      ['指纹 / WS', `${options.fingerprintMode} / ${options.wsMode}`],
      ['优先级 / 倍率', `${options.priority} / ${options.rateMultiplier}`],
      ['订阅档位', options.planType || '自动识别'],
      ['到期停调度', options.autoPauseOnExpired ? '开启' : '关闭'],
    );
    else entries.push(['入池参数', '待完善']);
    refs['summary-details'].replaceChildren(...entries.flatMap(([label, value]) => [node(document, 'dt', '', label), node(document, 'dd', '', value)]));
  }

  function renderSelectedGroups() {
    refs['selected-groups'].replaceChildren();
    for (const group of groups.filter((item) => selectedGroups.has(item.id))) {
      const button = node(document, 'button', 'oauth-group-chip', `${group.name} ×`);
      button.type = 'button'; button.setAttribute('aria-label', `移除分组 ${group.name}`);
      button.disabled = !!attempt || submitting || !optionsReady || !groupsReady;
      button.addEventListener('click', () => {
        if (button.disabled) return;
        selectedGroups.delete(group.id); missingGroups = false;
        message('submit-message', ''); renderGroups(); updateControls();
      });
      refs['selected-groups'].append(button);
    }
  }

  function renderGroups() {
    refs.groups.replaceChildren();
    const query = refs.search.value.trim().toLowerCase();
    const visible = groups.filter((group) => group.name.toLowerCase().includes(query) && (!refs['only-selected'].checked || selectedGroups.has(group.id)));
    for (const group of visible) {
      const label = node(document, 'label', 'oauth-group-option');
      const checkbox = node(document, 'input');
      checkbox.type = 'checkbox';
      checkbox.value = String(group.id);
      checkbox.checked = selectedGroups.has(group.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedGroups.add(group.id); else selectedGroups.delete(group.id);
        missingGroups = false;
        message('submit-message', '');
        if (refs['only-selected'].checked) renderGroups();
        else { renderGroupCount(); renderSelectedGroups(); }
        updateControls();
      });
      label.append(checkbox, node(document, 'span', '', group.name));
      refs.groups.append(label);
    }
    if (groupsReady) message('groups-message', missingGroups ? '记忆的分组已失效，请重新选择分组；不会自动替换。' : groups.length ? visible.length ? '' : '没有匹配的分组。' : '目标站点没有可用的 OpenAI 启用分组。');
    renderGroupCount();
    renderSelectedGroups();
  }

  function renderGroupCount() { refs['group-count'].textContent = `已选 ${selectedGroups.size} 个`; }

  async function loadGroups() {
    const version = generation;
    const groupVersion = ++groupsGeneration;
    groupsController?.abort();
    groupsController = new AbortController();
    const controller = groupsController;
    const siteId = refs.site.value;
    groups = [];
    selectedGroups = new Set();
    groupsReady = false;
    missingGroups = false;
    importView.restore();
    refs.search.value = '';
    refs['only-selected'].checked = false;
    renderGroups();
    message('groups-message', siteId ? '正在读取分组…' : '请先选择目标站点。');
    updateControls();
    if (!siteId) return;
    try {
      const [data, preferenceData] = await Promise.all([
        request(`/groups?mySiteId=${encodeURIComponent(siteId)}`, { controller }),
        request(`/preferences?mySiteId=${encodeURIComponent(siteId)}`, { controller }),
      ]);
      if (!isCurrent(version) || groupsGeneration !== groupVersion) return;
      if (!Array.isArray(data.groups)) throw new Error('Invalid groups');
      groups = data.groups.filter((group) => Number.isSafeInteger(group.id) && group.id > 0 && group.platform === 'openai' && group.status === 'active');
      if (!preferenceData.preferences || typeof preferenceData.capabilities?.atomicSchedulable !== 'boolean') throw new Error('Invalid preferences');
      const saved = attempt?.input.mySiteId === siteId ? attempt.input : preferenceData.preferences;
      const ids = saved.groupIds ?? [];
      if (!Array.isArray(ids)) throw new Error('Invalid preference groups');
      missingGroups = ids.some((id) => !groups.some((group) => group.id === id));
      selectedGroups = new Set(missingGroups ? [] : ids);
      importView.restore(saved.importOptions, preferenceData.capabilities);
      groupsReady = true;
      renderGroups();
    } catch (error) {
      if (!isCurrent(version) || groupsGeneration !== groupVersion) return;
      // 清空发生在请求前，失败时绝不继续暴露上一个站点的分组。
      message('groups-message', errorText(error, '分组加载失败，请重新加载选项。'));
    } finally {
      if (isCurrent(version) && groupsGeneration === groupVersion) updateControls();
    }
  }

  async function loadOptions() {
    const version = generation;
    const previousSite = attempt?.input.mySiteId ?? refs.site.value;
    const previousProxy = attempt?.input.proxyId ?? ''; // 代理仅保留本次未确认请求，不记忆。
    optionsReady = false;
    availableSites = [];
    refs['site-field'].hidden = true;
    refs['use-only-site'].hidden = true;
    refs.site.replaceChildren(node(document, 'option', '', '选择目标站点'));
    refs.site.firstChild.value = '';
    refs.proxy.replaceChildren(node(document, 'option', '', '直连（不使用代理）'));
    refs.proxy.firstChild.value = '';
    message('options-message', '正在读取站点与代理…');
    updateControls();
    try {
      const data = await request('/options');
      if (!isCurrent(version)) return;
      if (!Array.isArray(data.mySites) || !Array.isArray(data.proxies)) throw new Error('Invalid options');
      availableSites = data.mySites;
      refs['site-field'].hidden = data.mySites.length <= 1;
      for (const site of data.mySites) {
        const option = node(document, 'option', '', site.name);
        option.value = site.id;
        refs.site.append(option);
      }
      for (const proxy of data.proxies) {
        const expired = proxy.expiresAt && Date.parse(proxy.expiresAt) <= Date.now();
        // 可搜索下拉增强器不保证尊重 option.disabled；不向选择器提供不可用代理。
        if (proxy.status !== 'active' || expired) continue;
        const option = node(document, 'option', '', `${proxy.name} · ${proxy.protocol}`);
        option.value = proxy.id;
        refs.proxy.append(option);
      }
      const previousMissing = !!previousSite && !data.mySites.some((site) => site.id === previousSite);
      if (!previousMissing && previousSite) refs.site.value = previousSite;
      else if (!previousSite && data.mySites.length === 1) refs.site.value = data.mySites[0].id;
      refs['use-only-site'].hidden = !(previousMissing && data.mySites.length === 1 && !attempt);
      if ([...refs.proxy.options].some((option) => option.value === previousProxy && !option.disabled)) refs.proxy.value = previousProxy;
      optionsReady = true;
      message('options-message', previousMissing ? '原目标站点已不可用，请确认新目标；未自动替换。' : data.mySites.length ? '' : '暂无可用目标站点，请先在「我的站点」配置。');
      await loadGroups();
    } catch (error) {
      if (isCurrent(version)) message('options-message', errorText(error, '站点与代理加载失败，请重新加载。'));
    } finally { if (isCurrent(version)) updateControls(); }
  }

  function confirmAttempt(batch) {
    if (batch?.id !== attempt?.requestId || !Array.isArray(batch.jobs) || !batch.jobs.length ||
      batch.jobs.some((job) => typeof job.id !== 'string' || !JOB_STATUSES.has(job.status))) throw new Error('Mismatched batch');
    const link = node(document, 'a', 'secondary-action', '查看本批次入池任务');
    link.href = `${APP_PATHS.oauthTasks}?batch=${encodeURIComponent(batch.id)}`;
    link.dataset.routeLink = '';
    refs.confirmation.replaceChildren(link);
    attempt = null;
    retryAllowed = false;
    clearSecrets();
    message('submit-message', '批次已创建');
    updateControls();
    onAccepted(batch.id);
  }

  async function lookupAttempt() {
    if (!attempt || checking || submitting || !active) return;
    const version = generation;
    const requestId = attempt.requestId;
    checking = true;
    retryAllowed = false;
    updateControls();
    try {
      const data = await request(`/batches/${encodeURIComponent(requestId)}`);
      if (!isCurrent(version) || attempt?.requestId !== requestId) return;
      confirmAttempt(data.batch);
    } catch (error) {
      if (!isCurrent(version) || attempt?.requestId !== requestId) return;
      retryAllowed = error instanceof ControlledError && error.status === 404;
      message('submit-message', retryAllowed
        ? '暂未查到本批次；请重新输入同一批账号后使用同一请求重试，切勿换键盲目提交。'
        : errorText(error, '提交结果仍不明，请稍后查询；重试将沿用同一请求 ID。'));
    } finally { if (isCurrent(version)) { checking = false; updateControls(); } }
  }

  async function submit(event) {
    event.preventDefault();
    if (refs.submit.disabled || !active || !refs.form.reportValidity()) return;
    if (attempt && (parsedAccounts.length !== attempt.emails.length || parsedAccounts.some((account, index) => account.email.toLowerCase() !== attempt.emails[index]))) {
      message('submit-message', '重试必须保持原批次账号及顺序不变；请重新输入原批次，勿换键创建。');
      return;
    }
    if (!attempt) {
      let importOptions;
      try { importOptions = importView.read(); } catch {
        message('submit-message', '请检查导入参数：白名单至少选择一个模型，映射须为有效对象，数值及枚举必须在允许范围内。');
        return;
      }
      attempt = {
        requestId: window.crypto.randomUUID(),
        emails: parsedAccounts.map((account) => account.email.toLowerCase()),
        input: { mySiteId: refs.site.value, proxyId: refs.proxy.value || null,
          groupIds: [...selectedGroups].sort((a, b) => a - b), importOptions },
      };
    }
    const version = generation;
    const requestId = attempt.requestId;
    submitting = true;
    retryAllowed = false;
    message('submit-message', '正在提交批量授权任务…');
    updateControls();
    try {
      let body = JSON.stringify({ requestId, ...attempt.input, accounts: parsedAccounts });
      clearSecrets();
      let pending;
      try { pending = request('/batches', { method: 'POST', body }); } finally { body = undefined; }
      const data = await pending;
      if (!isCurrent(version) || attempt?.requestId !== requestId) return;
      confirmAttempt(data.batch);
    } catch (error) {
      if (!isCurrent(version) || attempt?.requestId !== requestId) return;
      // 明确的校验/鉴权拒绝没有创建任务，可以修正表单；409/5xx 仍需查证。
      if (error instanceof ControlledError && error.status >= 400 && error.status < 500 && error.status !== 409) {
        attempt = null;
        message('submit-message', error.message);
      } else {
        message('submit-message', errorText(error, '提交结果不明，正在用同一请求 ID 查证；不会自动换键重试。'));
      }
    } finally {
      if (isCurrent(version)) {
        submitting = false;
        updateControls();
        if (attempt) await lookupAttempt();
      }
    }
  }

  function schedulePoll(version) {
    window.clearTimeout(timer);
    if (!isCurrent(version)) return;
    timer = window.setTimeout(async () => {
      if (!isCurrent(version)) return;
      if (isCurrent(version) && attempt) await lookupAttempt();
      schedulePoll(version);
    }, interval);
  }

  function deactivate() {
    active = false;
    generation += 1;
    groupsGeneration += 1;
    window.clearTimeout(timer);
    for (const controller of requests) controller.abort();
    requests.clear();
    groupsController?.abort();
    submitting = false;
    checking = false;
    clearSecrets();
    retryAllowed = false;
    root.hidden = true;
    updateControls();
  }

  async function activate() {
    if (destroyed) return;
    deactivate();
    active = true;
    const version = generation;
    root.hidden = false;
    groups = [];
    selectedGroups = new Set();
    groupsReady = false;
    renderGroups();
    message('submit-message', attempt ? '上次提交结果尚未确认，正在使用原请求 ID 查询。重试需重新输入原批次。' : '');
    await Promise.all([loadOptions(), attempt ? lookupAttempt() : Promise.resolve()]);
    schedulePoll(version);
  }

  function destroy() {
    if (destroyed) return;
    deactivate();
    destroyed = true;
    attempt = null;
    window.removeEventListener('pagehide', deactivate);
    root.remove();
  }

  refs['clear-credentials'].addEventListener('click', () => { clearSecrets(); updateControls(); });
  refs['use-only-site'].addEventListener('click', () => {
    if (attempt || !optionsReady || availableSites.length !== 1) return;
    refs.site.value = availableSites[0].id; refs['use-only-site'].hidden = true;
    message('options-message', ''); void loadGroups();
  });
  refs.proxy.addEventListener('change', renderSummary);
  refs['only-selected'].addEventListener('change', renderGroups);
  refs['parse-credentials'].addEventListener('click', () => fillCredentials(refs['credential-line'].value));
  refs['credential-line'].addEventListener('input', () => {
    // 原文只留 textarea；解析数组在每次编辑前释放，避免提交上一份解析结果。
    clearParsedAccounts();
    message('credential-message', ''); updateControls();
  });
  refs['credential-line'].addEventListener('paste', (event) => {
    event.preventDefault();
    insertCredentials(event.clipboardData?.getData('text/plain') ?? '');
  });
  refs['credential-line'].addEventListener('dragover', (event) => event.preventDefault());
  refs['credential-line'].addEventListener('drop', (event) => {
    event.preventDefault(); insertCredentials(event.dataTransfer?.getData('text/plain') ?? '');
  });
  refs.site.addEventListener('change', () => { message('submit-message', ''); void loadGroups(); });
  refs.search.addEventListener('input', renderGroups);
  refs.form.addEventListener('submit', (event) => { void submit(event); });
  refs.lookup.addEventListener('click', () => { void lookupAttempt(); });
  refs.reload.addEventListener('click', () => { void activate(); });
  window.addEventListener('pagehide', deactivate);
  return { activate, deactivate, destroy };
}
