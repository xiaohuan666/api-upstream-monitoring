import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTolerantSnapshots,
  loadStoredDataCandidate,
  refreshActiveSnapshotAndReload,
  refreshAllSnapshotsAndReload,
  reloadStoredDataStrict,
  reloadTablesFromDatabase,
  summarizeRefreshCompletion,
} from '../src/client-refresh.mjs';

test('refreshActiveSnapshotAndReload refreshes active upstream before reloading stored snapshots', async () => {
  const calls = [];
  const site = { id: 'site-active' };

  await refreshActiveSnapshotAndReload({
    site,
    refreshSnapshot: async (input) => {
      calls.push(['refresh', input.id]);
    },
    reloadStoredSnapshots: async () => {
      calls.push(['reload']);
    },
  });

  assert.deepEqual(calls, [
    ['refresh', 'site-active'],
    ['reload'],
  ]);
});

test('refreshActiveSnapshotAndReload does not reload stored snapshots when active refresh fails', async () => {
  const calls = [];
  const site = { id: 'site-active' };

  await assert.rejects(
    refreshActiveSnapshotAndReload({
      site,
      refreshSnapshot: async () => {
        calls.push(['refresh']);
        throw new Error('upstream failed');
      },
      reloadStoredSnapshots: async () => {
        calls.push(['reload']);
      },
    }),
    /upstream failed/,
  );

  assert.deepEqual(calls, [['refresh']]);
});

test('reloadTablesFromDatabase atomically applies saved data without an upstream refresh step', async () => {
  const calls = [];
  const sites = [{ id: 'site-1' }];
  const groupSettings = [{ siteId: 'site-1', groupId: 'group-1', selectedModel: 'gpt-5' }];
  const snapshots = { 'site-1': { balance: 42 } };

  await reloadTablesFromDatabase({
    readSites: async () => {
      calls.push('read-sites');
      return sites;
    },
    readGroupSettingsForSite: async (site) => {
      calls.push(['read-group-settings', site]);
      return groupSettings;
    },
    readSnapshotForSite: async (site) => {
      calls.push(['read-snapshot', site]);
      return snapshots[site.id];
    },
    buildReplacement: (candidate) => ({
      sites: candidate.sites,
      groupSettings: candidate.groupSettings,
      snapshots: candidate.snapshots,
    }),
    applyStoredData: async (replacement) => calls.push(['apply', replacement]),
  });

  assert.deepEqual(calls, [
    'read-sites',
    ['read-group-settings', sites[0]],
    ['read-snapshot', sites[0]],
    ['apply', { sites, groupSettings: { 'site-1': groupSettings }, snapshots }],
  ]);
});

test('reloadTablesFromDatabase propagates a group-settings failure without applying replacement state', async () => {
  const currentState = { sites: [{ id: 'current-site' }] };
  let visibleState = currentState;

  await assert.rejects(
    reloadTablesFromDatabase({
      readSites: async () => [{ id: 'replacement-site' }],
      readGroupSettingsForSite: async () => {
        throw new Error('group settings database read failed');
      },
      readSnapshotForSite: async () => ({ siteId: 'replacement-site' }),
      buildReplacement: (candidate) => candidate,
      applyStoredData: async (replacement) => {
        visibleState = replacement;
      },
    }),
    /group settings database read failed/,
  );

  assert.equal(visibleState, currentState);
});

test('candidate loader returns site-scoped structured failures without mutating caller state', async () => {
  const site = { id: 'site-1', name: '站点一' };
  const candidate = await loadStoredDataCandidate({
    readSites: async () => [site],
    readGroupSettingsForSite: async () => {
      throw new Error('group settings unavailable');
    },
    readSnapshotForSite: async () => {
      throw new Error('snapshot unavailable');
    },
  });

  assert.deepEqual(candidate.sites, [site]);
  assert.deepEqual(candidate.groupSettings, {});
  assert.deepEqual(candidate.snapshots, {});
  assert.deepEqual(
    candidate.failures.map(({ site: failedSite, domain, error }) => ({
      site: failedSite,
      domain,
      message: error.message,
    })),
    [
      { site, domain: 'group-settings', message: 'group settings unavailable' },
      { site, domain: 'snapshot', message: 'snapshot unavailable' },
    ],
  );
});

test('strict reload rejects every candidate failure and never applies partial state', async () => {
  const oldVisibleState = { sites: [{ id: 'old-site' }] };
  let visibleState = oldVisibleState;

  await assert.rejects(
    reloadStoredDataStrict({
      loadCandidate: async () => ({
        sites: [{ id: 'new-site' }],
        groupSettings: {},
        snapshots: {},
        failures: [{ site: { id: 'new-site' }, domain: 'snapshot', error: new Error('snapshot unavailable') }],
      }),
      buildReplacement: (candidate) => candidate,
      applyStoredData: async (replacement) => {
        visibleState = replacement;
      },
    }),
    /snapshot unavailable/,
  );

  assert.equal(visibleState, oldVisibleState);
});

test('database table reload converts one snapshot failure, then atomically applies all candidate data once', async () => {
  const calls = [];
  const sites = [{ id: 'site-1' }, { id: 'site-2' }];
  const result = await reloadTablesFromDatabase({
    readSites: async () => {
      calls.push('GET /api/sites');
      return sites;
    },
    readGroupSettingsForSite: async (site) => {
      calls.push(`GET /api/sites/${site.id}/group-model-settings`);
      return [{ siteId: site.id, groupId: 'all' }];
    },
    readSnapshotForSite: async (site) => {
      calls.push(`GET /api/sites/${site.id}/snapshot`);
      if (site.id === 'site-2') throw new Error('snapshot unavailable');
      return { siteId: site.id, balanceAmount: 7 };
    },
    buildReplacement: (candidate) => ({
      sites: candidate.sites,
      groupSettings: candidate.groupSettings,
      snapshots: buildTolerantSnapshots({
        candidate,
        createErrorSnapshot: (site, error) => ({ siteId: site.id, error: error.message }),
      }),
    }),
    applyStoredData: async (input) => {
      calls.push(['apply', input]);
      return input;
    },
  });

  assert.deepEqual(result.replacement.snapshots, {
    'site-1': { siteId: 'site-1', balanceAmount: 7 },
    'site-2': { siteId: 'site-2', error: 'snapshot unavailable' },
  });
  assert.deepEqual(calls, [
    'GET /api/sites',
    'GET /api/sites/site-1/group-model-settings',
    'GET /api/sites/site-2/group-model-settings',
    'GET /api/sites/site-1/snapshot',
    'GET /api/sites/site-2/snapshot',
    ['apply', result.replacement],
  ]);
  assert.equal(result.failures.length, 1);
});

test('database table reload aborts on sites or group-settings failure without applying', async () => {
  let applied = false;

  await assert.rejects(
    reloadTablesFromDatabase({
      readSites: async () => [{ id: 'site-1' }],
      readGroupSettingsForSite: async () => {
        throw new Error('group settings unavailable');
      },
      readSnapshotForSite: async () => ({ siteId: 'site-1' }),
      buildReplacement: (candidate) => candidate,
      applyStoredData: async () => {
        applied = true;
      },
    }),
    /group settings unavailable/,
  );

  assert.equal(applied, false);
});

test('refreshAllSnapshotsAndReload attempts every upstream and reloads stored snapshots after the batch', async () => {
  const calls = [];
  const sites = [{ id: 'site-1' }, { id: 'site-2' }, { id: 'site-3' }];

  const result = await refreshAllSnapshotsAndReload({
    sites,
    refreshSnapshot: async (site) => {
      calls.push(['refresh', site.id]);
      if (site.id === 'site-2') throw new Error('site-2 failed');
    },
    reloadStoredSnapshots: async () => {
      calls.push(['reload']);
    },
  });

  assert.deepEqual(calls, [
    ['refresh', 'site-1'],
    ['refresh', 'site-2'],
    ['refresh', 'site-3'],
    ['reload'],
  ]);
  assert.equal(result.total, 3);
  assert.deepEqual(result.failures, [{ site: sites[1], error: new Error('site-2 failed') }]);
});

test('summarizeRefreshCompletion returns an auto-dismiss success toast when all sites sync', () => {
  assert.deepEqual(
    summarizeRefreshCompletion({ total: 3, failures: [] }),
    {
      type: 'success',
      title: '同步完成',
      message: '已同步 3 个上游，并刷新页面数据。',
      duration: 3000,
    },
  );
});

test('summarizeRefreshCompletion returns a compact warning toast for partial failures', () => {
  const failures = [
    { site: { id: 'a', name: '贾维斯' }, error: new Error('expired') },
    { site: { id: 'b', name: '汪汪中转' }, error: new Error('expired') },
    { site: { id: 'c', name: 'Lucis API' }, error: new Error('expired') },
    { site: { id: 'd', name: 'zz-switch' }, error: new Error('expired') },
  ];

  assert.deepEqual(
    summarizeRefreshCompletion({ total: 8, failures }),
    {
      type: 'warning',
      title: '部分站点同步失败',
      message: '已同步 4/8 个上游，失败 4 个站点：贾维斯、汪汪中转、Lucis API 等',
      duration: 5000,
    },
  );
});
