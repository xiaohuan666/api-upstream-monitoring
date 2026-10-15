import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SITE_TYPES,
  createGroupModelSettingsRepository,
  createProxyRepository,
  createSnapshotRepository,
  createSiteRepository,
  createUiPreferencesRepository,
  initializeDatabase,
  normalizeSiteRecord,
  normalizeProxyRecord,
  validateSiteInput,
  validateProxyInput,
} from '../src/db.mjs';

test('auto-refresh JSON preferences preserve ID rules across save and reload', async () => {
  const preferences = { enabled: true, intervalValue: 5, intervalUnit: 'minutes', rules: [
    { siteIds: ['site-1', 'site-2'], intervalValue: 10, intervalUnit: 'minutes' },
  ] };
  const row = { preference_key: 'auto-refresh', preferences, updated_at: '2026-09-21T00:00:00Z' };
  const pool = createRecordingPool([{ rows: [] }, { rows: [row] }, { rows: [row] }]);
  const repository = createUiPreferencesRepository(pool);
  assert.deepEqual((await repository.getAutoRefreshSettings()).preferences.rules, []);
  assert.deepEqual((await repository.upsertAutoRefreshSettings(preferences)).preferences, preferences);
  assert.deepEqual(pool.queries[1].values, ['auto-refresh', JSON.stringify(preferences)]);
  assert.deepEqual((await repository.getAutoRefreshSettings()).preferences, preferences);
});

test('SITE_TYPES supports sub2api, new-api, and other', () => {
  assert.deepEqual(SITE_TYPES, ['sub2api', 'new-api', 'other']);
});

test('validateSiteInput normalizes URL and plaintext credentials', () => {
  const site = validateSiteInput({
    name: ' 示例站点 ',
    url: 'relay.example.com///',
    base_url: 'api.relay.example.com/',
    type: 'new-api',
    username: ' admin ',
    password: ' plain-secret ',
    new_api_user_id: ' 175 ',
    auth_token: ' bearer-token ',
    refresh_token: ' rt-refresh ',
    usd_to_cny_rate: '7',
    balance_alert: '5',
    depletion_alert_hours: '1.5',
    proxy_id: 'proxy-1',
  });

  assert.equal(site.name, '示例站点');
  assert.equal(site.url, 'https://relay.example.com');
  assert.equal(site.baseUrl, 'https://api.relay.example.com');
  assert.equal(site.type, 'new-api');
  assert.equal(site.username, 'admin');
  assert.equal(site.password, ' plain-secret ');
  assert.equal(site.newApiUserId, '175');
  assert.equal(site.syncVariant, 'standard');
  assert.equal(site.authToken, 'bearer-token');
  assert.equal(site.refreshToken, 'rt-refresh');
  assert.equal(site.usdToCnyRate, 7);
  assert.equal(site.balanceAlert, 5);
  assert.equal(site.depletionAlertHours, 1.5);
  assert.equal(site.proxyId, 'proxy-1');
});

test('validateSiteInput defaults base URL to the site URL and keeps only the root URL', () => {
  const site = validateSiteInput({ name: 'x', url: 'https://relay.example.test/keys', type: 'other' });
  assert.equal(site.url, 'https://relay.example.test');
  assert.equal(site.baseUrl, 'https://relay.example.test');

  const withBase = validateSiteInput({
    name: 'x',
    url: 'https://example.com',
    base_url: 'https://api.example.com/console/',
    type: 'other',
  });
  assert.equal(withBase.baseUrl, 'https://api.example.com');
});

test('validateSiteInput defaults balance alert to 0 and rejects negatives', () => {
  const site = validateSiteInput({ name: 'x', url: 'https://example.com', base_url: 'https://api.example.com', type: 'other' });
  assert.equal(site.balanceAlert, 0);

  for (const balance_alert of [-1, 'not-a-number', -Infinity]) {
    assert.throws(
      () => validateSiteInput({ name: 'x', url: 'https://example.com', base_url: 'https://api.example.com', type: 'other', balance_alert }),
      /Balance alert must be a non-negative number/,
    );
  }
});

test('validateSiteInput defaults depletion alert to one hour and accepts zero to disable it', () => {
  const base = { name: 'x', url: 'https://example.com', type: 'other' };
  assert.equal(validateSiteInput(base).depletionAlertHours, 1);
  assert.equal(validateSiteInput({ ...base, depletion_alert_hours: '0' }).depletionAlertHours, 0);
  for (const depletion_alert_hours of [-1, 'invalid', Infinity]) {
    assert.throws(() => validateSiteInput({ ...base, depletion_alert_hours }), /Depletion alert hours must be a non-negative number/);
  }
});

test('validateSiteInput requires a positive finite USD to CNY rate', () => {
  for (const usd_to_cny_rate of [0, -1, 'not-a-number', Infinity]) {
    assert.throws(
      () => validateSiteInput({
        name: 'bad-rate',
        url: 'https://example.com',
        base_url: 'https://api.example.com',
        type: 'other',
        usd_to_cny_rate,
      }),
      /USD to CNY rate must be greater than 0/,
    );
  }
});

test('validateSiteInput rejects unsupported site types', () => {
  assert.throws(
    () => validateSiteInput({ name: 'bad', url: 'https://example.com', base_url: 'https://api.example.com', type: 'unknown' }),
    /Unsupported site type/,
  );
});

test('validateSiteInput requires auth token for sub2api sites', () => {
  assert.throws(
    () => validateSiteInput({ name: 'sub2api', url: 'https://sub.example.com', base_url: 'https://api.sub.example.com', type: 'sub2api' }),
    /Bearer Token is required for sub2api/,
  );
});

test('validateSiteInput requires user id and cookie for new-api sites', () => {
  assert.throws(
    () => validateSiteInput({ name: 'new-api', url: 'https://new.example.com', base_url: 'https://api.new.example.com', type: 'new-api', auth_token: 'cookie' }),
    /User id is required for new-api/,
  );
  assert.throws(
    () => validateSiteInput({ name: 'new-api', url: 'https://new.example.com', base_url: 'https://api.new.example.com', type: 'new-api', new_api_user_id: '164' }),
    /Cookie is required for new-api/,
  );
});

test('normalizeSiteRecord maps database snake_case columns to frontend shape', () => {
  const site = normalizeSiteRecord({
    id: 'a7cdd6b4-35b7-4c6f-8756-d72830f478b0',
    name: '示例站点',
    url: 'https://relay.example.com',
    base_url: 'https://api.relay.example.com',
    type: 'new-api',
    username: 'admin',
    password: 'plain-secret',
    new_api_user_id: '175',
    sync_variant: 'credential-flow',
    auth_token: 'bearer-token',
    refresh_token: 'rt-refresh',
    auth_token_rotated_at: '2026-07-04T01:30:00.000Z',
    refresh_token_rotated_at: '2026-07-04T01:40:00.000Z',
    usd_to_cny_rate: '7',
    balance_alert: '5',
    depletion_alert_hours: '2.5',
    watched: true,
    proxy_id: 'proxy-1',
    proxy_name: 'sub2 bridge',
    proxy_protocol: 'http',
    proxy_host: 'host.docker.internal',
    proxy_port: 17896,
    proxy_username: '',
    proxy_password: '',
    proxy_status: 'active',
    created_at: new Date('2026-07-04T01:00:00.000Z'),
    updated_at: '2026-07-04T02:00:00.000Z',
  });

  assert.deepEqual(site, {
    id: 'a7cdd6b4-35b7-4c6f-8756-d72830f478b0',
    name: '示例站点',
    url: 'https://relay.example.com',
    baseUrl: 'https://api.relay.example.com',
    type: 'new-api',
    username: 'admin',
    password: 'plain-secret',
    newApiUserId: '175',
    syncVariant: 'credential-flow',
    authToken: 'bearer-token',
    refreshToken: 'rt-refresh',
    authTokenRotatedAt: '2026-07-04T01:30:00.000Z',
    refreshTokenRotatedAt: '2026-07-04T01:40:00.000Z',
    usdToCnyRate: 7,
    balanceAlert: 5,
    depletionAlertHours: 2.5,
    watched: true,
    proxyId: 'proxy-1',
    proxy: {
      id: 'proxy-1',
      name: 'sub2 bridge',
      provider: '',
      probeResult: null,
      protocol: 'http',
      host: 'host.docker.internal',
      port: 17896,
      username: '',
      password: '',
      status: 'active',
      siteCount: 0,
      expiresAt: null,
      createdAt: '2026-07-04T01:00:00.000Z',
      updatedAt: '2026-07-04T02:00:00.000Z',
      url: 'http://host.docker.internal:17896',
    },
    createdAt: '2026-07-04T01:00:00.000Z',
    updatedAt: '2026-07-04T02:00:00.000Z',
  });
});

test('validateProxyInput normalizes proxy fields and builds URL safely', () => {
  const proxy = validateProxyInput({
    name: ' sub2 bridge ',
    protocol: 'HTTP',
    host: ' host.docker.internal ',
    port: '17896',
    username: ' user name ',
    password: ' p@ss word ',
    status: 'active',
  });

  assert.equal(proxy.name, 'sub2 bridge');
  assert.equal(proxy.protocol, 'http');
  assert.equal(proxy.host, 'host.docker.internal');
  assert.equal(proxy.port, 17896);
  assert.equal(proxy.username, 'user name');
  assert.equal(proxy.password, ' p@ss word ');
  assert.equal(proxy.status, 'active');
});

test('validateProxyInput rejects unsupported protocol and invalid port', () => {
  assert.throws(
    () => validateProxyInput({ name: 'bad', protocol: 'ftp', host: 'proxy.local', port: 8080 }),
    /Unsupported proxy protocol/,
  );
  assert.throws(
    () => validateProxyInput({ name: 'bad', protocol: 'http', host: 'proxy.local', port: 70000 }),
    /Proxy port must be between 1 and 65535/,
  );
});

test('normalizeProxyRecord maps proxy rows and includes display URL', () => {
  const proxy = normalizeProxyRecord({
    id: 'proxy-1',
    name: 'sub2 bridge',
    protocol: 'http',
    host: 'host.docker.internal',
    port: 17896,
    username: '',
    password: '',
    status: 'active',
    site_count: '3',
    created_at: '2026-07-04T01:00:00.000Z',
    updated_at: '2026-07-04T02:00:00.000Z',
  });

  assert.equal(proxy.url, 'http://host.docker.internal:17896');
  assert.equal(proxy.siteCount, 3);
});

test('initializeDatabase creates extension, table, and updated_at trigger', async () => {
  const pool = createRecordingPool();

  await initializeDatabase(pool);

  const sql = pool.queries.map((query) => query.text).join('\n');
  assert.match(sql, /create extension if not exists pgcrypto/i);
  assert.match(sql, /create table if not exists proxies/i);
  assert.match(sql, /alter table proxies add column if not exists provider text not null default ''/i);
  assert.match(sql, /create table if not exists upstream_sites/i);
  assert.match(sql, /proxy_id uuid references proxies\(id\) on delete set null/i);
  assert.match(sql, /create table if not exists sub2api_snapshots/i);
  assert.match(sql, /create table if not exists new_api_snapshots/i);
  assert.match(sql, /lock table sub2api_snapshots in share row exclusive mode/i);
  assert.match(sql, /lock table new_api_snapshots in share row exclusive mode/i);
  assert.match(sql, /delete from sub2api_snapshots/i);
  assert.match(sql, /delete from new_api_snapshots/i);
  assert.match(sql, /row_number\(\) over \(partition by site_id order by fetched_at desc, id desc\)/i);
  assert.match(sql, /create unique index if not exists sub2api_snapshots_site_id_unique_idx/i);
  assert.match(sql, /create unique index if not exists new_api_snapshots_site_id_unique_idx/i);
  assert.match(sql, /create table if not exists group_model_settings/i);
  assert.match(sql, /create table if not exists ui_preferences/i);
  assert.match(sql, /create table if not exists group_filter_presets/i);
  assert.match(sql, /create table if not exists group_rate_changes/i);
  assert.doesNotMatch(sql, /\b(?:pricing_\w+|benchmark_\w+)\b/i);
  assert.match(sql, /preference_key text primary key/i);
  assert.match(sql, /test_model text not null default ''/i);
  assert.match(sql, /unique \(site_id, group_id\)/i);
  assert.match(sql, /raw_payload jsonb not null/i);
  assert.match(sql, /normalized_snapshot jsonb not null/i);
  assert.match(sql, /password text not null default ''/i);
  assert.match(sql, /auth_token text not null default ''/i);
  assert.match(sql, /refresh_token text not null default ''/i);
  assert.match(sql, /auth_token_rotated_at timestamptz not null default now\(\)/i);
  assert.match(sql, /refresh_token_rotated_at timestamptz not null default now\(\)/i);
  assert.match(sql, /usd_to_cny_rate numeric not null default 1[\s\S]*check \(usd_to_cny_rate > 0\)/i);
  assert.match(sql, /create trigger upstream_sites_set_updated_at/i);
  assert.match(sql, /create trigger proxies_set_updated_at/i);

  assert.equal(pool.clients.length, 2);
  for (const [index, tableName] of ['sub2api_snapshots', 'new_api_snapshots'].entries()) {
    const client = pool.clients[index];
    assert.deepEqual(
      client.queries.map(({ text }) => classifySnapshotMigrationQuery(text, tableName)),
      ['begin', 'lock', 'dedupe', 'unique-index', 'commit'],
    );
    assert.equal(client.released, true);
    const migrationSql = client.queries.map(({ text }) => text).join('\n');
    assert.match(migrationSql, /order by fetched_at desc, id desc/i);
    assert.match(migrationSql, new RegExp(`create unique index if not exists ${tableName}_site_id_unique_idx`, 'i'));
    assert.equal(client.queries.every((query) => query.source === `client-${index + 1}`), true);
  }
});

test('snapshot migration rolls back and releases its connected client after unique-index failure', async () => {
  const pool = createRecordingPool([], {
    failClientQuery({ text, clientIndex }) {
      if (clientIndex === 1 && /create unique index/i.test(text)) {
        return new Error('unique index failed');
      }
      return null;
    },
  });

  await assert.rejects(initializeDatabase(pool), /unique index failed/);

  assert.equal(pool.clients.length, 1);
  const client = pool.clients[0];
  assert.deepEqual(
    client.queries.map(({ text }) => classifySnapshotMigrationQuery(text, 'sub2api_snapshots')),
    ['begin', 'lock', 'dedupe', 'unique-index', 'rollback'],
  );
  assert.equal(client.queries.some(({ text }) => /^\s*commit\s*$/i.test(text)), false);
  assert.equal(client.released, true);
});

test('proxy repository creates, updates, lists, and deletes proxies', async () => {
  const row = {
    id: 'proxy-1',
    name: 'sub2 bridge',
    protocol: 'http',
    host: 'host.docker.internal',
    port: 17896,
    username: '',
    password: '',
    status: 'active',
    site_count: '0',
    created_at: '2026-07-04T01:00:00.000Z',
    updated_at: '2026-07-04T02:00:00.000Z',
  };
  const pool = createRecordingPool([
    { rows: [row] },
    { rows: [row] },
    { rows: [row] },
    { rowCount: 1, rows: [] },
  ]);
  const repository = createProxyRepository(pool);

  await repository.createProxy({
    name: 'sub2 bridge',
    provider: ' 星河 ',
    protocol: 'http',
    host: 'host.docker.internal',
    port: 17896,
    expiresAt: '2026-10-02T00:00:00.000Z',
  });
  await repository.listProxies();
  await repository.updateProxy('proxy-1', { ...row, port: 17896, expiresAt: '' });
  const deleted = await repository.deleteProxy('proxy-1');

  assert.match(pool.queries[0].text, /insert into proxies/i);
  // 到期时间随创建落库；编辑时传空串表示清除（长期有效）
  assert.equal(pool.queries[0].values[1], '星河');
  assert.equal(pool.queries[0].values[8], '2026-10-02T00:00:00.000Z');
  assert.match(pool.queries[1].text, /left join upstream_sites/i);
  assert.match(pool.queries[2].text, /update proxies/i);
  assert.match(pool.queries[2].text, /expires_at/);
  assert.equal(pool.queries[2].values[9], null);
  assert.equal(pool.queries[2].values[1], null);
  assert.match(pool.queries[2].text, /provider = coalesce\(\$2, provider\)/);
  assert.match(pool.queries[3].text, /delete from proxies/i);
  assert.equal(deleted, true);
});

test('validateProxyInput rejects invalid expires_at', async () => {
  assert.throws(() => validateProxyInput({
    name: 'x', protocol: 'http', host: 'h', port: 80, expiresAt: 'not-a-date',
  }), /expires_at/);
});

test('proxy repository batch import dedupes by host/port/auth and auto-names entries', async () => {
  const pool = createProxyBatchPool([{ host: '1.2.3.4', port: 1080, username: 'u', password: 'p' }]);
  const repository = createProxyRepository(pool);

  const result = await repository.createProxiesBatch([
    { protocol: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' },
    { protocol: 'socks5', host: '2.3.4.5', port: 8080, username: '', password: '' },
  ]);

  assert.match(pool.queries[0].text, /^begin$/i);
  assert.match(pool.queries[1].text, /lock table proxies in share row exclusive mode/i);
  assert.match(pool.queries[2].text, /select name, provider, host, port, username, password from proxies/i);
  assert.match(pool.queries[3].text, /insert into proxies/i);
  assert.equal(pool.queries[3].values[0], 'default');
  assert.match(pool.queries.at(-1).text, /^commit$/i);
  assert.equal(pool.released, true);
  assert.equal(result.skipped, 1);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].name, 'default');
  assert.equal(result.created[0].provider, '');
});

test('batch import allocates provider gaps only for unique new proxies', async () => {
  const existing = [1, 2, 4].map((n) => ({ name: `星河-00${n}`, provider: '星河', host: `old-${n}`, port: 80 }));
  const pool = createProxyBatchPool(existing);
  const repository = createProxyRepository(pool);
  const inputs = ['old-1', 'new-1', 'new-1', 'new-2'].map((host) => ({ provider: '星河', host, port: 80 }));
  const result = await repository.createProxiesBatch(inputs);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.created.map((proxy) => proxy.name), ['星河-003', '星河-005']);
  assert.ok(result.created.every((proxy) => proxy.provider === '星河'));
  const again = await repository.createProxiesBatch([{ provider: '星河', host: 'new-3', port: 80 }]);
  assert.equal(again.created[0].name, '星河-006');
});

test('batch import distinguishes colon-containing credentials before allocating provider numbers', async () => {
  const endpoint = { provider: '服务商', host: 'proxy.test', port: 80 };
  const pool = createProxyBatchPool([
    { ...endpoint, name: '服务商-001', username: 'alice:x', password: 'y' },
  ]);
  const result = await createProxyRepository(pool).createProxiesBatch([
    { ...endpoint, username: 'alice', password: 'x:y' },
    { ...endpoint, username: 'bob:x', password: 'y' },
    { ...endpoint, username: 'bob', password: 'x:y' },
    { ...endpoint, username: 'bob', password: 'x:y' },
    { ...endpoint, username: 'alice:x', password: 'y' },
  ]);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.created.map(({ name, username, password }) => ({ name, username, password })), [
    { name: '服务商-002', username: 'alice', password: 'x:y' },
    { name: '服务商-003', username: 'bob:x', password: 'y' },
    { name: '服务商-004', username: 'bob', password: 'x:y' },
  ]);
});

test('batch import rolls back all inserted entries and releases client on failure', async () => {
  const pool = createProxyBatchPool([], { failInsert: 2 });
  const repository = createProxyRepository(pool);
  await assert.rejects(repository.createProxiesBatch([
    { provider: 'A', host: 'a', port: 80 }, { provider: 'A', host: 'b', port: 80 },
  ]), /insert failed/);
  assert.match(pool.queries.at(-1).text, /^rollback$/);
  assert.equal(pool.released, true);
  assert.equal(pool.rows.length, 0);
});

test('batch import validates every row before opening a transaction', async () => {
  const pool = createProxyBatchPool([]);
  await assert.rejects(createProxyRepository(pool).createProxiesBatch([
    { provider: 'A', host: 'a', port: 80 }, { provider: 'A', host: 'b', port: 70000 },
  ]), /port/);
  assert.equal(pool.queries.length, 0);
});

function createProxyBatchPool(existingRows, { failInsert = 0 } = {}) {
  const pool = { rows: structuredClone(existingRows), queries: [], released: false };
  pool.connect = async () => {
    let rows;
    let inserts = 0;
    return {
      async query(text, values = []) {
        pool.queries.push({ text, values });
        if (text === 'begin') rows = structuredClone(pool.rows);
        if (/^select name/.test(text)) return { rows: structuredClone(rows) };
        if (/insert into proxies/.test(text)) {
          if (++inserts === failInsert) throw new Error('insert failed');
          const [name, provider, protocol, host, port, username, password, status, expires_at] = values;
          const row = { id: `proxy-${rows.length + 1}`, name, provider, protocol, host, port, username, password, status, expires_at };
          rows.push(row);
          return { rows: [row] };
        }
        if (text === 'commit') pool.rows = rows;
        return { rows: [] };
      },
      release() { pool.released = true; },
    };
  };
  return pool;
}

test('group model settings repository upserts selected model and model options', async () => {
  const row = {
    site_id: 'site-1',
    group_id: 'group-a',
    selected_model: 'gpt-4o-mini',
    test_model: 'gpt-4o',
    model_options: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
    last_test_latency_ms: null,
    last_test_status: null,
    last_test_message: '',
    last_test_model: '',
    last_test_at: null,
    updated_at: '2026-07-04T07:00:00.000Z',
  };
  const pool = createRecordingPool([{ rows: [row] }]);
  const repository = createGroupModelSettingsRepository(pool);

  const setting = await repository.upsertSetting({
    siteId: 'site-1',
    groupId: 'group-a',
    selectedModel: 'gpt-4o-mini',
    testModel: 'gpt-4o',
    modelOptions: [{ id: 'gpt-4o-mini' }],
  });

  assert.match(pool.queries[0].text, /insert into group_model_settings/i);
  assert.match(pool.queries[0].text, /on conflict \(site_id, group_id\)/i);
  assert.match(pool.queries[0].text, /\$5::jsonb/i);
  assert.deepEqual(pool.queries[0].values, [
    'site-1',
    'group-a',
    'gpt-4o-mini',
    'gpt-4o',
    JSON.stringify([{ id: 'gpt-4o', ownedBy: 'manual' }, { id: 'gpt-4o-mini', ownedBy: '' }]),
  ]);
  assert.deepEqual(setting, {
    siteId: 'site-1',
    groupId: 'group-a',
    selectedModel: 'gpt-4o-mini',
    testModel: 'gpt-4o',
    modelOptions: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
    score: 0,
    lastTest: null,
    updatedAt: '2026-07-04T07:00:00.000Z',
  });
});

test('group model settings repository stores hvoy score with 0-100 validation', async () => {
  const row = {
    site_id: 'site-1',
    group_id: 'group-a',
    selected_model: 'gpt-4o-mini',
    model_options: [],
    score: '85',
    last_test_latency_ms: null,
    last_test_status: null,
    last_test_message: '',
    last_test_model: '',
    last_test_at: null,
    updated_at: '2026-07-04T07:02:00.000Z',
  };
  const pool = createRecordingPool([{ rows: [row] }]);
  const repository = createGroupModelSettingsRepository(pool);

  const setting = await repository.updateScore('site-1', 'group-a', '85');

  assert.match(pool.queries[0].text, /insert into group_model_settings \(site_id, group_id, score\)/i);
  assert.match(pool.queries[0].text, /on conflict \(site_id, group_id\)/i);
  assert.deepEqual(pool.queries[0].values, ['site-1', 'group-a', 85]);
  assert.equal(setting.score, 85);

  await assert.rejects(() => repository.updateScore('site-1', 'group-a', 101), /between 0 and 100/);
  await assert.rejects(() => repository.updateScore('site-1', 'group-a', -1), /between 0 and 100/);
  await assert.rejects(() => repository.updateScore('site-1', 'group-a', 'abc'), /between 0 and 100/);
});

test('group model settings repository stores latest model test result', async () => {
  const row = {
    site_id: 'site-1',
    group_id: 'group-a',
    selected_model: 'gpt-4o-mini',
    model_options: [],
    last_test_latency_ms: 368,
    last_test_status: 'healthy',
    last_test_message: '模型响应正常',
    last_test_model: 'gpt-4o-mini',
    last_test_at: '2026-07-04T07:01:00.000Z',
    updated_at: '2026-07-04T07:01:00.000Z',
  };
  const pool = createRecordingPool([{ rows: [row] }]);
  const repository = createGroupModelSettingsRepository(pool);

  const setting = await repository.updateLastTest('site-1', 'group-a', {
    responseTimeMs: 368,
    status: 'healthy',
    message: '模型响应正常',
    modelUsed: 'gpt-4o-mini',
    testedAt: '2026-07-04T07:01:00.000Z',
  });

  assert.match(pool.queries[0].text, /insert into group_model_settings/i);
  assert.match(pool.queries[0].text, /last_test_latency_ms/i);
  assert.deepEqual(pool.queries[0].values, [
    'site-1',
    'group-a',
    368,
    'healthy',
    '模型响应正常',
    'gpt-4o-mini',
    '2026-07-04T07:01:00.000Z',
  ]);
  assert.deepEqual(setting.lastTest, {
    responseTimeMs: 368,
    status: 'healthy',
    message: '模型响应正常',
    modelUsed: 'gpt-4o-mini',
    testedAt: '2026-07-04T07:01:00.000Z',
  });
});

test('ui preferences repository exposes no automatic pricing settings', () => {
  const repository = createUiPreferencesRepository(createRecordingPool());
  assert.equal('getPricingAutoRunSettings' in repository, false);
  assert.equal('upsertPricingAutoRunSettings' in repository, false);
  assert.equal(typeof repository.getAutoRefreshSettings, 'function');
  assert.equal(typeof repository.upsertAutoRefreshSettings, 'function');
});

test('ui preferences repository reads defaults and upserts normalized group preferences', async () => {
  const row = {
    preference_key: 'group-management',
    preferences: {
      groupSortKey: 'multiplier',
      groupSortDirection: 'desc',
      groupMultiplierMin: 0,
      groupMultiplierMax: 100,
      groupModelFilter: 'gpt-5.5',
      groupPlatformFilter: 'openai',
      groupSiteFilter: 'site-1',
      groupKeyFilter: 'all',
      groupMyGroupFilter: [],
      groupSchedulableFilter: 'all',
      filterPresets: [],
    },
    updated_at: '2026-07-04T08:00:00.000Z',
  };
  const pool = createRecordingPool([
    { rows: [] },
    { rows: [row] },
    { rows: [row] },
  ]);
  const repository = createUiPreferencesRepository(pool);

  const missing = await repository.getPreference('group-management');
  const saved = await repository.upsertPreference('group-management', {
    groupSortKey: 'multiplier',
    groupSortDirection: 'desc',
    groupModelFilter: 'gpt-5.5',
    groupSiteFilter: 'site-1',
    groupPlatformFilter: 'openai',
    groupKeyFilter: 'all',
  });
  const loaded = await repository.getPreference('group-management');

  assert.match(pool.queries[0].text, /from ui_preferences/i);
  assert.match(pool.queries[1].text, /insert into ui_preferences/i);
  assert.match(pool.queries[1].text, /on conflict \(preference_key\)/i);
  assert.deepEqual(pool.queries[1].values, [
    'group-management',
    JSON.stringify(row.preferences),
  ]);
  assert.equal(missing.preferenceKey, 'group-management');
  assert.equal(missing.updatedAt, null);
  assert.deepEqual(saved.preferences, row.preferences);
  assert.deepEqual(loaded.preferences, row.preferences);
});

test('repository lists sites ordered by creation time descending', async () => {
  const pool = createRecordingPool([
    {
      rows: [
        {
          id: 'site-1',
          name: '示例站点',
          url: 'https://relay.example.com',
          type: 'sub2api',
          username: 'admin',
          password: 'plain',
          auth_token: 'token',
          refresh_token: 'rt-refresh',
          auth_token_rotated_at: '2026-07-04T01:30:00.000Z',
          refresh_token_rotated_at: '2026-07-04T01:40:00.000Z',
          created_at: '2026-07-04T01:00:00.000Z',
          updated_at: '2026-07-04T01:00:00.000Z',
        },
      ],
    },
  ]);
  const repository = createSiteRepository(pool);

  const sites = await repository.listSites();

  assert.equal(pool.queries[0].text.includes('order by s.created_at desc'), true);
  assert.match(pool.queries[0].text, /left join proxies/i);
  assert.equal(sites[0].name, '示例站点');
  assert.equal(sites[0].password, 'plain');
  assert.equal(sites[0].authToken, 'token');
  assert.equal(sites[0].refreshToken, 'rt-refresh');
  assert.equal(sites[0].authTokenRotatedAt, '2026-07-04T01:30:00.000Z');
  assert.equal(sites[0].refreshTokenRotatedAt, '2026-07-04T01:40:00.000Z');
});

test('repository gets one site by id', async () => {
  const pool = createRecordingPool([
    {
      rows: [
        {
          id: 'site-1',
          name: '示例站点',
          url: 'https://relay.example.com',
          type: 'sub2api',
          username: 'admin',
          password: 'plain',
          auth_token: 'token',
          refresh_token: 'rt-refresh',
          auth_token_rotated_at: '2026-07-04T01:30:00.000Z',
          refresh_token_rotated_at: '2026-07-04T01:40:00.000Z',
          created_at: '2026-07-04T01:00:00.000Z',
          updated_at: '2026-07-04T01:00:00.000Z',
        },
      ],
    },
  ]);
  const repository = createSiteRepository(pool);

  const site = await repository.getSiteById('site-1');

  assert.match(pool.queries[0].text, /where s\.id = \$1/i);
  assert.deepEqual(pool.queries[0].values, ['site-1']);
  assert.equal(site.authToken, 'token');
  assert.equal(site.refreshToken, 'rt-refresh');
  assert.equal(site.authTokenRotatedAt, '2026-07-04T01:30:00.000Z');
  assert.equal(site.refreshTokenRotatedAt, '2026-07-04T01:40:00.000Z');
});

test('repository updates auth tokens and records token rotation timestamps', async () => {
  const updatedRow = {
    id: 'site-1',
    name: '示例站点',
    url: 'https://relay.example.com',
    type: 'sub2api',
    username: 'admin',
    password: 'plain',
    auth_token: 'fresh-token',
    refresh_token: 'rt-fresh',
    auth_token_rotated_at: '2026-07-05T01:00:00.000Z',
    refresh_token_rotated_at: '2026-07-05T01:00:00.000Z',
    created_at: '2026-07-04T01:00:00.000Z',
    updated_at: '2026-07-05T01:00:00.000Z',
  };
  const pool = createRecordingPool([{ rows: [updatedRow] }]);
  const repository = createSiteRepository(pool);

  const site = await repository.updateSiteAuthTokens('site-1', {
    authToken: ' fresh-token ',
    refreshToken: ' rt-fresh ',
    rotatedAt: '2026-07-05T01:00:00.000Z',
  });

  assert.match(pool.queries[0].text, /auth_token_rotated_at = \$3::timestamptz/i);
  assert.match(pool.queries[0].text, /refresh_token_rotated_at = \$3::timestamptz/i);
  assert.deepEqual(pool.queries[0].values, [
    'fresh-token',
    'rt-fresh',
    '2026-07-05T01:00:00.000Z',
    'site-1',
  ]);
  assert.equal(site.authToken, 'fresh-token');
  assert.equal(site.refreshToken, 'rt-fresh');
  assert.equal(site.authTokenRotatedAt, '2026-07-05T01:00:00.000Z');
  assert.equal(site.refreshTokenRotatedAt, '2026-07-05T01:00:00.000Z');
});

test('repository inserts validated site metadata with parameterized SQL', async () => {
  const insertedRow = {
    id: 'site-2',
    name: '示例站点',
    url: 'https://relay.example.com',
    type: 'new-api',
    username: 'admin',
    password: 'plain',
    new_api_user_id: '175',
    auth_token: 'token',
    refresh_token: 'rt-refresh',
    usd_to_cny_rate: '7',
    created_at: '2026-07-04T01:00:00.000Z',
    updated_at: '2026-07-04T01:00:00.000Z',
  };
  const pool = createRecordingPool([{ rows: [insertedRow] }]);
  const repository = createSiteRepository(pool);

  const site = await repository.createSite({
    name: '示例站点',
    url: 'relay.example.com',
    base_url: 'api.relay.example.com',
    type: 'new-api',
    username: 'admin',
    password: 'plain',
    new_api_user_id: '175',
    auth_token: 'token',
    refresh_token: 'rt-refresh',
    usd_to_cny_rate: 7,
  });

  assert.match(pool.queries[0].text, /insert into upstream_sites/i);
  assert.deepEqual(pool.queries[0].values, [
    '示例站点',
    'https://relay.example.com',
    'https://api.relay.example.com',
    'new-api',
    'admin',
    'plain',
    '175',
    'standard',
    'token',
    'rt-refresh',
    7,
    0,
    1,
    null,
  ]);
  assert.equal(site.id, 'site-2');
});

test('repository updates validated site metadata with parameterized SQL', async () => {
  const updatedRow = {
    id: 'site-2',
    name: '示例站点 edited',
    url: 'https://relay.example.com',
    type: 'sub2api',
    username: '',
    password: 'plain',
    auth_token: 'token',
    refresh_token: 'rt-refresh',
    usd_to_cny_rate: '1',
    created_at: '2026-07-04T01:00:00.000Z',
    updated_at: '2026-07-04T02:00:00.000Z',
  };
  const pool = createRecordingPool([{ rows: [updatedRow], rowCount: 1 }]);
  const repository = createSiteRepository(pool);

  const site = await repository.updateSite('site-2', {
    name: '示例站点 edited',
    url: 'relay.example.com',
    base_url: 'api.relay.example.com',
    type: 'sub2api',
    username: 'ignored-for-sub2api',
    password: 'plain',
    auth_token: 'token',
    refresh_token: 'rt-refresh',
    usd_to_cny_rate: 1,
  });

  assert.match(pool.queries[0].text, /update upstream_sites/i);
  assert.match(pool.queries[0].text, /where id = \$14/i);
  assert.deepEqual(pool.queries[0].values, [
    '示例站点 edited',
    'https://relay.example.com',
    'sub2api',
    'ignored-for-sub2api',
    'plain',
    '',
    'standard',
    'token',
    'rt-refresh',
    1,
    0,
    null,
    'https://api.relay.example.com',
    'site-2',
    1,
  ]);
  assert.equal(site.id, 'site-2');
  assert.equal(site.updatedAt, '2026-07-04T02:00:00.000Z');
});

test('repository returns null when updating a missing site', async () => {
  const pool = createRecordingPool([{ rows: [], rowCount: 0 }]);
  const repository = createSiteRepository(pool);

  const site = await repository.updateSite('missing-site', {
    name: 'missing',
    url: 'https://relay.example.com',
    base_url: 'https://api.relay.example.com',
    type: 'other',
  });

  assert.equal(site, null);
});

test('repository deletes one site by id', async () => {
  const pool = createRecordingPool([{ rows: [], rowCount: 1 }]);
  const repository = createSiteRepository(pool);

  const deleted = await repository.deleteSite('site-2');

  assert.equal(deleted, true);
  assert.match(pool.queries[0].text, /delete from upstream_sites/i);
  assert.match(pool.queries[0].text, /where id = \$1/i);
  assert.deepEqual(pool.queries[0].values, ['site-2']);
});

test('repository reports false when deleting a missing site', async () => {
  const pool = createRecordingPool([{ rows: [], rowCount: 0 }]);
  const repository = createSiteRepository(pool);

  const deleted = await repository.deleteSite('missing-site');

  assert.equal(deleted, false);
});

test('snapshot repository stores raw sub2api payload and normalized dashboard snapshot', async () => {
  const pool = createSnapshotRecordingPool([{ rows: [] }, { rows: [{ id: 'snapshot-1' }] }]);
  const repository = createSnapshotRepository(pool);
  const rawPayload = { profile: { data: { balance: 23.7 } }, groups: { data: [] } };
  const normalizedSnapshot = { siteId: 'site-1', balanceAmount: 23.7, groups: [] };

  const id = await repository.saveSnapshot({
    site: { id: 'site-1', type: 'sub2api' },
    rawPayload,
    normalizedSnapshot,
    fetchedAt: '2026-07-04T01:00:00.000Z',
  });

  assert.equal(id, 'snapshot-1');
  assert.equal(pool.queries[0].text, 'begin');
  assert.match(pool.queries[1].text, /from upstream_sites.*for update/i);
  assert.equal(pool.queries.at(-1).text, 'commit');
  assert.equal(pool.released, true);
  const anchorQuery = pool.queries.find((query) => /select normalized_snapshot/i.test(query.text));
  assert.match(anchorQuery.text, /select normalized_snapshot, fetched_at from sub2api_snapshots/i);
  const insertQuery = pool.queries.find((query) => /insert into sub2api_snapshots/i.test(query.text));
  assert.ok(insertQuery);
  assert.match(insertQuery.text, /on conflict \(site_id\) do update/i);
  assert.match(insertQuery.text, /raw_payload = excluded\.raw_payload/i);
  assert.match(insertQuery.text, /normalized_snapshot = excluded\.normalized_snapshot/i);
  assert.match(insertQuery.text, /fetched_at = excluded\.fetched_at/i);
  assert.match(insertQuery.text, /returning id/i);
  assert.deepEqual(insertQuery.values, [
    'site-1',
    rawPayload,
    normalizedSnapshot,
    '2026-07-04T01:00:00.000Z',
  ]);
  assert.equal(pool.queries.some((query) => /delete from sub2api_snapshots/i.test(query.text)), false);
});

test('snapshot repository records the previous snapshot balance as depletion anchor', async () => {
  const pool = createSnapshotRecordingPool([
    {
      rows: [{
        normalized_snapshot: { balanceAmount: 50, balanceCurrency: 'CNY' },
        fetched_at: '2026-07-04T01:00:00.000Z',
      }],
    },
    { rows: [{ id: 'snapshot-2' }] },
  ]);
  const repository = createSnapshotRepository(pool);
  const normalizedSnapshot = { siteId: 'site-1', balanceAmount: 40, balanceCurrency: 'CNY' };

  await repository.saveSnapshot({
    site: { id: 'site-1', type: 'sub2api' },
    rawPayload: {},
    normalizedSnapshot,
    fetchedAt: '2026-07-04T02:00:00.000Z',
  });

  const insertQuery = pool.queries.find((query) => /insert into sub2api_snapshots/i.test(query.text));
  assert.deepEqual(insertQuery.values[2], {
    ...normalizedSnapshot,
    previousBalance: {
      amount: 50,
      currency: 'CNY',
      refreshedAt: '2026-07-04T01:00:00.000Z',
    },
  });
});

test('snapshot repository keeps the old anchor when the new snapshot is an error', async () => {
  const anchor = { amount: 50, currency: 'CNY', refreshedAt: '2026-07-04T00:00:00.000Z' };
  const pool = createSnapshotRecordingPool([
    {
      rows: [{
        normalized_snapshot: { balanceAmount: 40, balanceCurrency: 'CNY', previousBalance: anchor },
        fetched_at: '2026-07-04T01:00:00.000Z',
      }],
    },
    { rows: [{ id: 'snapshot-3' }] },
  ]);
  const repository = createSnapshotRepository(pool);
  const errorSnapshot = { siteId: 'site-1', error: 'boom' };

  await repository.saveSnapshot({
    site: { id: 'site-1', type: 'sub2api' },
    rawPayload: {},
    normalizedSnapshot: errorSnapshot,
    fetchedAt: '2026-07-04T02:00:00.000Z',
  });

  const insertQuery = pool.queries.find((query) => /insert into sub2api_snapshots/i.test(query.text));
  assert.deepEqual(insertQuery.values[2], { ...errorSnapshot, previousBalance: anchor });
});

test('snapshot repository uses the same atomic upsert for new-api snapshots', async () => {
  const pool = createSnapshotRecordingPool([{ rows: [] }, { rows: [{ id: 'snapshot-new' }] }], { type: 'new-api' });
  const repository = createSnapshotRepository(pool);

  const id = await repository.saveSnapshot({
    site: { id: 'site-1', type: 'new-api' },
    rawPayload: { profile: { balance: 24 } },
    normalizedSnapshot: { siteId: 'site-1', balanceAmount: 24 },
    fetchedAt: '2026-07-04T03:00:00.000Z',
  });

  assert.equal(id, 'snapshot-new');
  const insertQuery = pool.queries.find((query) => /insert into new_api_snapshots/i.test(query.text));
  assert.ok(insertQuery);
  assert.match(insertQuery.text, /on conflict \(site_id\) do update/i);
  assert.equal(pool.queries.at(-1).text, 'commit');
  assert.equal(pool.released, true);
  assert.equal(pool.queries.some((query) => /delete from new_api_snapshots/i.test(query.text)), false);
});

test('snapshot repository does not leave a delete window when its atomic upsert fails', async () => {
  const pool = createFailingSnapshotPool();
  const repository = createSnapshotRepository(pool);

  await assert.rejects(
    repository.saveSnapshot({
      site: { id: 'site-1', type: 'sub2api' },
      rawPayload: { profile: { balance: 24 } },
      normalizedSnapshot: { siteId: 'site-1', balanceAmount: 24 },
      fetchedAt: '2026-07-04T03:00:00.000Z',
    }),
    /insert failed/,
  );

  assert.equal(pool.queries.some((query) => /delete from sub2api_snapshots/i.test(query.text)), false);
  assert.equal(pool.released, true);
  assert.equal(pool.queries.at(-1).text, 'rollback');
  assert.equal(pool.queries.some((query) => query.text === 'commit'), false);
});

test('snapshot repository reads latest normalized snapshot from table matching site type', async () => {
  const pool = createRecordingPool([
    {
      rows: [
        {
          normalized_snapshot: { siteId: 'site-1', balanceAmount: 23.7 },
          fetched_at: '2026-07-04T01:00:00.000Z',
        },
      ],
    },
  ]);
  const repository = createSnapshotRepository(pool);

  const snapshot = await repository.getLatestSnapshot({ id: 'site-1', type: 'new-api' });

  assert.match(pool.queries[0].text, /from new_api_snapshots/i);
  assert.match(pool.queries[0].text, /order by fetched_at desc/i);
  assert.deepEqual(pool.queries[0].values, ['site-1']);
  assert.deepEqual(snapshot, {
    siteId: 'site-1',
    balanceAmount: 23.7,
    refreshedAt: '2026-07-04T01:00:00.000Z',
  });
});

test('ui preferences repository lists group filter presets from the dedicated table', async () => {
  const pool = createRecordingPool([
    {
      rows: [
        {
          name: '低价openai',
          filters: { name: '低价openai', groupMultiplierMin: 0.03, groupMultiplierMax: 0.08 },
          updated_at: new Date('2026-08-01T10:00:00.000Z'),
        },
      ],
    },
  ]);
  const repository = createUiPreferencesRepository(pool);

  const presets = await repository.listGroupFilterPresets();

  assert.match(pool.queries[0].text, /from group_filter_presets/i);
  assert.deepEqual(presets, [
    {
      name: '低价openai',
      groupMultiplierMin: 0.03,
      groupMultiplierMax: 0.08,
      groupModelFilter: 'all',
      groupPlatformFilter: 'all',
      groupSiteFilter: 'all',
      groupKeyFilter: '1',
      groupMyGroupFilter: [],
      groupSchedulableFilter: 'all',
      updatedAt: '2026-08-01T10:00:00.000Z',
    },
  ]);
});

test('ui preferences repository upserts a preset and removes the old name in one transaction', async () => {
  const upsertRow = {
    name: '低价openai',
    filters: { name: '低价openai', groupMultiplierMin: 0.02 },
    updated_at: new Date('2026-08-01T10:01:00.000Z'),
  };
  const pool = createPresetTransactionPool(upsertRow);
  const repository = createUiPreferencesRepository(pool);

  const preset = await repository.upsertGroupFilterPreset({
    name: '低价openai',
    groupMultiplierMin: 0.02,
    originalName: '旧名',
  });

  const kinds = pool.queries.map((query) => {
    if (/^\s*begin\s*$/i.test(query.text)) return 'begin';
    if (/delete from group_filter_presets/i.test(query.text)) return 'delete-old';
    if (/insert into group_filter_presets/i.test(query.text)) return 'upsert';
    if (/^\s*commit\s*$/i.test(query.text)) return 'commit';
    return 'unexpected';
  });
  assert.deepEqual(kinds, ['begin', 'delete-old', 'upsert', 'commit']);
  assert.deepEqual(pool.queries[1].values, ['旧名']);
  assert.equal(pool.queries[2].values[0], '低价openai');
  assert.match(pool.queries[2].text, /on conflict \(name\)\s+do update/i);
  assert.equal(preset.groupMultiplierMin, 0.02);
  assert.equal(preset.updatedAt, '2026-08-01T10:01:00.000Z');
  assert.equal(pool.client.released, true);
});

test('ui preferences repository skips the delete when the preset name is unchanged', async () => {
  const pool = createPresetTransactionPool({
    name: '低价openai',
    filters: { name: '低价openai', groupMultiplierMin: 0.02 },
    updated_at: new Date('2026-08-01T10:02:00.000Z'),
  });
  const repository = createUiPreferencesRepository(pool);

  await repository.upsertGroupFilterPreset({ name: '低价openai', groupMultiplierMin: 0.02, originalName: '低价openai' });

  assert.equal(pool.queries.some((query) => /delete from group_filter_presets/i.test(query.text)), false);
});

test('ui preferences repository deletes presets by name', async () => {
  const pool = createRecordingPool([{ rows: [], rowCount: 1 }, { rows: [], rowCount: 0 }]);
  const repository = createUiPreferencesRepository(pool);

  assert.equal(await repository.deleteGroupFilterPreset('低价openai'), true);
  assert.equal(await repository.deleteGroupFilterPreset('missing'), false);
  assert.equal(await repository.deleteGroupFilterPreset(''), false);
  assert.match(pool.queries[0].text, /delete from group_filter_presets where name = \$1/i);
  assert.equal(pool.queries.length, 2);
});

function createPresetTransactionPool(upsertRow) {
  const pool = {
    queries: [],
    client: null,
    async query(text, values = []) {
      pool.queries.push({ text, values, source: 'pool' });
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      const client = {
        released: false,
        async query(text, values = []) {
          pool.queries.push({ text, values, source: 'client' });
          if (/insert into group_filter_presets/i.test(text)) return { rows: [upsertRow], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release() {
          client.released = true;
        },
      };
      pool.client = client;
      return client;
    },
  };
  return pool;
}

function createRecordingPool(results = [], options = {}) {
  const pool = {
    queries: [],
    clients: [],
    async query(text, values = []) {
      return recordQuery({ text, values, source: 'pool' });
    },
    async connect() {
      const clientIndex = pool.clients.length + 1;
      const client = {
        queries: [],
        released: false,
        async query(text, values = []) {
          const query = { text, values, source: `client-${clientIndex}` };
          client.queries.push(query);
          pool.queries.push(query);
          const failure = options.failClientQuery?.({ text, values, clientIndex });
          if (failure) throw failure;
          return queryResult(text);
        },
        release() {
          client.released = true;
        },
      };
      pool.clients.push(client);
      return client;
    },
  };

  function recordQuery(query) {
    pool.queries.push(query);
    if (results.length > 0 && !/^\s*(begin|commit|rollback)\s*$/i.test(query.text)) {
      return results.shift();
    }
    return queryResult(query.text);
  }

  function queryResult(text) {
    if (!/select|returning/i.test(text)) return { rows: [], rowCount: 0 };
    return { rows: [] };
  }

  return pool;
}

function classifySnapshotMigrationQuery(text, tableName) {
  if (/^\s*begin\s*$/i.test(text)) return 'begin';
  if (new RegExp(`lock table ${tableName}`, 'i').test(text)) return 'lock';
  if (new RegExp(`delete from ${tableName}`, 'i').test(text)) return 'dedupe';
  if (new RegExp(`create unique index if not exists ${tableName}_site_id_unique_idx`, 'i').test(text)) return 'unique-index';
  if (/^\s*commit\s*$/i.test(text)) return 'commit';
  if (/^\s*rollback\s*$/i.test(text)) return 'rollback';
  return 'unexpected';
}

function createSnapshotRecordingPool(results = [], { type = 'sub2api', failInsert = false, missingSite = false, failAudit = false } = {}) {
  const pool = {
    queries: [],
    released: false,
    async connect() {
      return {
        async query(text, values = []) {
          pool.queries.push({ text, values });
          if (/from upstream_sites.*for update/i.test(text)) {
            return { rows: missingSite ? [] : [{ id: 'site-1', type, name: '测试站点', usd_to_cny_rate: 1 }] };
          }
          if (/insert into (sub2api|new_api)_snapshots/i.test(text) && failInsert) throw new Error('insert failed');
          if (/group_rate_baselines/i.test(text) && failAudit) throw new Error('audit failed');
          if (/select normalized_snapshot|insert into (sub2api|new_api)_snapshots/i.test(text)) {
            return results.shift() ?? { rows: [] };
          }
          return { rows: [] };
        },
        release() { pool.released = true; },
      };
    },
  };
  return pool;
}

function createFailingSnapshotPool() {
  return createSnapshotRecordingPool([{ rows: [] }], { failInsert: true });
}

test('validateSiteInput enforces credential-flow rules for sub2api', () => {
  assert.throws(
    () => validateSiteInput({ name: 'x', url: 'https://alpha.example.test', base_url: 'https://api.alpha.example.test', type: 'sub2api', sync_variant: 'credential-flow', username: 'u' }),
    /Login username and password are required for credential-flow sub2api/,
  );

  const flow = validateSiteInput({
    name: 'x',
    url: 'https://alpha.example.test',
    base_url: 'https://api.alpha.example.test',
    type: 'sub2api',
    sync_variant: 'credential-flow',
    username: 'user@example.com',
    password: 'pw',
  });
  assert.equal(flow.syncVariant, 'credential-flow');
  assert.equal(flow.authToken, '');

  assert.throws(
    () => validateSiteInput({ name: 'x', url: 'https://alpha.example.test', base_url: 'https://api.alpha.example.test', type: 'sub2api', sync_variant: 'weird' }),
    /Unsupported sync variant: weird/,
  );
  assert.throws(
    () => validateSiteInput({ name: 'x', url: 'https://alpha.example.test', base_url: 'https://api.alpha.example.test', type: 'sub2api', username: 'u', password: 'p' }),
    /Bearer Token is required for sub2api/,
  );
});

test('batch proxy deletion uses one database statement and returns deleted IDs', async () => {
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const pool = createRecordingPool([{ rows: [{ id: ids[0] }, { id: ids[1] }] }]);
  const deleted = await createProxyRepository(pool).deleteProxiesBatch(ids);
  assert.deepEqual(deleted, ids);
  assert.match(pool.queries[0].text, /delete from proxies where id = any\(\$1::uuid\[\]\) returning id/);
  assert.deepEqual(pool.queries[0].values, [ids]);
});

for (const [label, options, error] of [
  ['missing site', { missingSite: true }, /no longer exists/],
  ['changed site type', { type: 'new-api' }, /type changed/],
  ['audit write failure', { failAudit: true }, /audit failed/],
]) {
  test(`snapshot transaction rolls back and releases its client on ${label}`, async () => {
    const pool = createSnapshotRecordingPool([{ rows: [] }, { rows: [{ id: 'snapshot-1' }] }], options);
    await assert.rejects(createSnapshotRepository(pool).saveSnapshot({
      site: { id: 'site-1', type: 'sub2api' }, rawPayload: {},
      normalizedSnapshot: { groups: [{ id: 'g1', multiplier: 1, multiplierKnown: true }] },
      fetchedAt: '2026-10-02T00:00:00.000Z',
    }), error);
    assert.equal(pool.queries.at(-1).text, 'rollback');
    assert.equal(pool.queries.some((query) => query.text === 'commit'), false);
    assert.equal(pool.released, true);
  });
}
