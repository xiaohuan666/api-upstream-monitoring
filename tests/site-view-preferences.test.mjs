import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SITE_VIEW_PREFERENCES,
  SITE_VIEW_PREFERENCE_KEY,
  normalizeSiteViewPreferences,
} from '../src/site-view-preferences.mjs';

test('normalizeSiteViewPreferences keeps valid site filters', () => {
  const preferences = normalizeSiteViewPreferences({
    sitesSiteFilter: ['site-1', 'site-2'],
    sitesWatchFilter: '1',
  });

  assert.equal(SITE_VIEW_PREFERENCE_KEY, 'site-management');
  assert.deepEqual(preferences, { sitesSiteFilter: ['site-1', 'site-2'], sitesWatchFilter: '1' });
});

test('normalizeSiteViewPreferences falls back for missing values', () => {
  assert.deepEqual(normalizeSiteViewPreferences(), DEFAULT_SITE_VIEW_PREFERENCES);
  assert.deepEqual(normalizeSiteViewPreferences({}), DEFAULT_SITE_VIEW_PREFERENCES);
});

test('sitesWatchFilter falls back to all for invalid values', () => {
  assert.deepEqual(
    normalizeSiteViewPreferences({ sitesWatchFilter: 'watched' }),
    { sitesSiteFilter: [], sitesWatchFilter: 'all' },
  );
  assert.deepEqual(
    normalizeSiteViewPreferences({ sitesWatchFilter: '0' }),
    { sitesSiteFilter: [], sitesWatchFilter: '0' },
  );
});

test('sitesSiteFilter normalizes comma strings, blanks and duplicates', () => {
  assert.deepEqual(
    normalizeSiteViewPreferences({ sitesSiteFilter: 'site-1, site-2 ,,site-1' }),
    { sitesSiteFilter: ['site-1', 'site-2'], sitesWatchFilter: 'all' },
  );
  assert.deepEqual(
    normalizeSiteViewPreferences({ sitesSiteFilter: ['site-1', '', 'site-1', ' '] }),
    { sitesSiteFilter: ['site-1'], sitesWatchFilter: 'all' },
  );
  assert.deepEqual(
    normalizeSiteViewPreferences({ sitesSiteFilter: 42 }),
    { sitesSiteFilter: ['42'], sitesWatchFilter: 'all' },
  );
});
