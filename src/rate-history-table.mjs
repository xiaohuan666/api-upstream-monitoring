import { RATE_HISTORY_COLUMNS } from './rate-history-preferences.mjs';
import { createRateHistoryColumnState } from './rate-history-column-state.mjs';
import { configureExternalLink } from './client-links.mjs';

const PLATFORMS = {
  openai: 'OpenAI', anthropic: 'Anthropic', grok: 'Grok', gemini: 'Gemini',
  deepseek: 'DeepSeek', qwen: 'Qwen', kimi: 'Kimi', minimax: 'MiniMax', doubao: 'Doubao',
};
const COPY_PATH = 'M8 8h11v11H8zM5 15H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1';

/** History table owns only presentation and column preferences; rate polling stays in its caller. */
export function createRateHistoryTable({ document: doc, fetch: fetcher, displayRate, displayTime, copySiteUrl }) {
  const table = doc.getElementById('rate-change-history-table');
  const head = doc.getElementById('rate-change-history-head');
  const body = doc.getElementById('rate-change-history-list');
  const colgroup = doc.getElementById('rate-change-history-columns');
  const status = doc.getElementById('rate-column-status');
  const retry = doc.getElementById('rate-column-retry');
  let items = [];
  let now = Date.now();
  let draggedKey = null;
  let lastOrder = '';
  let lastLoaded = null;
  const preferences = createRateHistoryColumnState({ fetch: fetcher, onChange: renderPreferences });

  function node(tag, className, text) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function safeUrl(value) {
    try {
      const url = new URL(String(value ?? ''));
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : '';
    } catch { return ''; }
  }
  function siteCell(item) {
    const cell = node('div', 'site-name');
    cell.append(node('strong', '', item.siteName || '已删除站点'));
    const url = safeUrl(item.siteUrl);
    const line = node('span', 'site-id site-url-cell');
    if (url) {
      const link = node('a', 'external-link');
      configureExternalLink(link, url);
      const copy = node('button', 'model-action copy-site-url');
      copy.type = 'button';
      copy.title = '复制链接';
      copy.setAttribute('aria-label', `复制 ${item.siteName || '站点'} 链接`);
      copy.dataset.action = 'copy-site-url';
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', COPY_PATH);
      svg.append(path); copy.append(svg);
      copy.addEventListener('click', () => copySiteUrl(url));
      line.append(link, copy);
    } else {
      line.textContent = '链接不可用';
    }
    cell.append(line);
    return cell;
  }
  function cell(item, key, display) {
    const td = node('td', `rate-col-${key}`);
    td.dataset.column = key;
    if (key === 'platform') {
      const platform = Object.hasOwn(PLATFORMS, item.platform) ? item.platform : 'unknown';
      const badge = node('span', `platform-badge ${platform}`, PLATFORMS[platform] || '未识别');
      td.append(badge);
    } else if (key === 'group') {
      const name = node('strong', 'rate-history-group', item.groupName || item.groupId || '未命名分组');
      name.title = name.textContent;
      const time = displayTime(item.changedAt, now);
      const timestamp = node('time', 'rate-event-time', `${time.relative} · ${time.exact}`);
      timestamp.dateTime = String(item.changedAt ?? '');
      timestamp.title = time.exact;
      td.append(name, timestamp);
    } else if (key === 'site') {
      td.append(siteCell(item));
    } else if (key === 'change') {
      const arrow = display.direction === 'up' ? '↑ ' : display.direction === 'down' ? '↓ ' : '';
      td.append(node('span', 'rate-change-badge rate-event-percent', arrow + display.percent));
    } else {
      td.append(node(key === 'new' ? 'strong' : 'span', `rate-${key}`, `${display[key]}×`));
    }
    return td;
  }
  function renderRows() {
    body.replaceChildren(...items.map((item) => {
      const display = displayRate(item);
      const tr = node('tr', `rate-history-row rate-${display.direction}`);
      tr.dataset.eventId = item.id;
      tr.append(...preferences.state.columnOrder.map((key) => cell(item, key, display)));
      return tr;
    }));
  }
  function clearDrag() {
    draggedKey = null;
    for (const th of head.querySelectorAll('th')) th.classList.remove('rate-column-dragging', 'rate-column-drop');
  }
  function renderHeaders(state) {
    const focused = doc.activeElement?.closest('[data-column]');
    const focusKey = focused && head.contains(focused) ? focused.dataset.column : null;
    const focusMove = doc.activeElement?.dataset.move;
    colgroup.replaceChildren(...state.columnOrder.map((key) => node('col', `rate-col-${key}`)));
    head.replaceChildren(...state.columnOrder.map((key, index) => {
      const column = RATE_HISTORY_COLUMNS.find((column) => column.key === key);
      const th = node('th', `rate-col-${key}`);
      th.scope = 'col'; th.dataset.column = key;
      const controls = node('div', 'rate-column-heading');
      const handle = node('button', 'rate-column-handle');
      handle.type = 'button'; handle.disabled = !state.loaded; handle.draggable = state.loaded;
      handle.title = '拖动调整顺序，或按 Alt + 左右方向键';
      handle.setAttribute('aria-label', `${column.label}，拖动或按 Alt 加左右方向键移动`);
      const grip = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      grip.setAttribute('class', 'rate-column-grip'); grip.setAttribute('viewBox', '0 0 10 16');
      grip.setAttribute('aria-hidden', 'true');
      for (const x of [3, 7]) for (const y of [3, 8, 13]) {
        const dot = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y)); dot.setAttribute('r', '1');
        grip.append(dot);
      }
      handle.append(grip, node('span', '', column.label));
      const moves = node('span', 'rate-column-moves');
      for (const [delta, label, symbol] of [[-1, '左移', '‹'], [1, '右移', '›']]) {
        const button = node('button', 'rate-column-move', symbol);
        button.type = 'button'; button.dataset.move = String(delta);
        button.disabled = !state.loaded || index + delta < 0 || index + delta >= state.columnOrder.length;
        button.title = `${label}${column.label}`; button.setAttribute('aria-label', button.title);
        button.addEventListener('click', () => preferences.move(key, index + delta));
        moves.append(button);
      }
      handle.addEventListener('keydown', (event) => {
        if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        preferences.move(key, index + (event.key === 'ArrowLeft' ? -1 : 1));
      });
      handle.addEventListener('dragstart', (event) => {
        if (!state.loaded) { event.preventDefault(); return; }
        draggedKey = key;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', key);
        th.classList.add('rate-column-dragging');
      });
      handle.addEventListener('dragend', clearDrag);
      th.addEventListener('dragover', (event) => {
        if (!draggedKey || draggedKey === key) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        for (const other of head.children) other.classList.toggle('rate-column-drop', other === th);
      });
      th.addEventListener('drop', (event) => {
        if (!draggedKey) return;
        event.preventDefault();
        const source = draggedKey; clearDrag();
        preferences.move(source, index);
      });
      controls.append(handle, moves); th.append(controls);
      return th;
    }));
    if (focusKey) {
      const target = head.querySelector(`[data-column="${focusKey}"] ${focusMove ? `[data-move="${focusMove}"]:not(:disabled)` : '.rate-column-handle'}`)
        || head.querySelector(`[data-column="${focusKey}"] .rate-column-handle`);
      target?.focus({ preventScroll: true });
    }
  }
  function renderPreferences(state) {
    const labels = { idle: '正在读取列顺序…', loading: '正在读取列顺序…', ready: '列顺序已从数据库载入', saving: '正在保存列顺序…', saved: '列顺序已保存到数据库' };
    status.textContent = state.error || labels[state.status];
    status.classList.toggle('rate-error', Boolean(state.error));
    retry.hidden = !state.error;
    retry.disabled = ['loading', 'saving'].includes(state.status);
    const order = state.columnOrder.join('|');
    if (order !== lastOrder || state.loaded !== lastLoaded) {
      renderHeaders(state);
      renderRows();
      lastOrder = order; lastLoaded = state.loaded;
    }
  }
  retry.addEventListener('click', preferences.retry);
  renderPreferences(preferences.state);
  return {
    loadPreferences: preferences.load,
    render(nextItems, currentTime) {
      items = nextItems; now = currentTime;
      table.setAttribute('aria-rowcount', String(items.length + 1));
      renderRows();
    },
    destroy() { preferences.destroy(); retry.removeEventListener('click', preferences.retry); clearDrag(); },
  };
}
