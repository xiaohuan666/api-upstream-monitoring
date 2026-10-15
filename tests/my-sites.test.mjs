import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MySiteAccountConflictError,
  createMySiteAccountRepository,
  createMySiteRepository,
  createMySitesTables,
  normalizeMySiteRecord,
  validateMySiteInput,
} from '../src/my-sites.mjs';

test('validateMySiteInput normalizes url to origin and requires admin key', () => {
  const input = validateMySiteInput({
    name: ' 我的主站 ',
    url: 'https://api.example.com/admin/keys',
    adminKey: ' admin-key-1 ',
  });

  assert.deepEqual(input, {
    name: '我的主站',
    type: 'sub2api',
    url: 'https://api.example.com',
    adminKey: 'admin-key-1',
  });
});

test('validateMySiteInput rejects missing fields and unsupported type', () => {
  assert.throws(() => validateMySiteInput({ url: 'https://alpha.example.test', adminKey: 'k' }), /Site name is required/);
  assert.throws(
    () => validateMySiteInput({ name: 'a', url: 'https://alpha.example.test', adminKey: 'k', type: 'other' }),
    /Unsupported my site type/,
  );
  assert.throws(
    () => validateMySiteInput({ name: 'a', url: 'https://alpha.example.test' }),
    /Admin API key is required/,
  );
  assert.throws(
    () => validateMySiteInput({ name: 'a', adminKey: 'k' }),
    /Site URL is required/,
  );
});

test('createMySitesTables creates both tables with triggers and index', async () => {
  const pool = createRecordingPool();

  await createMySitesTables(pool);

  const ddl = pool.queries.map((query) => query.text).join('\n');
  assert.match(ddl, /create table if not exists my_sites/i);
  assert.match(ddl, /check \(type in \('sub2api', 'new-api'\)\)/i);
  assert.match(ddl, /create table if not exists my_site_accounts/i);
  assert.match(ddl, /references my_sites\(id\) on delete cascade/i);
  assert.match(ddl, /references upstream_sites\(id\) on delete cascade/i);
  assert.match(ddl, /unique \(my_site_id, my_group_id, upstream_site_id, upstream_group_id\)/i);
  assert.match(ddl, /create trigger my_sites_set_updated_at/i);
  assert.match(ddl, /create trigger my_site_accounts_set_updated_at/i);
  assert.match(ddl, /create index if not exists my_site_accounts_upstream_idx/i);
});

test('my site repository creates, lists, updates and deletes my sites', async () => {
  const row = {
    id: 'my-site-1',
    name: '主站',
    type: 'sub2api',
    url: 'https://api.example.com',
    admin_key: 'admin-key-1',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
  const pool = createRecordingPool([
    { rows: [row], rowCount: 1 },
    { rows: [row], rowCount: 1 },
    { rows: [{ ...row, name: '改名' }], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);
  const repository = createMySiteRepository(pool);

  const created = await repository.createMySite({
    name: '主站',
    url: 'https://api.example.com/keys',
    adminKey: 'admin-key-1',
  });
  assert.equal(created.id, 'my-site-1');
  assert.equal(created.adminKey, 'admin-key-1');
  const insertQuery = pool.queries.find((query) => /insert into my_sites/i.test(query.text));
  assert.deepEqual(insertQuery.values, ['主站', 'sub2api', 'https://api.example.com', 'admin-key-1']);

  const listed = await repository.listMySites();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].type, 'sub2api');

  const updated = await repository.updateMySite('my-site-1', {
    name: '改名',
    url: 'https://api.example.com',
    adminKey: 'admin-key-1',
  });
  assert.equal(updated.name, '改名');

  assert.equal(await repository.deleteMySite('my-site-1'), true);
});

test('my site account repository filters, inserts and marks rate synced', async () => {
  const linkRow = {
    id: 'link-1',
    my_site_id: 'my-site-1',
    my_group_id: '7',
    my_group_name: 'gpt-plus',
    my_account_id: '42',
    upstream_site_id: 'site-1',
    upstream_group_id: 'g-1',
    last_synced_rate: '0.05',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
  const pool = createRecordingPool([
    { rows: [linkRow], rowCount: 1 },
    { rows: [linkRow], rowCount: 1 },
    { rows: [{ ...linkRow, last_synced_rate: '0.06' }], rowCount: 1 },
  ]);
  const repository = createMySiteAccountRepository(pool);

  const listed = await repository.listAccounts({ upstreamSiteId: 'site-1' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].myAccountId, '42');
  assert.equal(listed[0].lastSyncedRate, 0.05);
  const filterQuery = pool.queries[0];
  assert.match(filterQuery.text, /where upstream_site_id = \$1/i);
  assert.deepEqual(filterQuery.values, ['site-1']);

  const created = await repository.createAccount({
    mySiteId: 'my-site-1',
    myGroupId: '7',
    myGroupName: 'gpt-plus',
    myAccountId: '42',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
    lastSyncedRate: 0.05,
  });
  assert.equal(created.myGroupName, 'gpt-plus');
  const insertQuery = pool.queries.find((query) => /insert into my_site_accounts/i.test(query.text));
  assert.deepEqual(insertQuery.values, ['my-site-1', '7', 'gpt-plus', '42', 'site-1', 'g-1', 0.05]);

  const synced = await repository.markRateSynced('link-1', 0.06);
  assert.equal(synced.lastSyncedRate, 0.06);
  const updateQuery = pool.queries.find((query) => /update my_site_accounts/i.test(query.text));
  assert.deepEqual(updateQuery.values, ['link-1', 0.06]);
});

test('my site account repository deletes links by id', async () => {
  const pool = createRecordingPool([{ rows: [], rowCount: 1 }]);
  const repository = createMySiteAccountRepository(pool);

  assert.equal(await repository.deleteAccountById('link-1'), true);
  const deleteQuery = pool.queries[0];
  assert.match(deleteQuery.text, /delete from my_site_accounts where id = \$1/i);
  assert.deepEqual(deleteQuery.values, ['link-1']);
});

test('my site account repository maps unique violation to conflict error', async () => {
  const pool = {
    async query() {
      const error = new Error('duplicate key value violates unique constraint');
      error.code = '23505';
      throw error;
    },
  };
  const repository = createMySiteAccountRepository(pool);

  const error = await repository.createAccount({
    mySiteId: 'my-site-1',
    myGroupId: '7',
    myAccountId: '42',
    upstreamSiteId: 'site-1',
    upstreamGroupId: 'g-1',
  }).catch((err) => err);

  assert.ok(error instanceof MySiteAccountConflictError);
  assert.equal(error.statusCode, 409);
});

test('normalizeMySiteRecord maps snake case rows to camelCase', () => {
  const record = normalizeMySiteRecord({
    id: 'my-site-1',
    name: '主站',
    type: 'sub2api',
    url: 'https://api.example.com',
    admin_key: 'k',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z',
  });

  assert.deepEqual(record, {
    id: 'my-site-1',
    name: '主站',
    type: 'sub2api',
    url: 'https://api.example.com',
    adminKey: 'k',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });
});

function createRecordingPool(results = []) {
  const pool = {
    queries: [],
    async query(text, values = []) {
      pool.queries.push({ text, values });
      if (results.length > 0) return results.shift();
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}
