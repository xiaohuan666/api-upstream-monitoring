import {
  autoRefreshIntervalMs,
  normalizeAutoRefreshSettings,
  refreshSettingsForSite,
} from './auto-refresh-settings.mjs';

// Site discovery is bounded independently of configured intervals, including intervals of days.
export function createSiteRefreshScheduler({
  listSites,
  refreshSite,
  timers = globalThis,
  now = Date.now,
  discoveryIntervalMs = 30_000,
  logger = console,
} = {}) {
  if (typeof listSites !== 'function' || typeof refreshSite !== 'function') {
    throw new Error('listSites and refreshSite are required');
  }
  let settings = normalizeAutoRefreshSettings();
  let generation = 0;
  let timer = null;
  let running = false;
  let epoch = now();
  let discovered = false;
  const dueAt = new Map();

  function invalidate() {
    generation += 1;
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  function schedule(delay = 0) {
    if (!settings.enabled || running || timer !== null) return;
    const captured = generation;
    timer = timers.setTimeout(() => tick(captured), delay);
  }

  async function tick(captured) {
    if (captured !== generation || !settings.enabled) return;
    timer = null;
    running = true;
    let listed = false;
    try {
      const sites = (await listSites()).filter((site) => ['sub2api', 'new-api'].includes(site.type));
      if (captured !== generation || !settings.enabled) return;
      const ids = new Set(sites.map((site) => site.id));
      for (const id of dueAt.keys()) if (!ids.has(id)) dueAt.delete(id);
      const baseTime = discovered ? now() : epoch;
      for (const site of sites) {
        if (!dueAt.has(site.id)) {
          dueAt.set(site.id, baseTime + autoRefreshIntervalMs(refreshSettingsForSite(settings, site.id)));
        }
      }
      discovered = true;
      listed = true;
      for (const site of sites) {
        if (captured !== generation || !settings.enabled) break;
        if (dueAt.get(site.id) > now()) continue;
        const interval = refreshSettingsForSite(settings, site.id);
        try {
          await refreshSite(site);
          logger.log(`[auto-refresh] ${site.name}: ok, interval=${interval.intervalValue} ${interval.intervalUnit}`);
        } catch {
          // Adapter failures are logged at the transport boundary; never echo credential-bearing errors here.
          logger.error(`[auto-refresh] ${site.name}: failed, retry in ${interval.intervalValue} ${interval.intervalUnit}`);
        } finally {
          if (captured === generation) dueAt.set(site.id, now() + autoRefreshIntervalMs(interval));
        }
      }
    } catch {
      logger.error('[auto-refresh] list sites failed, will retry');
    } finally {
      running = false;
      let delay = discoveryIntervalMs;
      if (listed) for (const due of dueAt.values()) delay = Math.min(delay, Math.max(0, due - now()));
      schedule(captured === generation ? delay : 0);
    }
  }

  return {
    update(input) {
      invalidate();
      settings = normalizeAutoRefreshSettings(input);
      dueAt.clear();
      epoch = now();
      discovered = false;
      schedule();
      return settings;
    },
    stop() {
      invalidate();
      settings = { ...settings, enabled: false };
      dueAt.clear();
    },
  };
}
