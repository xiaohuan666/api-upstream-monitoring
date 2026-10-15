import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createSiteRepository, initializeDatabase } from '../src/db.mjs';

const connectionString = process.env.PROXY_PROVIDER_TEST_DATABASE_URL;

test('PostgreSQL backfills existing sites to one hour and persists custom thresholds', {
  skip: !connectionString,
  timeout: 30_000,
}, async () => {
  const schema = `depletion_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  try {
    await admin.query(`create schema ${schema}`);
    await initializeDatabase(pool);
    const repository = createSiteRepository(pool);
    const legacy = await repository.createSite({ name: '旧站点', url: 'https://legacy.test', type: 'other', balance_alert: 5 });
    const before = await pool.query('select updated_at from upstream_sites where id = $1', [legacy.id]);
    await pool.query('alter table upstream_sites drop column depletion_alert_hours');

    await initializeDatabase(pool);
    await initializeDatabase(pool);
    const backfilled = await repository.getSiteById(legacy.id);
    assert.equal(backfilled.depletionAlertHours, 1);
    assert.equal(backfilled.balanceAlert, 5);
    assert.equal(backfilled.name, '旧站点');
    const after = await pool.query('select updated_at from upstream_sites where id = $1', [legacy.id]);
    assert.equal(after.rows[0].updated_at.toISOString(), before.rows[0].updated_at.toISOString());

    const updated = await repository.updateSite(legacy.id, {
      name: legacy.name, url: legacy.url, type: legacy.type,
      balance_alert: legacy.balanceAlert, depletion_alert_hours: 0.5,
    });
    assert.equal(updated.depletionAlertHours, 0.5);
    assert.equal((await repository.getSiteById(legacy.id)).depletionAlertHours, 0.5);
    const created = await repository.createSite({ name: '新站点', url: 'https://new.test', type: 'other' });
    assert.equal(created.depletionAlertHours, 1);
    await assert.rejects(pool.query('update upstream_sites set depletion_alert_hours = -1 where id = $1', [legacy.id]),
      /upstream_sites_depletion_alert_hours_nonnegative/);
  } finally {
    await pool.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
});
