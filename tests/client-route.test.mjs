import test from 'node:test';
import assert from 'node:assert/strict';

import { APP_PATHS, isAppPagePath, resolveAppRoute } from '../src/client-route.mjs';

test('resolveAppRoute maps primary and settings paths to canonical views', () => {
  assert.deepEqual(resolveAppRoute('/'), {
    id: 'sites', canonicalPath: '/sites', section: 'sites', setting: null,
  });
  assert.deepEqual(resolveAppRoute('/groups'), {
    id: 'groups', canonicalPath: '/groups', section: 'groups', setting: null,
  });
  assert.deepEqual(resolveAppRoute('/rate-changes'), {
    id: 'rate-changes', canonicalPath: '/rate-changes', section: 'rate-changes', setting: null,
  });
  assert.deepEqual(resolveAppRoute('/ip-management'), {
    id: 'ip-management', canonicalPath: '/ip-management', section: 'ip-management', setting: null,
  });
  assert.deepEqual(resolveAppRoute('/oauth-tasks'), {
    id: 'oauth-tasks', canonicalPath: '/oauth-tasks', section: 'oauth-tasks', setting: null,
  });
  assert.deepEqual(resolveAppRoute('/oauth-accounts'), {
    id: 'oauth-accounts', canonicalPath: '/oauth-accounts', section: 'oauth-accounts', setting: null,
  });
  assert.deepEqual(resolveAppRoute('/settings'), {
    id: 'settings-proxies', canonicalPath: '/settings/proxies', section: 'settings', setting: 'proxies',
  });
  assert.deepEqual(resolveAppRoute('/settings/auto-refresh'), {
    id: 'settings-auto-refresh', canonicalPath: '/settings/auto-refresh', section: 'settings', setting: 'auto-refresh',
  });
  assert.deepEqual(resolveAppRoute('/settings/oauth-onboarding'), {
    id: 'settings-oauth-onboarding', canonicalPath: '/settings/oauth-onboarding', section: 'settings', setting: 'oauth-onboarding',
  });
  assert.deepEqual(resolveAppRoute('/settings/my-sites'), {
    id: 'settings-my-sites', canonicalPath: '/settings/my-sites', section: 'settings', setting: 'my-sites',
  });
});

test('isAppPagePath accepts only the documented client routes', () => {
  assert.deepEqual(APP_PATHS, {
    root: '/', sites: '/sites', groups: '/groups', rateChanges: '/rate-changes',
    ipManagement: '/ip-management', oauthAccounts: '/oauth-accounts', oauthTasks: '/oauth-tasks', settings: '/settings',
    proxies: '/settings/proxies', autoRefresh: '/settings/auto-refresh', mySites: '/settings/my-sites', oauthSettings: '/settings/oauth-onboarding',
  });
  for (const pathname of Object.values(APP_PATHS)) assert.equal(isAppPagePath(pathname), true);
  assert.equal(resolveAppRoute('/missing'), null);
  assert.equal(isAppPagePath('/settings/missing'), false);
  assert.equal(isAppPagePath('/api/sites'), false);
});

test('removed feature paths no longer resolve as application pages', () => {
  for (const pathname of ['/pricing', '/benchmarks']) {
    assert.equal(resolveAppRoute(pathname), null);
    assert.equal(isAppPagePath(pathname), false);
  }
});
