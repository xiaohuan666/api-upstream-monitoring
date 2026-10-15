import test from 'node:test';
import assert from 'node:assert/strict';

import { createMySiteAccountService } from '../src/my-site-accounts.mjs';

function createFakes(overrides = {}) {
  const calls = { clientFactory: [], createAccount: [], repositoryCreate: [], fetchModels: [] };
  const mySite = { id: 'my-site-1', name: '主站', url: 'https://sub.example.com', adminKey: 'admin-key-1' };
  const upstreamSite = { id: 'site-1', name: '上游站', url: 'https://up.example.com', baseUrl: 'https://up.example.com' };
  const snapshot = {
    groups: [{ id: 'g-1', name: 'Codex-大量', platform: 'openai', multiplier: 0.06 }],
    tokens: [{ id: 't-1', key: 'sk-upstream', groupId: 'g-1' }],
  };
  const fakes = {
    calls,
    mySiteRepository: {
      async getMySiteById(id) {
        return id === 'my-site-1' ? mySite : null;
      },
    },
    mySiteAccountRepository: {
      async listAccounts() {
        return [];
      },
      async createAccount(input) {
        calls.repositoryCreate.push(input);
        return { id: 'link-1', ...input };
      },
    },
    siteRepository: {
      async getSiteById(id) {
        return id === 'site-1' ? upstreamSite : null;
      },
    },
    snapshotRepository: {
      async getLatestSnapshot() {
        return snapshot;
      },
    },
    fetchUpstreamModels: async (input) => {
      calls.fetchModels.push(input);
      return [{ id: 'gpt-5.6' }, { id: 'gpt-image-1' }, { id: 'gpt-5.6-luna' }];
    },
    adminClientFactory: (config) => {
      calls.clientFactory.push(config);
      return {
        async listGroups() {
          return [{ id: '7', name: 'gpt-plus', platform: 'openai', rateMultiplier: 0.09, status: 'active' }];
        },
        async createAccount(input) {
          calls.createAccount.push(input);
          return { id: '42', name: input.name };
        },
      };
    },
  };
  return { ...fakes, ...overrides };
}

test('service creates account link end to end', async () => {
  const fakes = createFakes();
  const service = createMySiteAccountService(fakes);

  const link = await service.createAccountLink({
    mySiteId: 'my-site-1',
    myGroupId: '7',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  });

  assert.equal(link.id, 'link-1');
  assert.deepEqual(fakes.calls.clientFactory, [{ baseUrl: 'https://sub.example.com', adminKey: 'admin-key-1' }]);
  // 同步上游模型用分组 key + 站点 base_url；默认排除 gpt-image-1 / gpt-5.6-luna 后剩 gpt-5.6
  assert.deepEqual(fakes.calls.fetchModels, [{
    baseUrl: 'https://up.example.com',
    apiKey: 'sk-upstream',
    proxy: null,
  }]);
  assert.deepEqual(fakes.calls.createAccount, [{
    name: '上游站 · Codex-大量',
    platform: 'openai',
    apiKey: 'sk-upstream',
    baseUrl: 'https://up.example.com',
    groupId: '7',
    rateMultiplier: 0.06,
    poolMode: true,
    poolModeRetryCount: 3,
    responsesMode: 'force_responses',
    modelMapping: { 'gpt-5.6': 'gpt-5.6' },
  }]);
  assert.deepEqual(fakes.calls.repositoryCreate, [{
    mySiteId: 'my-site-1',
    myGroupId: '7',
    myGroupName: 'gpt-plus',
    myAccountId: '42',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
    lastSyncedRate: 0.06,
  }]);
});

test('service only sends responses mode for openai target groups', async () => {
  const calls = { createAccount: [] };
  const fakes = createFakes({
    adminClientFactory: () => ({
      async listGroups() {
        return [{ id: '8', name: 'claude', platform: 'anthropic', rateMultiplier: 0.35, status: 'active' }];
      },
      async createAccount(input) {
        calls.createAccount.push(input);
        return { id: '50', name: input.name };
      },
    }),
  });
  const service = createMySiteAccountService(fakes);

  await service.createAccountLink({
    mySiteId: 'my-site-1',
    myGroupId: '8',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
    responsesMode: 'force_chat_completions',
  });

  assert.equal(calls.createAccount[0].responsesMode, null);
});

test('service creates grok-platform accounts for grok target groups', async () => {
  const calls = { createAccount: [] };
  const fakes = createFakes({
    adminClientFactory: () => ({
      async listGroups() {
        return [{ id: '28', name: 'X.grok', platform: 'grok', rateMultiplier: 0.15, status: 'active' }];
      },
      async createAccount(input) {
        calls.createAccount.push(input);
        return { id: '60', name: input.name };
      },
    }),
  });
  const service = createMySiteAccountService(fakes);

  await service.createAccountLink({
    mySiteId: 'my-site-1',
    myGroupId: '28',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  });

  // 上游分组平台是 openai 兼容口径，但 grok 目标分组必须建 grok 平台账号，且不带 Responses 模式
  assert.equal(calls.createAccount[0].platform, 'grok');
  assert.equal(calls.createAccount[0].responsesMode, null);
});

test('service creates gemini-platform accounts for gemini target groups', async () => {
  const calls = { createAccount: [] };
  const fakes = createFakes({
    adminClientFactory: () => ({
      async listGroups() {
        return [{ id: '31', name: 'gemini-pro', platform: 'gemini', rateMultiplier: 0.2, status: 'active' }];
      },
      async createAccount(input) {
        calls.createAccount.push(input);
        return { id: '61', name: input.name };
      },
    }),
  });
  const service = createMySiteAccountService(fakes);

  await service.createAccountLink({
    mySiteId: 'my-site-1',
    myGroupId: '31',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  });

  // 与 grok 同理：gemini 目标分组建 gemini 平台账号，不带 Responses 模式
  assert.equal(calls.createAccount[0].platform, 'gemini');
  assert.equal(calls.createAccount[0].responsesMode, null);
});

test('service syncs rate with display-converted multiplier instead of raw upstream value', async () => {
  const calls = { createAccount: [] };
  const fakes = createFakes({
    siteRepository: {
      async getSiteById() {
        return { id: 'site-1', name: '示例上游', url: 'https://upstream.example.test', baseUrl: 'https://upstream.example.test', usdToCnyRate: 0.1 };
      },
    },
    snapshotRepository: {
      async getLatestSnapshot() {
        return {
          balanceCurrency: 'USD',
          groups: [{ id: 'g-1', name: 'Codex-大量', platform: 'openai', multiplier: 0.6 }],
          tokens: [{ id: 't-1', key: 'sk-upstream', groupId: 'g-1' }],
        };
      },
    },
    adminClientFactory: () => ({
      async listGroups() {
        return [{ id: '7', name: 'gpt-plus', platform: 'openai', rateMultiplier: 0.09, status: 'active' }];
      },
      async createAccount(input) {
        calls.createAccount.push(input);
        return { id: '60', name: input.name };
      },
    }),
  });
  const service = createMySiteAccountService(fakes);

  const link = await service.createAccountLink({
    mySiteId: 'my-site-1',
    myGroupId: '7',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  });

  // 0.6 × 0.1 = 0.06（页面展示口径），不是上游原始声明的 0.6
  assert.equal(calls.createAccount[0].rateMultiplier, 0.06);
  assert.equal(link.lastSyncedRate, 0.06);
});

test('service rejects when upstream group already linked in the same my group', async () => {
  const fakes = createFakes({
    mySiteAccountRepository: {
      async listAccounts() {
        return [{ id: 'link-0', mySiteId: 'my-site-1', myGroupId: '7', upstreamSiteId: 'site-1', upstreamGroupId: 'g-1' }];
      },
      async createAccount() {
        throw new Error('should not reach repository insert');
      },
    },
  });
  const service = createMySiteAccountService(fakes);

  const error = await service.createAccountLink({
    mySiteId: 'my-site-1',
    myGroupId: '7',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  }).catch((err) => err);

  assert.equal(error.statusCode, 409);
  assert.match(error.message, /已创建过账号/);
});

test('service rejects when group has no usable api key', async () => {
  const fakes = createFakes({
    snapshotRepository: {
      async getLatestSnapshot() {
        return {
          groups: [{ id: 'g-1', name: 'Codex-大量', platform: 'openai', multiplier: 0.06 }],
          tokens: [],
        };
      },
    },
  });
  const service = createMySiteAccountService(fakes);

  const error = await service.createAccountLink({
    mySiteId: 'my-site-1',
    myGroupId: '7',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  }).catch((err) => err);

  assert.equal(error.statusCode, 400);
  assert.match(error.message, /没有可用的 API Key/);
});

test('service lists remote groups through admin client', async () => {
  const fakes = createFakes();
  const service = createMySiteAccountService(fakes);

  const groups = await service.listRemoteGroups('my-site-1');

  assert.deepEqual(groups, [
    { id: '7', name: 'gpt-plus', platform: 'openai', rateMultiplier: 0.09, status: 'active' },
  ]);
  assert.deepEqual(fakes.calls.clientFactory, [{ baseUrl: 'https://sub.example.com', adminKey: 'admin-key-1' }]);
});

test('service rejects unknown my site and unknown upstream site', async () => {
  const fakes = createFakes();
  const service = createMySiteAccountService(fakes);

  const unknownMySite = await service.createAccountLink({
    mySiteId: 'nope',
    myGroupId: '7',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  }).catch((err) => err);
  assert.equal(unknownMySite.statusCode, 404);

  const unknownSite = await service.createAccountLink({
    mySiteId: 'my-site-1',
    myGroupId: '7',
    upstreamSiteId: 'nope',
    upstreamGroupId: 'g-1',
  }).catch((err) => err);
  assert.equal(unknownSite.statusCode, 404);
});

test('service passes custom excluded models and maps remaining upstream models', async () => {
  const fakes = createFakes({
    fetchUpstreamModels: async () => [
      { id: 'gpt-5.6' },
      { id: 'gpt-5.6-mini' },
      { id: 'claude-opus-4' },
    ],
  });
  const service = createMySiteAccountService(fakes);

  await service.createAccountLink({
    mySiteId: 'my-site-1',
    myGroupId: '7',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
    excludedModels: ['claude-opus-4'],
  });

  assert.deepEqual(fakes.calls.createAccount[0].modelMapping, {
    'gpt-5.6': 'gpt-5.6',
    'gpt-5.6-mini': 'gpt-5.6-mini',
  });
});

test('service accepts string models and empty exclusions whitelist everything', async () => {
  const fakes = createFakes({
    fetchUpstreamModels: async () => ['gpt-5.6', 'gpt-image-1'],
  });
  const service = createMySiteAccountService(fakes);

  await service.createAccountLink({
    mySiteId: 'my-site-1',
    myGroupId: '7',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
    excludedModels: [],
  });

  assert.deepEqual(fakes.calls.createAccount[0].modelMapping, {
    'gpt-5.6': 'gpt-5.6',
    'gpt-image-1': 'gpt-image-1',
  });
});

test('service rejects when upstream model fetch fails instead of creating unrestricted account', async () => {
  const fakes = createFakes({
    fetchUpstreamModels: async () => {
      throw new Error('All candidates failed: HTTP 404');
    },
  });
  const service = createMySiteAccountService(fakes);

  const error = await service.createAccountLink({
    mySiteId: 'my-site-1',
    myGroupId: '7',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  }).catch((err) => err);

  assert.equal(error.statusCode, 502);
  assert.match(error.message, /拉取上游模型列表失败/);
  assert.equal(fakes.calls.createAccount.length, 0);
  assert.equal(fakes.calls.repositoryCreate.length, 0);
});

test('service rejects when exclusions remove every upstream model', async () => {
  const fakes = createFakes({
    fetchUpstreamModels: async () => [{ id: 'gpt-image-1' }],
  });
  const service = createMySiteAccountService(fakes);

  const error = await service.createAccountLink({
    mySiteId: 'my-site-1',
    myGroupId: '7',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  }).catch((err) => err);

  assert.equal(error.statusCode, 400);
  assert.match(error.message, /排除后上游没有可支持的模型/);
  assert.equal(fakes.calls.createAccount.length, 0);
});

function createRemoteFakes(overrides = {}) {
  const calls = { setSchedulable: [], updateAccount: [] };
  const link = {
    id: 'link-1',
    mySiteId: 'my-site-1',
    myGroupId: '7',
    myGroupName: 'gpt-plus',
    myAccountId: '42',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  };
  const mySite = { id: 'my-site-1', name: '主站', url: 'https://sub.example.com', adminKey: 'admin-key-1' };
  const fakes = {
    calls,
    link,
    mySiteRepository: {
      async getMySiteById(id) {
        return id === 'my-site-1' ? mySite : null;
      },
    },
    mySiteAccountRepository: {
      async listAccounts() {
        return [link];
      },
      async getAccountById(id) {
        return id === 'link-1' ? link : null;
      },
    },
    siteRepository: {},
    snapshotRepository: {},
    adminClientFactory: () => ({
      async getAccount(accountId) {
        return { id: accountId, name: '上游站 · Codex-大量', rateMultiplier: 0.06, schedulable: true, priority: 1, groupIds: ['7'] };
      },
      async setSchedulable(accountId, schedulable) {
        calls.setSchedulable.push([accountId, schedulable]);
      },
      async updateAccount(accountId, patch) {
        calls.updateAccount.push([accountId, patch]);
      },
    }),
  };
  return { ...fakes, ...overrides };
}

test('service lists linked accounts with remote state', async () => {
  const fakes = createRemoteFakes();
  const service = createMySiteAccountService(fakes);

  const accounts = await service.listLinkedAccountsRemote({ upstreamSiteId: 'site-1', upstreamGroupId: 'g-1' });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, 'link-1');
  assert.equal(accounts[0].mySiteName, '主站');
  assert.equal(accounts[0].remote.schedulable, true);
  assert.equal(accounts[0].remote.priority, 1);
  assert.equal(accounts[0].remoteError, null);
});

test('service keeps row with error when remote fetch fails', async () => {
  const fakes = createRemoteFakes({
    adminClientFactory: () => ({
      async getAccount() {
        throw new Error('HTTP 404: account not found');
      },
    }),
  });
  const service = createMySiteAccountService(fakes);

  const accounts = await service.listLinkedAccountsRemote({ upstreamSiteId: 'site-1', upstreamGroupId: 'g-1' });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].remote, null);
  assert.match(accounts[0].remoteError, /404/);
});

test('service updates schedulable and priority on remote account', async () => {
  const fakes = createRemoteFakes();
  const service = createMySiteAccountService(fakes);

  const result = await service.updateLinkedAccountRemote({
    accountLinkId: 'link-1',
    schedulable: false,
    priority: 9,
  });

  assert.deepEqual(fakes.calls.setSchedulable, [['42', false]]);
  assert.deepEqual(fakes.calls.updateAccount, [['42', { priority: 9 }]]);
  assert.equal(result.link.id, 'link-1');
  assert.equal(result.remote.id, '42');
});

test('service validates priority before touching remote account', async () => {
  const fakes = createRemoteFakes();
  const service = createMySiteAccountService(fakes);

  const error = await service.updateLinkedAccountRemote({
    accountLinkId: 'link-1',
    schedulable: true,
    priority: -1,
  }).catch((err) => err);

  assert.equal(error.statusCode, 400);
  assert.equal(fakes.calls.setSchedulable.length, 0);
  assert.equal(fakes.calls.updateAccount.length, 0);
});

test('service rejects update without any field or unknown link', async () => {
  const fakes = createRemoteFakes();
  const service = createMySiteAccountService(fakes);

  const empty = await service.updateLinkedAccountRemote({ accountLinkId: 'link-1' }).catch((err) => err);
  assert.equal(empty.statusCode, 400);

  const missing = await service.updateLinkedAccountRemote({ accountLinkId: 'link-x', priority: 1 }).catch((err) => err);
  assert.equal(missing.statusCode, 404);
});
