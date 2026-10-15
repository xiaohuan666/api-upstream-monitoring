import { DEFAULT_RATE_HISTORY_COLUMN_ORDER, normalizeRateHistoryPreferences } from './rate-history-preferences.mjs';

const ENDPOINT = '/api/ui-preferences/rate-change-history';

/** Same index semantics for mouse, touch buttons and keyboard column moves. */
export function reorderRateHistoryColumns(order, key, targetIndex) {
  const normalized = normalizeRateHistoryPreferences({ columnOrder: order }).columnOrder;
  const index = normalized.indexOf(key);
  if (index < 0 || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= normalized.length) return normalized;
  normalized.splice(index, 1);
  normalized.splice(targetIndex, 0, key);
  return normalized;
}

/** Serial writes keep an older save from overwriting a newer drag; no localStorage shadow state. */
export function createRateHistoryColumnState({ fetch: fetcher, onChange = () => {} }) {
  const state = { columnOrder: [...DEFAULT_RATE_HISTORY_COLUMN_ORDER], loaded: false, status: 'idle', error: '' };
  let generation = 0;
  let loadPromise = null;
  let savePromise = null;
  let revision = 0;
  let savedRevision = 0;
  let disposed = false;
  const notify = () => { if (!disposed) onChange(state); };

  async function load({ reload = false } = {}) {
    if (disposed) return;
    // Re-entry must not replace an unsaved local order; finish its serial writes first.
    if (savePromise) await savePromise;
    if (disposed || savedRevision < revision) return;
    if (loadPromise) return loadPromise;
    if (state.loaded && !reload) return;
    const currentGeneration = ++generation;
    state.loaded = false;
    state.status = 'loading';
    state.error = '';
    notify();
    loadPromise = (async () => {
      try {
        const response = await fetcher(ENDPOINT, { cache: 'no-store' });
        if (!response.ok) throw new Error('读取失败');
        const payload = await response.json();
        if (!payload?.preference?.preferences || typeof payload.preference.preferences !== 'object' || Array.isArray(payload.preference.preferences)) throw new Error('无效偏好');
        if (disposed || currentGeneration !== generation) return;
        state.columnOrder = normalizeRateHistoryPreferences(payload.preference.preferences).columnOrder;
        state.loaded = true;
        state.status = 'ready';
      } catch {
        if (disposed || currentGeneration !== generation) return;
        state.status = 'error';
        state.error = '列顺序读取失败，重试后才能调整';
      } finally {
        loadPromise = null;
        notify();
      }
    })();
    return loadPromise;
  }

  function save() {
    if (disposed || !state.loaded) return Promise.resolve();
    if (savePromise) return savePromise;
    savePromise = (async () => {
      while (!disposed && savedRevision < revision) {
        const savingRevision = revision;
        const columnOrder = [...state.columnOrder];
        state.status = 'saving';
        state.error = '';
        notify();
        try {
          const response = await fetcher(ENDPOINT, {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ columnOrder }),
          });
          if (!response.ok) throw new Error('保存失败');
          const payload = await response.json();
          const stored = payload?.preference?.preferences?.columnOrder;
          if (!Array.isArray(stored) || stored.join('|') !== columnOrder.join('|')) throw new Error('保存结果不一致');
          if (disposed) return;
          savedRevision = savingRevision;
        } catch {
          if (!disposed) {
            state.status = 'error';
            state.error = '列顺序未保存，点击重试';
            notify();
          }
          return;
        }
      }
      if (!disposed) {
        state.status = 'saved';
        notify();
      }
    })().finally(() => { savePromise = null; });
    return savePromise;
  }

  function move(key, targetIndex) {
    if (disposed || !state.loaded) return;
    const next = reorderRateHistoryColumns(state.columnOrder, key, targetIndex);
    if (next.join('|') === state.columnOrder.join('|')) return;
    state.columnOrder = next;
    revision += 1;
    // Render the new order immediately; a response only acknowledges its own revision.
    notify();
    void save();
  }
  return {
    state, load, move,
    retry: () => state.loaded ? save() : load(),
    destroy() { disposed = true; generation += 1; },
  };
}
