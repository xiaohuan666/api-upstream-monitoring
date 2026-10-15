const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'];

export function createServerLifecycle({
  loadAutoRefreshSettings,
  applyAutoRefreshSettings,
  listen,
  stopScheduler,
  closeServer,
  closePool,
  exit,
  registerSignal = (signal, handler) => process.on(signal, handler),
  logger = console,
} = {}) {
  async function start() {
    try {
      const preference = await loadAutoRefreshSettings();
      await applyAutoRefreshSettings(preference.preferences);
    } catch (error) {
      logger.error(`[auto-refresh] load settings failed: ${error.message}`);
      await applyAutoRefreshSettings({ enabled: false });
    }
    listen();
  }

  async function shutdown() {
    await stopScheduler();
    await closeServer();
    await closePool();
    exit(0);
  }

  function registerShutdownSignals() {
    for (const signal of SHUTDOWN_SIGNALS) {
      registerSignal(signal, shutdown);
    }
  }

  return { start, shutdown, registerShutdownSignals };
}
