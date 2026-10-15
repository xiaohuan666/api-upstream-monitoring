import { matchesSearchText } from './searchable-select.mjs';

/** Rule values contain IDs only; visible labels are resolved from the latest site list. */
export function createAutoRefreshRuleEditor({ container, addButton, onChange }) {
  let rules = [];
  let sites = [];
  let pickers = [];

  function notify() { onChange?.(); }
  function refreshPickers() { for (const refresh of pickers) refresh(); }

  function render() {
    pickers = [];
    container.replaceChildren();
    if (!rules.length) {
      const empty = document.createElement('p');
      empty.className = 'refresh-rules-empty';
      empty.textContent = '暂无专属规则，所有站点使用下方默认间隔。';
      container.append(empty);
    }
    rules.forEach((rule, index) => {
      const card = document.createElement('fieldset');
      card.className = 'refresh-rule';
      card.innerHTML = `
        <legend>专属规则 ${index + 1}</legend>
        <div class="refresh-rule-header"><p>选中的站点仅按此间隔同步</p><button type="button" class="secondary-action refresh-rule-remove">删除规则</button></div>
        <div class="refresh-rule-fields">
          <div class="refresh-rule-sites">
            <span class="refresh-field-label">适用站点</span>
            <div class="multi-select-chips refresh-rule-chips"></div>
            <details class="refresh-site-picker">
              <summary>选择站点</summary>
              <input class="refresh-site-search" type="search" placeholder="搜索站点名称" aria-label="搜索站点名称" />
              <div class="refresh-site-options"></div>
              <p class="refresh-site-empty" hidden>没有可选站点，已分配的站点不会重复显示。</p>
            </details>
          </div>
          <label><span>间隔</span><input class="refresh-rule-value" type="number" min="5" step="1" required aria-label="专属规则 ${index + 1} 间隔" /></label>
          <label><span>单位</span><select class="refresh-rule-unit" aria-label="专属规则 ${index + 1} 单位"><option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option></select></label>
        </div>`;
      const value = card.querySelector('.refresh-rule-value');
      const unit = card.querySelector('.refresh-rule-unit');
      value.value = rule.intervalValue;
      unit.value = rule.intervalUnit;
      value.min = unit.value === 'minutes' ? '5' : '1';
      value.addEventListener('input', () => { rule.intervalValue = Number(value.value); notify(); });
      unit.addEventListener('change', () => {
        rule.intervalUnit = unit.value;
        value.min = unit.value === 'minutes' ? '5' : '1';
        value.value = Math.max(Number(value.min), Number(value.value) || 0);
        rule.intervalValue = Number(value.value);
        notify();
      });
      card.querySelector('.refresh-rule-remove').addEventListener('click', () => {
        rules.splice(index, 1);
        render();
        notify();
        addButton.focus();
      });
      const search = card.querySelector('.refresh-site-search');
      const options = card.querySelector('.refresh-site-options');
      const chips = card.querySelector('.refresh-rule-chips');
      const labels = sites.filter((site) => ['sub2api', 'new-api'].includes(site.type)).map((site) => {
        const label = document.createElement('label');
        label.className = 'multi-select-option';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.value = site.id;
        const text = document.createElement('span');
        text.textContent = site.name;
        label.append(check, text);
        check.addEventListener('change', () => {
          rule.siteIds = check.checked ? [...rule.siteIds, site.id] : rule.siteIds.filter((id) => id !== site.id);
          refreshPickers();
          notify();
        });
        options.append(label);
        return { label, check, site };
      });
      const refresh = () => {
        const assignedElsewhere = new Set(rules.filter((other) => other !== rule).flatMap((other) => other.siteIds));
        let visible = 0;
        for (const { label, check, site } of labels) {
          check.checked = rule.siteIds.includes(site.id);
          label.hidden = assignedElsewhere.has(site.id) || !matchesSearchText(site.name, search.value);
          if (!label.hidden) visible += 1;
        }
        card.querySelector('.refresh-site-empty').hidden = visible > 0;
        chips.replaceChildren();
        for (const id of rule.siteIds) {
          const name = sites.find((site) => site.id === id)?.name ?? '站点已删除';
          const chip = document.createElement('span');
          chip.className = 'multi-select-chip';
          const text = document.createElement('span');
          text.className = 'multi-select-chip-label';
          text.textContent = name;
          text.title = name;
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'multi-select-chip-remove';
          remove.textContent = '×';
          remove.setAttribute('aria-label', `移除 ${name}`);
          remove.addEventListener('click', () => {
            rule.siteIds = rule.siteIds.filter((selected) => selected !== id);
            refreshPickers();
            notify();
            card.querySelector('summary').focus();
          });
          chip.append(text, remove);
          chips.append(chip);
        }
        card.querySelector('summary').textContent = rule.siteIds.length ? `已选 ${rule.siteIds.length} 个站点 · 修改` : '选择站点';
      };
      search.addEventListener('input', refresh);
      search.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') event.preventDefault();
      });
      pickers.push(refresh);
      container.append(card);
    });
    refreshPickers();
  }

  addButton.addEventListener('click', () => {
    rules.push({ siteIds: [], intervalValue: 10, intervalUnit: 'minutes' });
    render();
    notify();
    const picker = container.lastElementChild.querySelector('details');
    picker.open = true;
    picker.querySelector('input').focus();
  });
  return {
    setRules(next) { rules = structuredClone(next ?? []); render(); },
    setSites(next) { sites = next; render(); },
    getRules() { return structuredClone(rules); },
  };
}
