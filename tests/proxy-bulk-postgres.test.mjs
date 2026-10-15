import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createProxyRepository, initializeDatabase } from '../src/db.mjs';
import { createMySitesTables } from '../src/my-sites.mjs';

const connectionString = process.env.PROXY_PROVIDER_TEST_DATABASE_URL;

test('batch delete removes selected proxies and linked rows, setting site proxy references to null', {
  skip: !connectionString,
  timeout: 30_000,
}, async () => {
  const schema = `bulk_proxy_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  try {
    await admin.query(`create schema ${schema}`);
    await initializeDatabase(pool);
    await createMySitesTables(pool);
    const repository = createProxyRepository(pool);
    const first = await repository.createProxy({ name: 'one', host: '192.0.2.1', port: 8080 });
    const second = await repository.createProxy({ name: 'two', host: '192.0.2.2', port: 8080 });
    const unaffected = await repository.createProxy({ name: 'three', host: '192.0.2.3', port: 8080 });
    await pool.query(`insert into upstream_sites (name, url, base_url, type, proxy_id)
      values ('site', 'https://example.test', 'https://example.test', 'other', $1)`, [first.id]);
    const site = await pool.query(`insert into my_sites (name, type, url)
      values ('my site', 'sub2api', 'https://sub.example.test') returning id`);
    await pool.query(`insert into my_site_proxies (my_site_id, proxy_id, my_proxy_id)
      values ($1, $2, '53')`, [site.rows[0].id, first.id]);
    const deleted = await repository.deleteProxiesBatch([first.id, second.id]);
    assert.deepEqual(deleted.sort(), [first.id, second.id].sort());
    assert.deepEqual((await repository.listProxies()).map(({ id }) => id), [unaffected.id]);
    assert.equal((await pool.query('select proxy_id from upstream_sites')).rows[0].proxy_id, null);
    assert.equal((await pool.query('select count(*)::int as total from my_site_proxies')).rows[0].total, 0);
  } finally {
    await pool.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
});
