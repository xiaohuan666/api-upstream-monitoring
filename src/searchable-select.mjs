// 可搜索下拉框：把原生 <select> 增强为「触发按钮 + 搜索框 + 定高滚动列表」的自定义下拉。
// 原生 select 保留在 DOM 中（视觉隐藏），仍是取值 / 表单提交 / change 事件的唯一来源：
// 自定义 UI 选中后回写 select.value 并派发 change 事件，既有逻辑不需要任何改动。
// 选项被 replaceChildren 重建、value 被赋值时，组件通过 MutationObserver / value setter 自动同步。

// 筛选规则：忽略大小写的 contains；查询按空白分词后取 OR（"a b" = 包含 a 或包含 b）
export function matchesSearchText(label, query) {
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = String(label ?? '').toLowerCase();
  return terms.some((term) => text.includes(term));
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function chevronIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M8 10l4 4 4-4');
  svg.append(path);
  return svg;
}

// 增强一个原生 select，返回 { wrapper, sync }；已增强或多选时返回 null
export function enhanceSelect(select) {
  if (!(select instanceof HTMLSelectElement)) return null;
  if (select.multiple || select.dataset.searchableSelect === 'enhanced') return null;
  select.dataset.searchableSelect = 'enhanced';

  const wrapper = document.createElement('span');
  wrapper.className = 'searchable-select';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'searchable-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const label = document.createElement('span');
  label.className = 'searchable-select-label';
  trigger.append(label, chevronIcon());

  const menu = document.createElement('span');
  menu.className = 'searchable-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  const search = document.createElement('span');
  search.className = 'dropdown-search';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = '输入关键字，空格分隔';
  searchInput.setAttribute('aria-label', '筛选选项');
  search.append(searchInput);

  const optionsBox = document.createElement('span');
  optionsBox.className = 'searchable-select-options';

  const empty = document.createElement('span');
  empty.className = 'searchable-select-empty';
  empty.hidden = true;

  menu.append(search, optionsBox, empty);

  select.classList.add('searchable-select-native');
  // 视觉隐藏但保留可编程聚焦（required 校验），并退出 Tab 序
  select.tabIndex = -1;
  select.parentNode.insertBefore(wrapper, select);
  wrapper.append(select, trigger, menu);

  function selectedOption() {
    return select.selectedOptions?.[0] ?? null;
  }

  function syncLabel() {
    const text = selectedOption()?.label ?? '';
    label.textContent = text;
    label.title = text;
    trigger.disabled = select.disabled;
  }

  function visibleButtons() {
    return [...optionsBox.querySelectorAll('.searchable-select-option:not([hidden])')];
  }

  function syncOptions() {
    const query = searchInput.value;
    const current = selectedOption();
    const buttons = [];
    let visibleCount = 0;
    for (const option of select.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'searchable-select-option';
      button.setAttribute('role', 'option');
      const isSelected = option === current;
      button.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      button.classList.toggle('active', isSelected);
      button.textContent = option.label;
      button.title = option.label;
      button.hidden = !matchesSearchText(option.label, query);
      if (!button.hidden) visibleCount += 1;
      button.addEventListener('click', () => pickOption(option));
      buttons.push(button);
    }
    optionsBox.replaceChildren(...buttons);
    empty.hidden = visibleCount > 0;
    empty.textContent = select.options.length === 0 ? '暂无可选项' : '无匹配项';
  }

  function pickOption(option) {
    if (select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncLabel();
    closeMenu();
    trigger.focus();
  }

  function onDocumentClick(event) {
    if (!wrapper.contains(event.target)) closeMenu();
  }

  function openMenu() {
    if (trigger.disabled) return;
    syncLabel();
    searchInput.value = '';
    syncOptions();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    wrapper.classList.add('open');
    document.addEventListener('click', onDocumentClick);
    searchInput.focus();
  }

  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    wrapper.classList.remove('open');
    document.removeEventListener('click', onDocumentClick);
  }

  function moveFocus(step) {
    const buttons = visibleButtons();
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement);
    const next = index === -1
      ? (step > 0 ? 0 : buttons.length - 1)
      : (index + step + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  trigger.addEventListener('click', () => {
    if (menu.hidden) openMenu();
    else closeMenu();
  });
  searchInput.addEventListener('input', syncOptions);
  wrapper.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      trigger.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && event.target === searchInput) {
      const first = visibleButtons()[0];
      if (first) {
        event.preventDefault();
        first.click();
      }
    }
  });

  select.addEventListener('change', syncLabel);
  const observer = new MutationObserver(() => {
    syncOptions();
    syncLabel();
  });
  observer.observe(select, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled'],
  });

  // 拦截 value 赋值（如 renderGroupFilters 里的程序化赋值），赋值后同步显示
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    configurable: true,
    enumerable: true,
    get() {
      return descriptor.get.call(this);
    },
    set(value) {
      descriptor.set.call(this, value);
      queueMicrotask(syncLabel);
    },
  });

  syncLabel();
  return { wrapper, sync: () => { syncOptions(); syncLabel(); } };
}

// 批量增强 root 下所有单选 select（幂等，可重复调用）
export function initSearchableSelects(root = document) {
  for (const select of root.querySelectorAll('select:not([multiple])')) {
    enhanceSelect(select);
  }
}
