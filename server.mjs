import { createOAuthOnboardingTables, createOAuthOnboardingStore } from './src/oauth-onboarding-store.mjs';
import { createOAuthOnboardingService } from './src/oauth-onboarding.mjs';
import http from 'node:http';
import { createSiteRefreshScheduler } from './src/site-refresh-scheduler.mjs';

import {
  createPoolFromEnv,
  createGroupModelSettingsRepository,
  createProxyRepository,
  createSiteRepository,
  createSnapshotRepository,
  createUiPreferencesRepository,
  initializeDatabase,
} from './src/db.mjs';
import { createGroupRateChangeRepository } from './src/group-rate-store.mjs';
import { createRequestHandler } from './src/http.mjs';
import { createProxyProbeService } from './src/proxy-probe.mjs';
import { fetchAvailableModels, testModelLatency } from './src/model-probe.mjs';
import { createMySiteAccountService } from './src/my-site-accounts.mjs';
import { createMySiteProxyService } from './src/my-site-proxies.mjs';
import { createMySiteRateSync } from './src/my-site-rate-sync.mjs';
import {
  createMySiteAccountRepository,
  createMySiteProxyRepository,
  createMySiteRepository,
  createMySitesTables,
} from './src/my-sites.mjs';
import { createServerLifecycle } from './src/server-lifecycle.mjs';
import { createSnapshotService } from './src/snapshots.mjs';

const port = Number(process.env.PORT ?? 5173);
const publicDir = new URL('.', import.meta.url);
const pool = createPoolFromEnv();

await initializeDatabase(pool);
await createMySitesTables(pool);
await createOAuthOnboardingTables(pool);

const repository = createSiteRepository(pool);
const proxyRepository = createProxyRepository(pool);
const snapshotRepository = createSnapshotRepository(pool);
const groupRateChangeRepository = createGroupRateChangeRepository(pool);
const groupModelSettingsRepository = createGroupModelSettingsRepository(pool);
const uiPreferencesRepository = createUiPreferencesRepository(pool);
const mySiteRepository = createMySiteRepository(pool);
const mySiteAccountRepository = createMySiteAccountRepository(pool);
const mySiteProxyRepository = createMySiteProxyRepository(pool);
const oauthOnboarding = createOAuthOnboardingService({
  store: createOAuthOnboardingStore(pool), mySiteRepository, proxyRepository, mySiteProxyRepository,
});
const mySiteProxyService = createMySiteProxyService({
  mySiteRepository,
  mySiteProxyRepository,
  proxyRepository,
});
const mySiteRateSync = createMySiteRateSync({ mySiteRepository, mySiteAccountRepository });
const snapshotService = createSnapshotService({
  snapshotRepository,
  siteRepository: repository,
  onSnapshotSaved: (event) => mySiteRateSync.syncSiteRates(event),
});
const mySiteAccountService = createMySiteAccountService({
  mySiteRepository,
  mySiteAccountRepository,
  siteRepository: repository,
  snapshotRepository,
  fetchUpstreamModels: fetchAvailableModels,
});
const autoRefreshScheduler = createSiteRefreshScheduler({
  listSites: () => repository.listSites(),
  refreshSite: (site) => snapshotService.refreshSnapshot(site),
});
const handler = createRequestHandler({
  oauthOnboarding,
  groupRateChangeRepository,
  proxyProbeService: createProxyProbeService({ repository: proxyRepository }),
  publicDir,
  repository,
  proxyRepository,
  snapshotService,
  groupModelSettingsRepository,
  uiPreferencesRepository,
  modelProbe: { fetchAvailableModels, testModelLatency },
  onAutoRefreshSettingsChanged: scheduleAutoRefresh,
  mySites: {
    repository: mySiteRepository,
    accountRepository: mySiteAccountRepository,
    service: mySiteAccountService,
    proxyService: mySiteProxyService,
  },
});
const server = http.createServer(handler);
const lifecycle = createServerLifecycle({
  loadAutoRefreshSettings: () => uiPreferencesRepository.getAutoRefreshSettings(),
  applyAutoRefreshSettings: scheduleAutoRefresh,
  listen: () => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`api-upstream-monitoring listening on http://localhost:${port}`);
    });
  },
  stopScheduler: async () => {
    autoRefreshScheduler.stop();
    await oauthOnboarding.close();
  },
  closeServer: () => server.close(),
  closePool: () => pool.end(),
  exit: (code) => process.exit(code),
});

function scheduleAutoRefresh(settings) {
  const normalizedSettings = autoRefreshScheduler.update(settings);

  if (!normalizedSettings.enabled) {
    console.log('[auto-refresh] disabled');
    return;
  }

  console.log(
    `[auto-refresh] default=${normalizedSettings.intervalValue} ${normalizedSettings.intervalUnit}, rules=${normalizedSettings.rules.length}`,
  );
}

await lifecycle.start();
lifecycle.registerShutdownSignals();
