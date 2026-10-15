import test from 'node:test';
import assert from 'node:assert/strict';

import { createSnapshotService } from '../src/snapshots.mjs';

test('snapshot service refreshes and stores new-api snapshots with the new-api adapter', async () => {
  const site = { id: 'site-new-api', type: 'new-api' };
  const saved = [];
  const normalizedSnapshot = {
    siteId: 'site-new-api',
    balanceAmount: 5,
    refreshedAt: '2026-07-04T04:30:00.000Z',
  };
  const rawPayload = {
    profile: { success: true, data: { quota: 2500000 } },
  };
  const service = createSnapshotService({
    adapters: {
      newApi: async (input) => {
        assert.deepEqual(input, site);
        return {
          rawPayload,
          normalizedSnapshot,
          fetchedAt: '2026-07-04T04:30:00.000Z',
        };
      },
    },
    snapshotRepository: {
      async saveSnapshot(input) {
        saved.push(input);
      },
    },
  });

  const snapshot = await service.refreshSnapshot(site);

  assert.deepEqual(snapshot, normalizedSnapshot);
  assert.deepEqual(saved, [
    {
      site,
      rawPayload,
      normalizedSnapshot,
      fetchedAt: '2026-07-04T04:30:00.000Z',
    },
  ]);
});

test('snapshot service persists refreshed sub2api auth tokens returned by adapter', async () => {
  const site = { id: 'site-sub2api', type: 'sub2api', authToken: 'expired', refreshToken: 'rt-old' };
  const tokenUpdates = [];
  const normalizedSnapshot = {
    siteId: 'site-sub2api',
    balanceAmount: 12,
    refreshedAt: '2026-07-04T05:00:00.000Z',
  };
  const service = createSnapshotService({
    adapters: {
      sub2api: async (input) => {
        assert.deepEqual(input, site);
        return {
          rawPayload: { profile: { code: 0, data: { balance: 12 } } },
          normalizedSnapshot,
          fetchedAt: '2026-07-04T05:00:00.000Z',
          authUpdate: {
            authToken: 'fresh-access-token',
            refreshToken: 'rt-fresh',
          },
        };
      },
    },
    snapshotRepository: {
      async saveSnapshot() {},
    },
    siteRepository: {
      async updateSiteAuthTokens(id, tokens) {
        tokenUpdates.push({ id, tokens });
      },
    },
  });

  const snapshot = await service.refreshSnapshot(site);

  assert.deepEqual(snapshot, normalizedSnapshot);
  assert.deepEqual(tokenUpdates, [
    {
      id: 'site-sub2api',
      tokens: {
        authToken: 'fresh-access-token',
        refreshToken: 'rt-fresh',
      },
    },
  ]);
});

test('snapshot service serializes same-site sub2api refreshes and reloads latest tokens inside the lock', async () => {
  const requestedTokens = [];
  const site = { id: 'site-sub2api', type: 'sub2api', authToken: 'expired', refreshToken: 'rt-old' };
  const latestSites = [
    { ...site, authToken: 'expired', refreshToken: 'rt-old' },
    { ...site, authToken: 'fresh-access-token', refreshToken: 'rt-fresh' },
  ];
  let resolveFirstAdapterEntered;
  const firstAdapterEntered = new Promise((resolve) => {
    resolveFirstAdapterEntered = resolve;
  });
  let releaseFirstAdapter;
  const firstAdapterCanFinish = new Promise((resolve) => {
    releaseFirstAdapter = resolve;
  });
  const service = createSnapshotService({
    adapters: {
      sub2api: async (input) => {
        requestedTokens.push(input.refreshToken);
        if (requestedTokens.length === 1) {
          resolveFirstAdapterEntered();
          await firstAdapterCanFinish;
          return {
            rawPayload: { profile: { code: 0, data: { balance: 12 } } },
            normalizedSnapshot: { siteId: site.id, balanceAmount: 12, refreshedAt: '2026-07-04T05:00:00.000Z' },
            fetchedAt: '2026-07-04T05:00:00.000Z',
            authUpdate: {
              authToken: 'fresh-access-token',
              refreshToken: 'rt-fresh',
              rotatedAt: '2026-07-04T05:00:00.000Z',
            },
          };
        }
        return {
          rawPayload: { profile: { code: 0, data: { balance: 13 } } },
          normalizedSnapshot: { siteId: site.id, balanceAmount: 13, refreshedAt: '2026-07-04T05:01:00.000Z' },
          fetchedAt: '2026-07-04T05:01:00.000Z',
        };
      },
    },
    snapshotRepository: {
      async saveSnapshot() {},
    },
    siteRepository: {
      async getSiteById() {
        return latestSites.shift();
      },
      async updateSiteAuthTokens() {},
    },
  });

  const firstRefresh = service.refreshSnapshot(site);
  await firstAdapterEntered;
  const secondRefresh = service.refreshSnapshot(site);
  releaseFirstAdapter();
  await Promise.all([firstRefresh, secondRefresh]);

  assert.deepEqual(requestedTokens, ['rt-old', 'rt-fresh']);
});

test('snapshot service serializes same-site new-api refreshes before calling the upstream adapter', async () => {
  const site = { id: 'site-new-api', type: 'new-api' };
  let adapterCalls = 0;
  let resolveFirstAdapterEntered;
  const firstAdapterEntered = new Promise((resolve) => {
    resolveFirstAdapterEntered = resolve;
  });
  let releaseFirstAdapter;
  const firstAdapterCanFinish = new Promise((resolve) => {
    releaseFirstAdapter = resolve;
  });
  const service = createSnapshotService({
    adapters: {
      newApi: async () => {
        adapterCalls += 1;
        if (adapterCalls === 1) {
          resolveFirstAdapterEntered();
          await firstAdapterCanFinish;
        }
        return {
          rawPayload: { data: { quota: adapterCalls } },
          normalizedSnapshot: { siteId: site.id, balanceAmount: adapterCalls },
          fetchedAt: '2026-07-11T00:00:00.000Z',
        };
      },
    },
    snapshotRepository: {
      async saveSnapshot() {},
    },
  });

  const firstRefresh = service.refreshSnapshot(site);
  await firstAdapterEntered;
  const secondRefresh = service.refreshSnapshot(site);
  await Promise.resolve();
  assert.equal(adapterCalls, 1);

  releaseFirstAdapter();
  await Promise.all([firstRefresh, secondRefresh]);
  assert.equal(adapterCalls, 2);
});

test('snapshot service passes fallback login username and persists new-api auth updates', async () => {
  const site = { id: 'site-new-api', type: 'new-api', username: '175' };
  const tokenUpdates = [];
  const adapterCalls = [];
  const service = createSnapshotService({
    adapters: {
      newApi: async (input, options) => {
        adapterCalls.push({ input, options });
        return {
          rawPayload: {},
          normalizedSnapshot: { siteId: site.id, refreshedAt: '2026-07-23T00:00:00.000Z' },
          fetchedAt: '2026-07-23T00:00:00.000Z',
          authUpdate: {
            authToken: 'session=NEW',
            refreshToken: '',
            rotatedAt: '2026-07-23T00:00:00.000Z',
          },
        };
      },
    },
    snapshotRepository: {
      async getLatestSnapshot() {
        return { profile: { username: 'user@example.com' } };
      },
      async saveSnapshot() {},
    },
    siteRepository: {
      async updateSiteAuthTokens(id, tokens) {
        tokenUpdates.push({ id, tokens });
      },
    },
  });

  await service.refreshSnapshot(site);

  assert.deepEqual(adapterCalls[0].options, { fallbackLoginUsername: 'user@example.com' });
  assert.deepEqual(tokenUpdates, [
    {
      id: site.id,
      tokens: {
        authToken: 'session=NEW',
        refreshToken: '',
        rotatedAt: '2026-07-23T00:00:00.000Z',
      },
    },
  ]);
});

test('snapshot service routes credential-flow sub2api sites to the flow adapter', async () => {
  const site = { id: 'site-flow', type: 'sub2api', syncVariant: 'credential-flow' };
  const calls = { standard: 0, flow: 0 };
  const service = createSnapshotService({
    adapters: {
      sub2api: async () => {
        calls.standard += 1;
        throw new Error('should not be used');
      },
      sub2apiFlow: async (input) => {
        calls.flow += 1;
        return {
          rawPayload: {},
          normalizedSnapshot: { siteId: site.id, refreshedAt: '2026-07-24T00:00:00.000Z' },
          fetchedAt: '2026-07-24T00:00:00.000Z',
          authUpdate: { authToken: 'fresh', refreshToken: 'rt', rotatedAt: '2026-07-24T00:00:00.000Z' },
        };
      },
    },
    snapshotRepository: {
      async saveSnapshot() {},
    },
    siteRepository: {
      async updateSiteAuthTokens() {},
    },
  });

  const snapshot = await service.refreshSnapshot(site);
  assert.equal(calls.flow, 1);
  assert.equal(calls.standard, 0);
  assert.equal(snapshot.siteId, 'site-flow');
});

test('snapshot service invokes onSnapshotSaved hook after saving and tolerates hook failure', async () => {
  const site = { id: 'site-hook', type: 'sub2api' };
  const normalizedSnapshot = { siteId: site.id, groups: [], refreshedAt: '2026-08-03T00:00:00.000Z' };
  const hookCalls = [];
  const failingService = createSnapshotService({
    adapters: {
      sub2api: async () => ({
        rawPayload: {},
        normalizedSnapshot,
        fetchedAt: '2026-08-03T00:00:00.000Z',
      }),
    },
    snapshotRepository: {
      async saveSnapshot() {},
    },
    onSnapshotSaved: async () => {
      throw new Error('hook exploded');
    },
  });

  // 钩子失败不阻断刷新
  const snapshot = await failingService.refreshSnapshot(site);
  assert.deepEqual(snapshot, normalizedSnapshot);

  const okService = createSnapshotService({
    adapters: {
      sub2api: async () => ({
        rawPayload: {},
        normalizedSnapshot,
        fetchedAt: '2026-08-03T00:00:00.000Z',
      }),
    },
    snapshotRepository: {
      async saveSnapshot() {},
    },
    onSnapshotSaved: async (event) => {
      hookCalls.push(event);
    },
  });

  await okService.refreshSnapshot(site);
  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0].site.id, 'site-hook');
  assert.deepEqual(hookCalls[0].snapshot, normalizedSnapshot);
});
