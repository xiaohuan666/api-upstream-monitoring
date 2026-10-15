import test from 'node:test';
import assert from 'node:assert/strict';

import { createMySiteRateSync } from '../src/my-site-rate-sync.mjs';

function createFakes({ links = [], groups = [], mySite = null, remoteAccounts = {}, remoteErrors = {} } = {}) {
  const calls = { updates: [], markSynced: [], deleted: [] };
  const sync = createMySiteRateSync({
    logger: { error() {} },
    mySiteRepository: {
      async getMySiteById() {
        return mySite;
      },
    },
    mySiteAccountRepository: {
      async listAccounts() {
        return links;
      },
      async markRateSynced(id, rate) {
        calls.markSynced.push({ id, rate });
        return { id, lastSyncedRate: rate };
      },
      async deleteAccountById(id) {
        calls.deleted.push(id);
        return true;
      },
    },
    adminClientFactory: () => ({
      async getAccount(accountId) {
        if (remoteErrors[accountId]) throw remoteErrors[accountId];
        return remoteAccounts[accountId];
      },
      async updateAccount(accountId, update) {
        calls.updates.push({ accountId, update });
      },
    }),
  });
  return { sync, calls };
}

const mySite = { id: 'my-site-1', url: 'https://sub.example.com', adminKey: 'k' };
const site = { id: 'site-1', name: '上游站' };

test('sync rewrites account name and rate when upstream group was renamed', async () => {
  const links = [
    { id: 'link-1', mySiteId: 'my-site-1', myAccountId: '42', upstreamGroupId: 'g-1', lastSyncedRate: 0.05 },
  ];
  // 上游分组 狂欢003 → 狂欢004，倍率 0.05 → 0.06
  const groups = [{ id: 'g-1', name: '狂欢004', multiplier: 0.06 }];
  const { sync, calls } = createFakes({
    links,
    groups,
    mySite,
    remoteAccounts: { 42: { id: '42', name: '上游站 · 狂欢003', rateMultiplier: 0.05 } },
  });

  const result = await sync.syncSiteRates({ site, snapshot: { groups } });

  assert.deepEqual(result, { updated: 1, removed: 0, failed: 0 });
  assert.deepEqual(calls.updates, [
    { accountId: '42', update: { name: '上游站 · 狂欢004', rateMultiplier: 0.06 } },
  ]);
  assert.deepEqual(calls.markSynced, [{ id: 'link-1', rate: 0.06 }]);
});

test('sync deletes link when remote account no longer exists', async () => {
  const links = [
    { id: 'link-1', mySiteId: 'my-site-1', myAccountId: '42', upstreamGroupId: 'g-1', lastSyncedRate: 0.05 },
  ];
  const notFound = new Error('account not found');
  notFound.httpStatus = 404;
  const { sync, calls } = createFakes({
    links,
    groups: [{ id: 'g-1', name: 'gpt', multiplier: 0.06 }],
    mySite,
    remoteErrors: { 42: notFound },
  });

  const result = await sync.syncSiteRates({ site, snapshot: { groups: [{ id: 'g-1', name: 'gpt', multiplier: 0.06 }] } });

  assert.deepEqual(result, { updated: 0, removed: 1, failed: 0 });
  assert.deepEqual(calls.deleted, ['link-1']);
  assert.deepEqual(calls.updates, []);
});

test('sync does nothing when remote already matches snapshot', async () => {
  const links = [
    { id: 'link-1', mySiteId: 'my-site-1', myAccountId: '42', upstreamGroupId: 'g-1', lastSyncedRate: 0.06 },
  ];
  const { sync, calls } = createFakes({
    links,
    groups: [{ id: 'g-1', name: 'gpt-plus', multiplier: 0.06 }],
    mySite,
    remoteAccounts: { 42: { id: '42', name: '上游站 · gpt-plus', rateMultiplier: 0.06 } },
  });

  const result = await sync.syncSiteRates({ site, snapshot: { groups: [{ id: 'g-1', name: 'gpt-plus', multiplier: 0.06 }] } });

  assert.deepEqual(result, { updated: 0, removed: 0, failed: 0 });
  assert.deepEqual(calls.updates, []);
  assert.deepEqual(calls.markSynced, []);
});

test('sync skips groups missing from snapshot and keeps going per-link failures', async () => {
  const links = [
    { id: 'link-1', mySiteId: 'my-site-1', myAccountId: '42', upstreamGroupId: 'g-gone', lastSyncedRate: 0.05 },
    { id: 'link-2', mySiteId: 'my-site-1', myAccountId: '43', upstreamGroupId: 'g-1', lastSyncedRate: 0.05 },
    { id: 'link-3', mySiteId: 'my-site-1', myAccountId: '44', upstreamGroupId: 'g-1', lastSyncedRate: 0.05 },
  ];
  const boom = new Error('remote 500');
  boom.httpStatus = 500;
  const { sync, calls } = createFakes({
    links,
    groups: [{ id: 'g-1', name: 'gpt', multiplier: 0.06 }],
    mySite,
    remoteAccounts: { 44: { id: '44', name: '上游站 · gpt', rateMultiplier: 0.06 } },
    remoteErrors: { 43: boom },
  });

  const result = await sync.syncSiteRates({ site, snapshot: { groups: [{ id: 'g-1', name: 'gpt', multiplier: 0.06 }] } });

  assert.deepEqual(result, { updated: 0, removed: 0, failed: 1 });
  assert.deepEqual(calls.deleted, []);
});

test('sync pushes display-converted multiplier instead of raw upstream value', async () => {
  const links = [
    { id: 'link-1', mySiteId: 'my-site-1', myAccountId: '42', upstreamGroupId: 'g-1', lastSyncedRate: 0.6 },
  ];
  const { sync, calls } = createFakes({
    links,
    groups: [{ id: 'g-1', name: 'Codex-大量', multiplier: 0.6 }],
    mySite,
    remoteAccounts: { 42: { id: '42', name: '示例上游 · Codex-大量', rateMultiplier: 0.6 } },
  });

  // 站点换算倍率 0.1：0.6 × 0.1 = 0.06（页面展示口径）
  const result = await sync.syncSiteRates({
    site: { id: 'site-1', name: '示例上游', usdToCnyRate: 0.1 },
    snapshot: { balanceCurrency: 'USD', groups: [{ id: 'g-1', name: 'Codex-大量', multiplier: 0.6 }] },
  });

  assert.deepEqual(result, { updated: 1, removed: 0, failed: 0 });
  assert.deepEqual(calls.updates, [{ accountId: '42', update: { rateMultiplier: 0.06 } }]);
  assert.deepEqual(calls.markSynced, [{ id: 'link-1', rate: 0.06 }]);
});

test('sync does nothing without links or repositories', async () => {
  const { sync } = createFakes({ links: [] });
  assert.deepEqual(await sync.syncSiteRates({ site, snapshot: { groups: [] } }), { updated: 0, removed: 0, failed: 0 });

  const bare = createMySiteRateSync({});
  assert.deepEqual(await bare.syncSiteRates({ site, snapshot: {} }), { updated: 0, removed: 0, failed: 0 });
});

test('sync deletes link when account was removed from the mapped group', async () => {
  const links = [
    { id: 'link-1', mySiteId: 'my-site-1', myGroupId: '15', myAccountId: '42', upstreamGroupId: 'g-1', lastSyncedRate: 0.06 },
    { id: 'link-2', mySiteId: 'my-site-1', myGroupId: '24', myAccountId: '43', upstreamGroupId: 'g-1', lastSyncedRate: 0.06 },
  ];
  const { sync, calls } = createFakes({
    links,
    groups: [{ id: 'g-1', name: 'gpt', multiplier: 0.06 }],
    mySite,
    remoteAccounts: {
      // 账号还在，但已被移出映射时的分组 15
      42: { id: '42', name: '上游站 · gpt', rateMultiplier: 0.06, groupIds: ['24'] },
      // 账号仍在映射分组 24 里
      43: { id: '43', name: '上游站 · gpt', rateMultiplier: 0.06, groupIds: ['24'] },
    },
  });

  const result = await sync.syncSiteRates({ site, snapshot: { groups: [{ id: 'g-1', name: 'gpt', multiplier: 0.06 }] } });

  assert.deepEqual(result, { updated: 0, removed: 1, failed: 0 });
  assert.deepEqual(calls.deleted, ['link-1']);
  assert.deepEqual(calls.updates, []);
});

test('sync keeps link when remote group membership is unknown', async () => {
  const links = [
    { id: 'link-1', mySiteId: 'my-site-1', myGroupId: '15', myAccountId: '42', upstreamGroupId: 'g-1', lastSyncedRate: 0.06 },
  ];
  const { sync, calls } = createFakes({
    links,
    groups: [{ id: 'g-1', name: 'gpt', multiplier: 0.06 }],
    mySite,
    // 老版本 sub2api 没有 account_groups 字段 → 跳过成员校验，不误删
    remoteAccounts: { 42: { id: '42', name: '上游站 · gpt', rateMultiplier: 0.06, groupIds: null } },
  });

  const result = await sync.syncSiteRates({ site, snapshot: { groups: [{ id: 'g-1', name: 'gpt', multiplier: 0.06 }] } });

  assert.deepEqual(result, { updated: 0, removed: 0, failed: 0 });
  assert.deepEqual(calls.deleted, []);
});
