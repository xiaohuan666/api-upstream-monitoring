import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createSiteRepository, createSnapshotRepository, createUiPreferencesRepository, initializeDatabase } from '../src/db.mjs';
import { createSnapshotService } from '../src/snapshots.mjs';
import { createGroupRateChangeRepository } from '../src/group-rate-store.mjs';
import { createRequestHandler } from '../src/http.mjs';

const connectionString = process.env.GROUP_RATE_TEST_DATABASE_URL;

test('real snapshot refresh atomically audits effective rates, rolls back failures and preserves history', { skip: !connectionString, timeout: 30_000 }, async (t) => {
  const schema = `rate_integration_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  t.after(async () => { await pool.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
  await initializeDatabase(pool);
  await initializeDatabase(pool);
  const repository = createSiteRepository(pool);
  const site = await repository.createSite({ name: '审计测试站点', type: 'sub2api', url: 'https://audit.test', auth_token: 'local-fixture-only', usd_to_cny_rate: 7 });
  const snapshotRepository = createSnapshotRepository(pool);
  const changes = createGroupRateChangeRepository(pool);
  let multiplier = 0.1;
  let step = 0;
  let callbacks = 0;
  const snapshotService = createSnapshotService({
    snapshotRepository, siteRepository: repository,
    adapters: { async sub2api() {
      step += 1;
      return { normalizedSnapshot: {
        siteId: site.id, groups: [{ id: 'g/a', name: '分组 A', platform: 'anthropic', ratePlatform: 'anthropic', multiplier, multiplierKnown: true }],
        balanceCurrency: 'USD', balanceAmount: 50, refreshedAt: new Date(Date.parse('2026-10-02T01:00:00Z') + step * 1000).toISOString(),
      }, rawPayload: { private: 'not-in-audit' } };
    } },
    onSnapshotSaved: async () => { callbacks += 1; },
  });
  const server = createServer(createRequestHandler({ publicDir: new URL('../', import.meta.url), repository, snapshotService, groupRateChangeRepository: changes, uiPreferencesRepository: createUiPreferencesRepository(pool) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const refresh = () => fetch(`${base}/api/sites/${site.id}/snapshot/refresh`, { method: 'POST' });
  const history = async () => (await fetch(`${base}/api/group-rate-changes?asOf=2026-10-03T00%3A00%3A00Z`)).json();

  assert.equal((await refresh()).status, 200);
  assert.equal((await history()).total, 0);
  multiplier = 0.2;
  assert.equal((await refresh()).status, 200);
  let records = await history();
  assert.equal(records.total, 1);
  assert.equal(records.items[0].oldMultiplier, 0.7);
  assert.equal(records.items[0].newMultiplier, 1.4);
  assert.equal(records.items[0].rawNewMultiplier, 0.2);
  assert.equal(records.items[0].groupId, 'g/a');
  assert.equal(records.items[0].platform, 'anthropic');
  assert.equal(records.items[0].siteUrl, 'https://audit.test');
  assert.doesNotMatch(JSON.stringify(records), /local-fixture|not-in-audit|private|auth/i);

  const preferenceUrl = `${base}/api/ui-preferences/rate-change-history`;
  const initial = await (await fetch(preferenceUrl)).json();
  assert.deepEqual(initial.preference.preferences.columnOrder, ['platform', 'group', 'site', 'change', 'old', 'new']);
  const preferenceResponse = await fetch(preferenceUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ columnOrder: ['new', 'site', 'new', 'removed'] }) });
  assert.equal(preferenceResponse.status, 200);
  const preferenceSaved = await preferenceResponse.json();
  assert.deepEqual(preferenceSaved.preference.preferences.columnOrder, ['new', 'site', 'platform', 'group', 'change', 'old']);
  assert.deepEqual(await (await fetch(preferenceUrl)).json(), preferenceSaved);

  // 数据库审计插入失败必须连快照、基线一起回滚，且不能执行外部跟随钩子。
  await pool.query(`create function reject_rate_event() returns trigger language plpgsql as $$ begin raise exception 'test audit rejected'; end $$`);
  await pool.query('create trigger reject_rate_event before insert on group_rate_changes for each row execute function reject_rate_event()');
  const before = await snapshotRepository.getLatestSnapshot(site);
  multiplier = 0.3;
  const rejected = await refresh();
  assert.equal(rejected.status, 502);
  assert.equal(callbacks, 2);
  assert.deepEqual(await snapshotRepository.getLatestSnapshot(site), before);
  assert.equal((await history()).total, 1);
  assert.equal((await pool.query('select groups from group_rate_baselines')).rows[0].groups[0].multiplier, 0.2);
  await pool.query('drop trigger reject_rate_event on group_rate_changes');

  assert.equal((await refresh()).status, 200);
  records = await history();
  assert.equal(records.total, 2);
  assert.equal(records.items[0].rawOldMultiplier, 0.2);
  assert.equal(records.items[0].rawNewMultiplier, 0.3);
  assert.equal((await refresh()).status, 200);
  assert.equal((await history()).total, 2);

  // 汇率改动不是上游倍率变动；真实变动两端按事件时同一最新汇率显示。
  await pool.query('update upstream_sites set usd_to_cny_rate = 3, name = $1 where id = $2', ['改名后的站点', site.id]);
  assert.equal((await refresh()).status, 200);
  assert.equal((await history()).total, 2);
  multiplier = 0.4;
  assert.equal((await refresh()).status, 200);
  const latest = (await history()).items[0];
  assert.equal(latest.oldMultiplier, 0.9);
  assert.equal(latest.newMultiplier, 1.2);
  assert.equal(latest.siteName, '改名后的站点');
  const stale = { ...before, groups: [{ id: 'g/a', multiplier: 9, multiplierKnown: true }] };
  await assert.rejects(snapshotRepository.saveSnapshot({ site, normalizedSnapshot: stale, rawPayload: {}, fetchedAt: '2026-10-02T00:00:00Z' }), /Stale snapshot/);
  assert.equal((await snapshotRepository.getLatestSnapshot(site)).groups[0].multiplier, 0.4);
  assert.equal((await history()).total, 3);
  await repository.deleteSite(site.id);
  assert.equal((await history()).total, 3);
  assert.ok((await history()).items.every((event) => event.platform === 'anthropic' && event.siteUrl === 'https://audit.test'));
  assert.equal(Number((await pool.query('select count(*) from group_rate_baselines')).rows[0].count), 0);
});

test('concurrent first snapshot writes use the site row lock and create one baseline without duplicate events', { skip: !connectionString, timeout: 30_000 }, async (t) => {
  const schema = `rate_concurrent_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  t.after(async () => { await pool.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
  await initializeDatabase(pool);
  const site = await createSiteRepository(pool).createSite({ name: '并发站点', type: 'new-api', url: 'https://concurrent.test', auth_token: 'fixture', new_api_user_id: '1' });
  const repository = createSnapshotRepository(pool);
  const save = (rate, timestamp) => repository.saveSnapshot({ site, rawPayload: {}, fetchedAt: timestamp,
    normalizedSnapshot: { groups: [{ id: 'g', multiplier: rate, multiplierKnown: true }], balanceCurrency: 'CNY' },
  });
  await Promise.all(Array.from({ length: 6 }, () => save(1, '2026-10-02T00:00:00Z')));
  assert.equal(Number((await pool.query('select count(*) from group_rate_baselines')).rows[0].count), 1);
  assert.equal(Number((await pool.query('select count(*) from group_rate_changes')).rows[0].count), 0);
  await Promise.all(Array.from({ length: 6 }, () => save(2, '2026-10-02T00:00:01Z')));
  assert.equal(Number((await pool.query('select count(*) from group_rate_changes')).rows[0].count), 1);
  assert.equal(Number((await pool.query('select count(*) from new_api_snapshots')).rows[0].count), 1);
});
