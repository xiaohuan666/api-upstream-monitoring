export const APP_PATHS = Object.freeze({
  root: '/',
  sites: '/sites',
  groups: '/groups',
  rateChanges: '/rate-changes',
  ipManagement: '/ip-management',
  oauthAccounts: '/oauth-accounts',
  oauthTasks: '/oauth-tasks',
  settings: '/settings',
  proxies: '/settings/proxies',
  autoRefresh: '/settings/auto-refresh',
  mySites: '/settings/my-sites',
  oauthSettings: '/settings/oauth-onboarding',
});

const ROUTES = new Map([
  [APP_PATHS.root, route('sites', APP_PATHS.sites, 'sites')],
  [APP_PATHS.sites, route('sites', APP_PATHS.sites, 'sites')],
  [APP_PATHS.rateChanges, route('rate-changes', APP_PATHS.rateChanges, 'rate-changes')],
  [APP_PATHS.groups, route('groups', APP_PATHS.groups, 'groups')],
  [APP_PATHS.ipManagement, route('ip-management', APP_PATHS.ipManagement, 'ip-management')],
  [APP_PATHS.oauthTasks, route('oauth-tasks', APP_PATHS.oauthTasks, 'oauth-tasks')],
  [APP_PATHS.oauthAccounts, route('oauth-accounts', APP_PATHS.oauthAccounts, 'oauth-accounts')],
  [APP_PATHS.settings, route('settings-proxies', APP_PATHS.proxies, 'settings', 'proxies')],
  [APP_PATHS.proxies, route('settings-proxies', APP_PATHS.proxies, 'settings', 'proxies')],
  [APP_PATHS.autoRefresh, route('settings-auto-refresh', APP_PATHS.autoRefresh, 'settings', 'auto-refresh')],
  [APP_PATHS.oauthSettings, route('settings-oauth-onboarding', APP_PATHS.oauthSettings, 'settings', 'oauth-onboarding')],
  [APP_PATHS.mySites, route('settings-my-sites', APP_PATHS.mySites, 'settings', 'my-sites')],
]);

export function resolveAppRoute(pathname) {
  return ROUTES.get(String(pathname ?? '')) ?? null;
}

export function isAppPagePath(pathname) {
  return ROUTES.has(String(pathname ?? ''));
}

function route(id, canonicalPath, section, setting = null) {
  return Object.freeze({ id, canonicalPath, section, setting });
}
