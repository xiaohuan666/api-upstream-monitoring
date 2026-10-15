import { defaultImportOptions, normalizeImportOptions, IMPORT_PLAN_TYPES } from './oauth-import-options.mjs';

// 首访候选是业务模板，不是对官方模型可用性的声明。
const MODELS = ['codex-auto-review', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6.1-sol'];
/** 共用参数视图不进行 I/O，也不保存偏好；持久化由接受批次的服务端负责。 */
export function mountOAuthImportOptions(container, { onChange = () => {} } = {}) {
  const document = container.ownerDocument;
  const root = document.createElement('fieldset');
  root.className = 'oauth-import-options';
  root.innerHTML = `
    <legend>共用导入参数</legend>
    <div class="oauth-fields">
      <label class="oauth-wide">模型规则<select data-option="modelMode"><option value="whitelist">模型白名单</option><option value="mapping">自定义模型映射</option><option value="unrestricted">不限制模型</option></select></label>
      <div class="oauth-wide" data-option="model-picker"><div class="oauth-model-list" data-option="model-list"></div><div class="oauth-model-add"><input data-option="custom-model" aria-label="自定义模型名称" placeholder="输入模型名称"><button type="button" class="secondary-action" data-option="add-model">添加模型</button></div></div>
      <label class="oauth-wide" data-option="mapping-label" hidden>模型映射 JSON<textarea data-option="modelMapping" rows="3" spellcheck="false" placeholder='{"来源模型":"目标模型"}'></textarea></label>
      <label>并发<input data-option="concurrency" type="number" min="1" max="10000" step="1" required></label>
      <label>负载因子<input data-option="loadFactor" type="number" min="1" max="10000" step="1" placeholder="留空使用目标站点默认值"></label>
      <label class="oauth-wide">Codex 指纹收敛<select data-option="fingerprintMode"><option value="off">关闭</option><option value="device">仅设备</option><option value="session">设备＋会话</option><option value="full">完整</option></select></label>
      <label class="oauth-toggle oauth-wide"><input data-option="schedulable" type="checkbox"><span>开启调度</span></label>
      <p class="oauth-feedback oauth-wide" data-option="capability-message" role="status"></p>
    </div>
    <details class="oauth-advanced"><summary>高级参数</summary><div class="oauth-fields">
      <label>优先级<input data-option="priority" type="number" min="1" max="10000" step="1" required></label>
      <label>计费倍率<input data-option="rateMultiplier" type="number" min="0" max="999999.9999" step="0.0001" required></label>
      <label>OAuth WS 模式<select data-option="wsMode"><option value="off">关闭</option><option value="ctx_pool">ctx_pool</option><option value="passthrough">passthrough</option><option value="http_bridge">http_bridge</option></select></label>
      <label>订阅档位覆盖<select data-option="planType"></select></label>
      <label class="oauth-toggle oauth-wide"><input data-option="autoPauseOnExpired" type="checkbox"><span>账号到期自动停止调度</span></label>
    </div></details>`;
  container.append(root);
  const refs = Object.fromEntries([...root.querySelectorAll('[data-option]')].map((item) => [item.dataset.option, item]));
  for (const value of IMPORT_PLAN_TYPES) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'self_serve_business_prolite' ? 'Business Premium · self_serve_business_prolite' : value || '自动识别（不覆盖）';
    refs.planType.append(option);
  }
  let selected = new Set();
  let candidates = [];
  let atomicSchedulable = false;
  let atomicProtection = false;
  function renderModels() {
    refs['model-list'].replaceChildren();
    for (const model of candidates) {
      const label = document.createElement('label');
      label.className = 'oauth-model-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.value = model; checkbox.checked = selected.has(model);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(model); else selected.delete(model);
        onChange();
      });
      const text = document.createElement('span'); text.textContent = model;
      label.append(checkbox, text); refs['model-list'].append(label);
    }
  }
  function renderMode() {
    refs['model-picker'].hidden = refs.modelMode.value !== 'whitelist';
    refs['mapping-label'].hidden = refs.modelMode.value !== 'mapping';
  }
  function renderCapability() {
    // 保存的 false 是业务意图；旧目标只能阻止提交，不能替用户改成可调度。
    refs.schedulable.disabled = !atomicSchedulable && refs.schedulable.checked;
    refs['capability-message'].textContent = !atomicProtection ? '目标 Sub2 暂不支持创建时关闭账号保护，请先升级 Sub2；不会静默开启保护或改写指纹。' : atomicSchedulable ? '' : refs.schedulable.checked
      ? '目标 Sub2 暂不支持创建时关闭调度；如需关闭，请先升级 Sub2。'
      : '记忆的设置为关闭调度，但目标 Sub2 不支持；请先升级 Sub2，或显式开启调度后再提交。';
  }
  function restore(input = defaultImportOptions(), capabilities = {}) {
    const options = normalizeImportOptions(input);
    selected = new Set(options.models);
    candidates = [...new Set([...MODELS, ...options.models])];
    for (const key of ['modelMode', 'concurrency', 'loadFactor', 'priority', 'rateMultiplier', 'fingerprintMode', 'wsMode', 'planType']) refs[key].value = options[key] ?? '';
    refs.modelMapping.value = JSON.stringify(options.modelMapping, null, 2);
    refs.autoPauseOnExpired.checked = options.autoPauseOnExpired;
    atomicSchedulable = capabilities.atomicSchedulable === true;
    atomicProtection = capabilities.atomicProtection === true;
    refs.schedulable.checked = options.schedulable;
    renderCapability();
    refs['custom-model'].value = '';
    renderModels(); renderMode();
  }
  function read() {
    return normalizeImportOptions({
      modelMode: refs.modelMode.value,
      models: refs.modelMode.value === 'whitelist' ? [...selected] : [],
      modelMapping: refs.modelMode.value === 'mapping' ? JSON.parse(refs.modelMapping.value) : {},
      concurrency: Number(refs.concurrency.value),
      loadFactor: refs.loadFactor.value === '' ? null : Number(refs.loadFactor.value),
      priority: Number(refs.priority.value), rateMultiplier: Number(refs.rateMultiplier.value),
      fingerprintMode: refs.fingerprintMode.value, wsMode: refs.wsMode.value, planType: refs.planType.value,
      autoPauseOnExpired: refs.autoPauseOnExpired.checked,
      schedulable: refs.schedulable.checked, accountProtection: false,
    });
  }
  refs['add-model'].addEventListener('click', () => {
    if (root.disabled) return;
    const model = refs['custom-model'].value.trim();
    if (!model) return;
    if (!candidates.includes(model)) candidates.push(model);
    selected.add(model); refs['custom-model'].value = ''; renderModels(); onChange();
  });
  refs['custom-model'].addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); refs['add-model'].click();
  });
  refs.modelMode.addEventListener('change', renderMode);
  refs.schedulable.addEventListener('change', renderCapability);
  root.addEventListener('input', onChange);
  root.addEventListener('change', onChange);
  restore();
  return { restore, read, canSubmit() { return atomicProtection && (atomicSchedulable || refs.schedulable.checked); }, setDisabled(value) { root.disabled = value; } };
}
