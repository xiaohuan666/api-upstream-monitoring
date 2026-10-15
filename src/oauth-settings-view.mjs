const SETTINGS_ENDPOINT = '/api/oauth-onboarding/settings';

/** 独立入池设置表单；路由离开时必须 deactivate，以取消请求并隔离迟到响应。 */
export function mountOAuthSettings(container, { fetchImpl = fetch } = {}) {
  const document = container.ownerDocument;
  const window = document.defaultView;
  container.innerHTML = `
    <div class="panel-header">
      <div><h3 id="oauth-settings-heading">账号入池</h3>
        <p id="oauth-settings-help">所有批次共享并发；调低不会打断已运行的任务。</p>
      </div>
    </div>
    <form class="site-form" novalidate>
      <label for="oauth-settings-concurrency">
        <span>同时执行账号数</span>
        <input id="oauth-settings-concurrency" name="concurrency" type="number" min="1" max="20" step="1" required
          aria-describedby="oauth-settings-help oauth-settings-range" disabled />
      </label>
      <p id="oauth-settings-range">可设置 1–20 个账号同时执行。</p>
      <p id="oauth-settings-status" role="status" aria-live="polite"></p>
      <div class="modal-actions">
        <button class="secondary-action" type="button" data-oauth-settings-reload>重新加载</button>
        <button class="primary-action" type="submit" disabled>保存配置</button>
      </div>
    </form>`;
  const form = container.querySelector('form');
  const input = form.elements.namedItem('concurrency');
  const submit = form.querySelector('[type="submit"]');
  const reload = form.querySelector('[data-oauth-settings-reload]');
  const status = container.querySelector('#oauth-settings-status');
  let active = false;
  let generation = 0;
  let controller = null;
  let loaded = false;
  let busy = false;

  function current(version) { return active && generation === version; }
  function validInput() {
    const value = input.valueAsNumber;
    return input.value !== '' && input.validity.valid && Number.isInteger(value) && value >= 1 && value <= 20;
  }
  function renderControls() {
    input.disabled = !active || !loaded || busy;
    submit.disabled = !active || !loaded || busy || !validInput();
    reload.disabled = !active || busy;
    submit.textContent = busy && loaded ? '保存中…' : '保存配置';
    form.setAttribute('aria-busy', String(busy));
  }
  function message(text, failed = false) {
    status.textContent = text;
    status.classList.toggle('is-error', failed);
  }
  async function request(method, concurrency) {
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    const version = ++generation;
    busy = true;
    if (method === 'GET') { loaded = false; input.value = ''; }
    message(method === 'GET' ? '正在加载配置…' : '正在保存配置…');
    renderControls();
    const timeout = window.setTimeout(() => requestController.abort(), 15_000);
    try {
      const response = await fetchImpl(SETTINGS_ENDPOINT, {
        method, signal: requestController.signal, credentials: 'same-origin', cache: 'no-store',
        ...(method === 'PUT' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ concurrency }) } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error('settings request failed');
      const value = data?.settings?.concurrency;
      // 不用本地默认值掩盖损坏或不兼容的配置响应。
      if (data?.limits?.min !== 1 || data?.limits?.max !== 20 || !Number.isInteger(value) || value < 1 || value > 20 ||
          (method === 'PUT' && value !== concurrency)) throw new Error('invalid settings response');
      if (!current(version)) return;
      loaded = true;
      input.value = String(value);
      message(method === 'PUT' ? '配置已保存。' : '');
    } catch {
      if (!current(version)) return;
      message(method === 'GET' ? '加载失败，无法保存配置，请重新加载。' : '保存失败，输入已保留，请重试；可重新加载确认当前配置。', true);
    } finally {
      window.clearTimeout(timeout);
      if (current(version)) {
        controller = null;
        busy = false;
        renderControls();
      }
    }
  }
  input.addEventListener('input', () => {
    if (!active || busy || !loaded) return;
    message(validInput() ? '' : '请输入 1–20 的整数。', !validInput());
    renderControls();
  });
  reload.addEventListener('click', () => { if (active && !busy) void request('GET'); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!active || !loaded || busy) return;
    if (!validInput()) { message('请输入 1–20 的整数。', true); renderControls(); return; }
    void request('PUT', input.valueAsNumber);
  });
  renderControls();
  return {
    activate() {
      if (active) return;
      active = true;
      return request('GET');
    },
    deactivate() {
      active = false;
      ++generation;
      controller?.abort();
      controller = null;
      busy = false;
      loaded = false;
      renderControls();
    },
  };
}
