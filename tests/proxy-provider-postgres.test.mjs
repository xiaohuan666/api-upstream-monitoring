import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createProxyRepository, initializeDatabase } from '../src/db.mjs';
import { buildProxyExportContent, PROXY_EXPORT_FORMATS } from '../src/proxy-export.mjs';

const connectionString = process.env.PROXY_PROVIDER_TEST_DATABASE_URL;

test('PostgreSQL migrates legacy proxies and serializes provider imports with atomic rollback', {
  skip: !connectionString,
  timeout: 30_000,
}, async () => {
  const schema = `provider_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  try {
    await admin.query(`create schema ${schema}`);
    // The pre-feature table intentionally has no provider column.
    await pool.query(`create table proxies (
      id uuid primary key, name text not null, protocol text not null, host text not null,
      port integer not null, username text not null default '', password text not null default '',
      status text not null default 'active', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    )`);
    const legacyId = randomUUID();
    await pool.query(`insert into proxies(id, name, protocol, host, port) values($1, '旧服务商-001', 'socks5', 'legacy.test', 1080)`, [legacyId]);
    await initializeDatabase(pool);
    await initializeDatabase(pool);
    await pool.query('alter table proxies alter column id set default gen_random_uuid()');
    const repository = createProxyRepository(pool);
    const legacy = await repository.getProxyById(legacyId);
    assert.equal(legacy.provider, '');
    assert.equal(legacy.name, '旧服务商-001');
    const date = new Date('2026-09-24T00:00:00Z');
    for (const format of PROXY_EXPORT_FORMATS) {
      const { provider, ...oldShape } = legacy;
      assert.equal(buildProxyExportContent([legacy], format.id, date), buildProxyExportContent([oldShape], format.id, date));
    }
    for (const n of [1, 2, 4]) await repository.createProxy({ name: `服务商-00${n}`, provider: '服务商', host: `existing-${n}.test`, port: 1080 });
    const first = await repository.createProxiesBatch([
      { provider: '服务商', host: 'existing-1.test', port: 1080 },
      { provider: '服务商', host: 'new-3.test', port: 1080 },
      { provider: '服务商', host: 'new-3.test', port: 1080 },
      { provider: '服务商', host: 'new-5.test', port: 1080 },
    ]);
    assert.equal(first.skipped, 2);
    assert.deepEqual(first.created.map((p) => p.name), ['服务商-003', '服务商-005']);
    await repository.deleteProxy(first.created[0].id);
    const concurrent = await Promise.all([
      repository.createProxiesBatch([{ provider: '服务商', host: 'parallel-a.test', port: 80 }]),
      repository.createProxiesBatch([{ provider: '服务商', host: 'parallel-b.test', port: 80 }]),
    ]);
    assert.deepEqual(concurrent.flatMap((result) => result.created.map((p) => p.name)).sort(), ['服务商-003', '服务商-006']);
    const duplicate = await Promise.all(Array.from({ length: 2 }, () => repository.createProxiesBatch([
      { provider: '服务商', host: 'same-new.test', port: 80 },
    ])));
    assert.equal(duplicate.reduce((n, result) => n + result.created.length, 0), 1);
    assert.equal(duplicate.reduce((n, result) => n + result.skipped, 0), 1);

    const before = await repository.listProxies();
    await pool.query(`alter table proxies add constraint test_reject_host check (host <> 'reject.test')`);
    await assert.rejects(repository.createProxiesBatch([
      { provider: '服务商', host: 'rollback-first.test', port: 80 },
      { provider: '服务商', host: 'reject.test', port: 80 },
    ]), /test_reject_host/);
    assert.deepEqual(await repository.listProxies(), before);
    const afterRollback = await repository.createProxiesBatch([{ provider: '服务商', host: 'after-rollback.test', port: 80 }]);
    assert.equal(afterRollback.created[0].name, '服务商-008');
    const edited = afterRollback.created[0];
    const { provider, ...withoutProvider } = edited;
    assert.equal((await repository.updateProxy(edited.id, { ...withoutProvider, name: '手动名称' })).provider, '服务商');
    assert.equal((await repository.updateProxy(edited.id, { ...edited, provider: '' })).provider, '');
    const legacyCollision = await repository.createProxiesBatch([{ provider: '旧服务商', host: 'new-legacy.test', port: 80 }]);
    assert.equal(legacyCollision.created[0].name, '旧服务商-002');

    const endpoint = { provider: '凭据边界', host: 'credentials.test', port: 80 };
    await repository.createProxy({ ...endpoint, name: '凭据边界-001', username: 'alice:x', password: 'y' });
    const credentials = await repository.createProxiesBatch([
      { ...endpoint, username: 'alice', password: 'x:y' },
      { ...endpoint, username: 'bob:x', password: 'y' },
      { ...endpoint, username: 'bob', password: 'x:y' },
      { ...endpoint, username: 'bob', password: 'x:y' },
      { ...endpoint, username: 'alice:x', password: 'y' },
    ]);
    assert.equal(credentials.skipped, 2);
    assert.deepEqual(credentials.created.map((p) => p.name), ['凭据边界-002', '凭据边界-003', '凭据边界-004']);
    for (const proxy of credentials.created) assert.deepEqual(await repository.getProxyById(proxy.id), proxy);
  } finally {
    await pool.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
});
