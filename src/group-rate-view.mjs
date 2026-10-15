import { createRateHistoryTable } from './rate-history-table.mjs';
import { formatMultiplier } from './currency-display.mjs';
import { APP_PATHS } from './client-route.mjs';

export const RATE_CHANGE_PAGE_SIZE = 50;
export const RATE_CHANGE_POLL_MS = 45_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function readRateChangeFilters(search = '') {
  const params = new URLSearchParams(search);
  return {
    siteId: params.get('siteId') ?? '',
    q: (params.get('q') ?? '').trim(),
    direction: ['up', 'down'].includes(params.get('direction')) ? params.get('direction') : '',
    window: params.get('window') === '24h' ? '24h' : 'all',
  };
}

export function rateChangeQuery({ filters = {}, page = 1, asOf = null, snapshot = null } = {}) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(RATE_CHANGE_PAGE_SIZE) });
  for (const field of ['siteId', 'q', 'direction']) {
    if (filters[field]) params.set(field, filters[field]);
  }
  if (filters.window === '24h') params.set('window', '24h');
  if (asOf) params.set('asOf', asOf);
  if (snapshot) params.set('snapshot', snapshot);
  return params.toString();
}

export function rateChangeDisplay(item) {
  const oldValue = Number(item.oldMultiplier);
  const newValue = Number(item.newMultiplier);
  const direction = newValue > oldValue ? 'up' : newValue < oldValue ? 'down' : 'same';
  // 事件已经按同一汇率转换；不再使用当前站点汇率。百分比取原倍率，避免转换噪声。
  const rawOld = Number(item.rawOldMultiplier ?? oldValue);
  const rawNew = Number(item.rawNewMultiplier ?? newValue);
  let percent = '无变化';
  if (direction !== 'same') {
    if (rawOld === 0) {
      percent = '零基数 · 涨幅不适用';
    } else {
      const change = Math.abs((rawNew - rawOld) / rawOld * 100);
      const label = direction === 'up' ? '上涨' : '下跌';
      percent = !Number.isFinite(change)
        ? `${label} · 幅度超出显示范围`
        : `${label} ${change > 0 && change < 0.01 ? '<0.01' : change.toFixed(2)}%`;
    }
  }
  return { old: formatMultiplier(oldValue), new: formatMultiplier(newValue), direction, percent };
}

export function rateChangeTime(changedAt, now = Date.now()) {
  const timestamp = Date.parse(changedAt);
  if (!Number.isFinite(timestamp)) return { relative: '时间未知', exact: String(changedAt ?? '') };
  const elapsed = Math.max(0, now - timestamp);
  const relative = elapsed < 60_000 ? '刚刚'
    : elapsed < 3_600_000 ? `${Math.floor(elapsed / 60_000)}分钟前`
      : elapsed < DAY_MS ? `${Math.floor(elapsed / 3_600_000)}小时前`
        : `${Math.floor(elapsed / DAY_MS)}天前`;
  const exact = new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
  return { relative, exact };
}

/** 独立的只读分页数据源；请求代际隔离保证取消不被传输支持时旧响应也不能覆盖。 */
export function createRateChangeFeed({ fetch: fetcher, onChange = () => {}, now = Date.now, requestTimeoutMs = 15_000 }) {
  const state = {
    items: [], total: 0, page: 1, pages: 1, asOf: null, snapshot: null, windowStart: null,
    receivedAt: null, loading: false, error: '',
  };
  let generation = 0;
  let controller;
  let timeout;
  function cancel() {
    generation += 1;
    controller?.abort();
    clearTimeout(timeout);
    state.loading = false;
  }
  async function load({ filters = {}, page = 1, append = false, asOf = null, snapshot = null } = {}) {
    cancel();
    const requestGeneration = generation;
    controller = new AbortController();
    const requestController = controller;
    let timedOut = false;
    const requestTimeout = setTimeout(() => {
      timedOut = true;
      requestController.abort();
    }, requestTimeoutMs);
    timeout = requestTimeout;
    const upperBound = asOf ?? (page > 1 ? state.asOf : null);
    const visibility = snapshot ?? (page > 1 ? state.snapshot : null);
    state.loading = true;
    state.error = '';
    if (!append) {
      Object.assign(state, { items: [], total: 0, page, pages: 1, asOf: null, snapshot: null, receivedAt: null });
    }
    onChange(state);
    try {
      const response = await fetcher(`/api/group-rate-changes?${rateChangeQuery({ filters, page, asOf: upperBound, snapshot: visibility })}`, {
        method: 'GET', cache: 'no-store', signal: requestController.signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      if (!Array.isArray(payload.items) || !Number.isFinite(Date.parse(payload.asOf))) {
        throw new Error('倍率变更接口返回格式错误');
      }
      if (requestGeneration !== generation) return false;
      const items = append ? [...state.items, ...payload.items] : payload.items;
      // 滚动加载可能触发多次；去重不影响服务器排序和页数。
      const uniqueItems = [...new Map(items.map((item) => [item.id, item])).values()];
      Object.assign(state, {
        items: uniqueItems, total: payload.total, page: payload.page, pages: payload.pages,
        asOf: payload.asOf, snapshot: payload.snapshot ?? null, windowStart: payload.windowStart, receivedAt: now(),
      });
      return true;
    } catch (error) {
      if (requestGeneration !== generation) return false;
      state.error = `读取倍率变更失败：${timedOut ? '请求超时，请重试' : error.message}`;
      return false;
    } finally {
      clearTimeout(requestTimeout);
      if (requestGeneration === generation) {
        state.loading = false;
        onChange(state);
      }
    }
  }
  return { state, load, cancel };
}

/** 看板、历史筛选、生命周期由此模块统一管理，不介入快照/同步的成功判定。 */
export function createGroupRateView({ document: doc, window: win, fetch: fetcher = win.fetch.bind(win), copySiteUrl }) {
  const el = (id) => doc.getElementById(id);
  const card = el('rate-change-card');
  const panel = el('rate-changes-panel');
  const summary = el('fleet-summary');
  const dashboardScroll = el('rate-change-dashboard');
  const dashboardList = el('rate-change-dashboard-list');
  const dashboardStatus = el('rate-change-dashboard-status');
  const loadMore = el('rate-change-load-more');
  const historyScroll = el('rate-change-history-scroll');
  const historyStatus = el('rate-change-history-status');
  const siteSelect = el('rate-filter-site');
  const queryInput = el('rate-filter-query');
  const directionSelect = el('rate-filter-direction');
  const windowSelect = el('rate-filter-window');
  const prev = el('rate-change-prev');
  const next = el('rate-change-next');
  const refresh = el('refresh-rate-changes');
  let section = '';
  let filters = readRateChangeFilters();
  let sites = [];
  let pollTimer = null;
  let searchTimer = null;
  let retryHistoryPage = 1;
  let retryHistoryAsOf = null;
  let retryHistorySnapshot = null;
  const historyTable = createRateHistoryTable({ document: doc, fetch: fetcher, displayRate: rateChangeDisplay, displayTime: rateChangeTime, copySiteUrl });
  const dashboard = createRateChangeFeed({ fetch: fetcher, onChange: renderDashboard });
  const history = createRateChangeFeed({ fetch: fetcher, onChange: renderHistory });

  function node(tag, className, text) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function serverNow(feed) {
    return feed.asOf ? Date.parse(feed.asOf) + (Date.now() - feed.receivedAt) : Date.now();
  }
  function dashboardEventRow(item, now) {
    const display = rateChangeDisplay(item);
    const time = rateChangeTime(item.changedAt, now);
    const row = node('article', `rate-event rate-${display.direction} rate-event-compact`);
    row.dataset.eventId = item.id;
    const identity = node('div', 'rate-event-identity');
    const group = node('h4', 'rate-event-group', item.groupName || item.groupId || '未命名分组');
    group.title = group.textContent;
    const meta = node('div', 'rate-event-meta');
    const site = node('span', 'rate-event-site', item.siteName || '已删除站点');
    site.title = site.textContent;
    meta.append(site, node('span', 'rate-site-type', item.siteType || '其他'));
    const timestamp = node('time', 'rate-event-time', time.relative);
    timestamp.dateTime = String(item.changedAt ?? '');
    timestamp.title = time.exact;
    timestamp.setAttribute('aria-label', `${time.relative}，${time.exact}`);
    identity.append(group, meta);
    const values = node('div', 'rate-event-values');
    const multiplier = node('div', 'rate-event-multiplier');
    multiplier.append(node('span', 'rate-old', `${display.old}×`), node('span', 'rate-arrow', '→'), node('b', 'rate-new', `${display.new}×`));
    values.append(multiplier, node('span', 'rate-event-percent', display.percent));
    row.append(identity, timestamp, values);
    return row;
  }
  function status(container, feed, { empty, retry, remaining = false }) {
    container.replaceChildren();
    if (feed.error) {
      const message = node('span', 'rate-error', feed.error);
      const button = node('button', 'rate-text-button', '重试');
      button.type = 'button';
      button.addEventListener('click', retry);
      container.append(message, button);
    } else if (feed.loading) {
      container.append(node('span', 'rate-loading', '正在读取倍率变更…'));
    } else if (!feed.items.length) {
      container.append(node('span', '', empty));
    } else if (!remaining) {
      container.append(node('span', 'rate-end', '已显示本时段全部变更'));
    }
    container.hidden = !container.childNodes.length;
  }
  function renderDashboard(feed) {
    const currentTime = serverNow(feed);
    const visible = feed.items.filter((item) => Date.parse(item.changedAt) > currentTime - DAY_MS);
    dashboardList.replaceChildren(...visible.map((item) => dashboardEventRow(item, currentTime)));
    el('rate-change-count').textContent = feed.loading && !feed.items.length ? '…' : feed.error && !feed.items.length ? '—' : String(feed.total);
    dashboardScroll.setAttribute('aria-busy', String(feed.loading));
    const remaining = feed.page < feed.pages;
    loadMore.hidden = !remaining || Boolean(feed.error);
    loadMore.disabled = feed.loading;
    status(dashboardStatus, { ...feed, items: visible }, {
      empty: '最近24小时暂无倍率变更', remaining,
      retry: () => feed.items.length ? loadDashboardMore() : reloadDashboard(),
    });
  }
  function renderHistory(feed) {
    historyTable.render(feed.items, serverNow(feed));
    historyScroll.setAttribute('aria-busy', String(feed.loading));
    prev.disabled = feed.loading || Boolean(feed.error) || feed.page <= 1;
    next.disabled = feed.loading || Boolean(feed.error) || feed.page >= feed.pages;
    refresh.disabled = feed.loading;
    el('rate-change-page-info').textContent = feed.loading ? '正在加载…' : feed.error ? '记录加载失败' : `共 ${feed.total} 条 · 第 ${feed.page} / ${feed.pages} 页 · 每页 ${RATE_CHANGE_PAGE_SIZE} 条`;
    status(historyStatus, feed, {
      empty: '暂无符合筛选条件的倍率变更', remaining: true,
      retry: () => loadHistory(retryHistoryPage, retryHistoryAsOf, retryHistorySnapshot),
    });
    setSites(sites);
  }
  function setSites(newSites) {
    sites = newSites;
    const options = new Map(sites.map((site) => [site.id, site.name]));
    for (const item of history.state.items) if (!options.has(item.siteId)) options.set(item.siteId, item.siteName);
    if (filters.siteId && !options.has(filters.siteId)) options.set(filters.siteId, '历史站点');
    const optionNodes = [new win.Option('全部站点', '')];
    for (const [id, name] of options) optionNodes.push(new win.Option(name, id));
    siteSelect.replaceChildren(...optionNodes);
    siteSelect.value = filters.siteId;
  }
  function reloadDashboard() {
    if (section !== 'sites' || doc.hidden) return Promise.resolve(false);
    dashboardScroll.scrollTop = 0;
    return dashboard.load({ filters: { window: '24h' } });
  }
  function loadDashboardMore() {
    const feed = dashboard.state;
    if (section !== 'sites' || doc.hidden || feed.loading || feed.page >= feed.pages) return;
    return dashboard.load({ filters: { window: '24h' }, page: feed.page + 1, append: true });
  }
  function loadHistory(page = 1, asOf = null, snapshot = null) {
    retryHistoryPage = page;
    retryHistoryAsOf = asOf;
    retryHistorySnapshot = snapshot;
    historyScroll.scrollTop = 0;
    return history.load({ filters, page, asOf, snapshot });
  }
  function writeHistoryLocation({ page = 1, asOf = null, snapshot = null, replace = false } = {}) {
    const params = new URLSearchParams();
    for (const key of ['siteId', 'q', 'direction']) if (filters[key]) params.set(key, filters[key]);
    if (filters.window === '24h') params.set('window', '24h');
    if (page > 1) params.set('page', String(page));
    if (asOf) params.set('asOf', asOf);
    if (snapshot) params.set('snapshot', snapshot);
    const query = params.size ? `?${params}` : '';
    win.history[replace ? 'replaceState' : 'pushState']({}, '', `${APP_PATHS.rateChanges}${query}`);
  }
  function applyFilters() {
    win.clearTimeout(searchTimer);
    if (section !== 'rate-changes') return;
    filters = {
      siteId: siteSelect.value, q: queryInput.value.trim(),
      direction: directionSelect.value, window: windowSelect.value,
    };
    writeHistoryLocation();
    void loadHistory();
  }
  function resetPolling() {
    if (pollTimer !== null) win.clearInterval(pollTimer);
    pollTimer = null;
    if (section === 'sites' && !doc.hidden) {
      pollTimer = win.setInterval(() => {
        if (!dashboard.state.loading) void reloadDashboard();
      }, RATE_CHANGE_POLL_MS);
    }
  }
  function setRoute(nextSection, search = '') {
    win.clearTimeout(searchTimer);
    const entering = section !== nextSection;
    section = nextSection;
    card.hidden = section !== 'sites';
    panel.classList.toggle('hidden', section !== 'rate-changes');
    summary.hidden = section === 'rate-changes';
    summary.classList.toggle('has-rate-changes', section === 'sites');
    doc.querySelector('.workspace').classList.toggle('rate-history-workspace', section === 'rate-changes');
    resetPolling();
    if (section === 'sites') {
      history.cancel();
      if (entering) void reloadDashboard();
    } else {
      dashboard.cancel();
      if (section === 'rate-changes') {
        void historyTable.loadPreferences({ reload: entering });
        filters = readRateChangeFilters(search);
        queryInput.value = filters.q;
        directionSelect.value = filters.direction;
        windowSelect.value = filters.window;
        setSites(sites);
        const params = new URLSearchParams(search);
        const page = /^[1-9]\d*$/.test(params.get('page') ?? '') ? Number(params.get('page')) : 1;
        void loadHistory(page, params.get('asOf'), params.get('snapshot'));
      } else {
        history.cancel();
      }
    }
  }
  function onVisibility() {
    resetPolling();
    if (doc.hidden) {
      if (section === 'sites') dashboard.cancel();
    } else if (section === 'sites') {
      void reloadDashboard();
    }
  }
  dashboardScroll.addEventListener('scroll', () => {
    if (dashboardScroll.scrollTop + dashboardScroll.clientHeight >= dashboardScroll.scrollHeight - 24) {
      if (!dashboard.state.error) void loadDashboardMore();
    }
  });
  loadMore.addEventListener('click', loadDashboardMore);
  el('rate-change-filters').addEventListener('submit', (event) => { event.preventDefault(); applyFilters(); });
  for (const select of [siteSelect, directionSelect, windowSelect]) select.addEventListener('change', applyFilters);
  queryInput.addEventListener('input', () => {
    win.clearTimeout(searchTimer);
    // 输入时立即失效旧请求，而不是等待防抖窗口后让旧筛选闪回。
    history.cancel();
    searchTimer = win.setTimeout(applyFilters, 250);
  });
  prev.addEventListener('click', () => {
    const page = history.state.page - 1;
    const asOf = history.state.asOf;
    const snapshot = history.state.snapshot;
    writeHistoryLocation({ page, asOf, snapshot });
    void loadHistory(page, asOf, snapshot);
  });
  next.addEventListener('click', () => {
    const page = history.state.page + 1;
    const asOf = history.state.asOf;
    const snapshot = history.state.snapshot;
    writeHistoryLocation({ page, asOf, snapshot });
    void loadHistory(page, asOf, snapshot);
  });
  refresh.addEventListener('click', () => {
    void historyTable.loadPreferences({ reload: true });
    writeHistoryLocation({ replace: true });
    void loadHistory();
  });
  doc.addEventListener('visibilitychange', onVisibility);
  return {
    setRoute, setSites,
    refreshAfterSnapshots() {
      if (section === 'sites') return reloadDashboard();
      if (section === 'rate-changes') {
        writeHistoryLocation({ replace: true });
        return loadHistory();
      }
      return Promise.resolve(false);
    },
    destroy() {
      historyTable.destroy();
      dashboard.cancel();
      history.cancel();
      win.clearInterval(pollTimer);
      win.clearTimeout(searchTimer);
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
