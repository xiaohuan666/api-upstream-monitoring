import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createSnapshotRepository } from '../src/db.mjs';
import { createGroupRateChangeRepository, createGroupRateTables, recordGroupRateSnapshot } from '../src/group-rate-store.mjs';

const connectionString = process.env.GROUP_RATE_TEST_DATABASE_URL || process.env.PROXY_PROVIDER_TEST_DATABASE_URL;
const pgOptions = { skip: !connectionString, timeout: 30_000 };
const firstTime = '2026-10-01T00:00:00.000Z';
const secondTime = '2026-10-01T00:01:00.000Z';
const asOf = '2026-10-02T00:00:00.000Z';
const group = (id, multiplier, extra = {}) => ({ id, name: `分组${id}`, multiplier, multiplierKnown: true, ...extra });
const snapshot = (groups, extra = {}) => ({ groups, balanceCurrency: 'USD', balanceAmount: 20, probe: { ok: true }, ...extra });

async function withSchema(run) {
  const schema = `group_rate_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 1 });
  // No public fallback: a missing fixture table must fail, never touch business data.
  const pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema}` });
  let created = false;
  try {
    await admin.query(`create schema ${schema}`);
    created = true;
    await pool.query(`create table upstream_sites (
      id uuid primary key, name text not null, url text not null default '', type text not null, usd_to_cny_rate numeric not null default 1
    )`);
    await pool.query(`create table sub2api_snapshots (
      id uuid primary key default gen_random_uuid(),
      site_id uuid not null unique references upstream_sites(id) on delete cascade,
      raw_payload jsonb not null, normalized_snapshot jsonb not null, fetched_at timestamptz not null
    )`);
    await pool.query(`create table new_api_snapshots (
      like sub2api_snapshots including all
    )`);
    await createGroupRateTables(pool);
    await run(pool);
  } finally {
    await pool.end();
    try {
      if (created) await admin.query(`drop schema ${schema} cascade`);
    } finally {
      await admin.end();
    }
  }
}

async function addSite(pool, overrides = {}) {
  const site = { id: randomUUID(), name: '站点', url: 'https://rate.test', type: 'sub2api', usdToCnyRate: 7, ...overrides };
  await pool.query('insert into upstream_sites(id, name, url, type, usd_to_cny_rate) values ($1, $2, $3, $4, $5)',
    [site.id, site.name, site.url, site.type, site.usdToCnyRate]);
  return site;
}

async function save(pool, site, groups, fetchedAt = secondTime, extra = {}) {
  return createSnapshotRepository(pool).saveSnapshot({ site, rawPayload: { fixture: true }, normalizedSnapshot: snapshot(groups, extra), fetchedAt });
}

async function lockedRecord(pool, site, groups, fetchedAt = secondTime, extra = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select id from upstream_sites where id = $1 for update', [site.id]);
    const result = await recordGroupRateSnapshot(client, { site, snapshot: snapshot(groups, extra), fetchedAt });
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function baseline(pool, site) {
  return (await pool.query('select * from group_rate_baselines where site_id = $1', [site.id])).rows[0];
}
async function history(pool, options = {}) {
  return createGroupRateChangeRepository(pool).listChanges({ asOf, ...options });
}

async function insertEvent(pool, { site, id = randomUUID(), groupName = '分组', groupId = 'a', oldRate = 1, newRate = 2, changedAt = secondTime }) {
  await pool.query(`insert into group_rate_changes (
    id, site_id, site_name, site_type, group_id, group_name,
    raw_old_multiplier, raw_new_multiplier, old_multiplier, new_multiplier, changed_at
  ) values ($1,$2,$3,$4,$5,$6,$7,$8,$7,$8,$9)`,
  [id, site.id, site.name, site.type, groupId, groupName, oldRate, newRate, changedAt]);
}

test('PostgreSQL: idempotent schema, first/zero/legacy snapshots only initialize baseline, JSON numeric events', pgOptions, async () => {
  await withSchema(async (pool) => {
    await createGroupRateTables(pool);
    const site = await addSite(pool);
    // Old persisted snapshots are not audit baselines and must not create fictitious history.
    await pool.query('insert into sub2api_snapshots(site_id,raw_payload,normalized_snapshot,fetched_at) values($1,$2,$3,$4)',
      [site.id, {}, snapshot([group('a', 9)]), firstTime]);
    await save(pool, site, [group('a', 0)], secondTime);
    assert.equal((await history(pool)).total, 0);
    assert.equal((await baseline(pool, site)).groups[0].multiplier, 0);
    await save(pool, site, [group('a', '0.5')], '2026-10-01T00:02:00Z');
    const result = await history(pool);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].oldMultiplier, 0);
    assert.equal(result.items[0].newMultiplier, 3.5);
    for (const key of ['rawOldMultiplier', 'rawNewMultiplier', 'oldMultiplier', 'newMultiplier']) assert.equal(typeof result.items[0][key], 'number');
    assert.match(result.items[0].id, /^[\da-f-]{36}$/);
    assert.deepEqual(Object.keys(result.items[0]).sort(), ['id','siteId','siteName','siteType','groupId','groupName','platform','siteUrl','oldMultiplier','newMultiplier','rawOldMultiplier','rawNewMultiplier','changedAt'].sort());
  });
});

test('PostgreSQL: reliable baseline survives failure/unknown observations, handles group identity/removal and context resets', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool);
    await lockedRecord(pool, site, [group('a', 1), group('b', 2)], firstTime);
    const before = await baseline(pool, site);
    for (const [groups, extra] of [
      [[], {}], [[group('a', 0, { multiplierKnown: false })], {}],
      [[group('a', 99)], { error: 'failed' }], [[group('a', 99)], { probe: { ok: false } }],
      [[group('a', null), group('b', 'bad')], {}],
    ]) {
      assert.deepEqual(await lockedRecord(pool, site, groups, secondTime, extra), []);
      assert.deepEqual(await baseline(pool, site), before);
    }
    await lockedRecord(pool, site, [group('a', 0, { multiplierKnown: false }), group('b', 3)], secondTime);
    assert.deepEqual((await baseline(pool, site)).groups.map((g) => g.multiplier), [1, 3]);
    assert.deepEqual((await history(pool)).items.map((g) => g.groupId), ['b']);
    await lockedRecord(pool, site, [group('a', 2, { name: '改名' }), group('c', 0)], '2026-10-01T00:02:00Z');
    assert.equal((await history(pool)).items[0].groupName, '改名');
    await lockedRecord(pool, site, [group('a', 2), group('b', 100), group('c', 0)], '2026-10-01T00:03:00Z');
    assert.equal((await history(pool)).total, 2, 'reappearing b is a new group, not 3 -> 100');
    await lockedRecord(pool, site, [group('a', 5)], '2026-10-01T00:04:00Z', { balanceCurrency: 'CNY' });
    assert.equal((await history(pool)).total, 2);
    await pool.query("update upstream_sites set type = 'new-api' where id = $1", [site.id]);
    await lockedRecord(pool, { ...site, type: 'new-api' }, [group('a', 6)], '2026-10-01T00:05:00Z', { balanceCurrency: 'CNY' });
    assert.equal((await baseline(pool, site)).site_type, 'new-api');
    assert.equal((await history(pool)).total, 2);
  });
});

test('PostgreSQL: current locked site name/rate converts both raw sides, config-only changes do not create events, fine precision persists', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool);
    await save(pool, site, [group('a', 0.1)], firstTime);
    await pool.query('update upstream_sites set name=$2, usd_to_cny_rate=$3 where id=$1', [site.id, '当前名称', 3]);
    await save(pool, site, [group('a', 0.1)], secondTime);
    assert.equal((await history(pool)).total, 0);
    await save(pool, site, [group('a', 0.2, { name: '当前分组' })], '2026-10-01T00:02:00Z');
    const item = (await history(pool)).items[0];
    assert.equal(item.siteName, '当前名称');
    assert.equal(item.groupName, '当前分组');
    assert.equal(item.oldMultiplier, 0.3);
    assert.equal(item.newMultiplier, 0.6);
    assert.equal(item.rawOldMultiplier, 0.1);
    assert.equal(item.rawNewMultiplier, 0.2);
    await save(pool, site, [group('a', 0.2 + 1e-12)], '2026-10-01T00:03:00Z');
    assert.equal((await history(pool)).items[0].rawNewMultiplier, 0.2 + 1e-12);
    await save(pool, site, [group('a', 0.3)], '2026-10-01T00:04:00Z');
    const count = (await history(pool)).total;
    await save(pool, site, [group('a', 0.1 + 0.2)], '2026-10-01T00:05:00Z');
    assert.equal((await history(pool)).total, count);
  });
});

test('PostgreSQL: audit insert and baseline write errors rollback snapshot, all events and baseline together', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool);
    await save(pool, site, [group('a', 1), group('reject', 1)], firstTime);
    const original = await baseline(pool, site);
    const snapshotBefore = await pool.query('select * from sub2api_snapshots');
    await pool.query("alter table group_rate_changes add constraint reject_audit_test check (group_id <> 'reject')");
    await assert.rejects(save(pool, site, [group('a', 2), group('reject', 2)]), /reject_audit_test/);
    assert.deepEqual(await baseline(pool, site), original);
    assert.deepEqual((await pool.query('select * from sub2api_snapshots')).rows, snapshotBefore.rows);
    assert.equal((await history(pool)).total, 0);
    await pool.query('alter table group_rate_changes drop constraint reject_audit_test');
    await pool.query("alter table group_rate_baselines add constraint reject_baseline_test check (groups->0->>'multiplier' <> '3')");
    await assert.rejects(save(pool, site, [group('a', 3), group('reject', 1)]), /reject_baseline_test/);
    assert.deepEqual(await baseline(pool, site), original);
    assert.deepEqual((await pool.query('select * from sub2api_snapshots')).rows, snapshotBefore.rows);
    assert.equal((await history(pool)).total, 0);
    await pool.query('alter table group_rate_baselines drop constraint reject_baseline_test');
    await save(pool, site, [group('a', 3), group('reject', 1)]);
    assert.equal((await history(pool)).total, 1);
  });
});

test('PostgreSQL: concurrent initialization/retries serialize on site row; same-time true changes are retained and stale snapshots cannot rewind', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool);
    await Promise.all(Array.from({ length: 12 }, () => save(pool, site, [group('a', 1)], firstTime)));
    assert.equal((await history(pool)).total, 0);
    assert.equal((await pool.query('select count(*)::int as n from group_rate_baselines')).rows[0].n, 1);
    await Promise.all(Array.from({ length: 12 }, () => save(pool, site, [group('a', 2)], secondTime)));
    assert.equal((await history(pool)).total, 1);
    await save(pool, site, [group('a', 3)], secondTime);
    assert.equal((await history(pool)).total, 2);
    const before = await baseline(pool, site);
    assert.deepEqual(await lockedRecord(pool, site, [group('a', 99)], firstTime), []);
    assert.deepEqual(await baseline(pool, site), before);
    await assert.rejects(save(pool, site, [group('a', 99)], firstTime), /Stale snapshot/);
    assert.deepEqual(await baseline(pool, site), before);
    assert.equal((await history(pool)).total, 2);
    await pool.query("update upstream_sites set type='new-api' where id=$1", [site.id]);
    await assert.rejects(save(pool, site, [group('a', 99)], '2026-10-01T00:02:00Z'), /type changed/);
    assert.deepEqual(await baseline(pool, site), before);
  });
});

test('PostgreSQL: filters, literal substring search, stable asOf/24h boundaries and out-of-range pagination contract', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool, { name: '站点 %_\\ 字面' });
    const other = await addSite(pool, { name: '第二站点' });
    const lowerId = '00000001-0000-4000-8000-000000000000';
    const higherId = '00000002-0000-4000-8000-000000000000';
    await insertEvent(pool, { site, id: lowerId, changedAt: firstTime, oldRate: 0 });
    await insertEvent(pool, { site, id: higherId, changedAt: firstTime, oldRate: 2, newRate: 0 });
    await insertEvent(pool, { site: other, groupName: '匹配_%\\组', changedAt: asOf });
    await insertEvent(pool, { site: other, groupName: 'old', changedAt: '2026-09-30T23:59:59.999Z' });
    await insertEvent(pool, { site: other, groupName: 'future', changedAt: '2026-10-02T00:00:00.001Z' });
    const all = await history(pool);
    assert.equal(all.total, 4);
    assert.equal(all.windowStart, null);
    const recent = await history(pool, { window: '24h', pageSize: 2 });
    assert.equal(recent.total, 3);
    assert.equal(recent.pages, 2);
    assert.equal(recent.windowStart, firstTime);
    assert.equal(recent.asOf, asOf);
    assert.equal(recent.items[1].id, higherId);
    const next = await history(pool, { window: '24h', asOf: recent.asOf, page: 2, pageSize: 2 });
    assert.deepEqual(next.items.map((i) => i.id), [lowerId]);
    assert.equal((await history(pool, { siteId: site.id })).total, 2);
    assert.equal((await history(pool, { siteId: site.id, direction: 'up' })).total, 1);
    assert.equal((await history(pool, { siteId: site.id, direction: 'down' })).total, 1);
    assert.equal((await history(pool, { q: '%_\\' })).total, 2);
    assert.equal((await history(pool, { q: '_%\\' })).total, 1);
    assert.equal((await history(pool, { q: '匹配' })).total, 1);
    assert.equal((await history(pool, { q: "' OR 1=1 --" })).total, 0);
    const empty = await history(pool, { q: 'missing' });
    assert.equal(empty.pages, 1);
    assert.deepEqual(empty.items, []);
    const far = await history(pool, { page: 99, pageSize: 2 });
    assert.equal(far.total, 4);
    assert.equal(far.pages, 2);
    assert.deepEqual(far.items, []);
    await insertEvent(pool, { site, changedAt: '2026-10-02T00:02:00Z' });
    assert.equal((await history(pool, { window: '24h', asOf: recent.asOf })).total, 3);
    assert.equal((await history(pool, { asOf: '2026-10-02T00:03:00Z' })).total, 6);
    for (let i = 0; i < 51; i++) await insertEvent(pool, { site });
    const many = await history(pool);
    assert.equal(many.pageSize, 50);
    assert.equal(many.total, 55);
    assert.equal(many.items.length, 50);
    assert.equal((await history(pool, { page: 2 })).items.length, 5);
    assert.equal((await history(pool, { window: '24h' })).total, 54, '24h is time bounded, not truncated to 50');
  });
});

test('PostgreSQL: count and rows remain internally consistent during concurrent committed audit writes', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool);
    await save(pool, site, [group('a', 1)], firstTime);
    let finished = false;
    let reads = 0;
    const writer = (async () => {
      try {
        for (let i = 2; i <= 41; i++) await save(pool, site, [group('a', i)], secondTime);
      } finally {
        finished = true;
      }
    })();
    const reader = (async () => {
      do {
        const result = await history(pool, { pageSize: 100 });
        assert.equal(result.total, result.items.length);
        reads += 1;
      } while (!finished || reads < 20);
    })();
    // allSettled keeps both operations inside the fixture lifetime even on failure.
    const results = await Promise.allSettled([writer, reader]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    assert.equal((await history(pool)).total, 40);
    assert.ok(reads >= 20);
  });
});

test('PostgreSQL: deleting site cascades only baseline/snapshot and preserves immutable historical identity; finite checks enforced', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool, { name: '事件时站点名' });
    await save(pool, site, [group('a', 1)], firstTime);
    await save(pool, site, [group('a', 2, { name: '事件时分组名' })]);
    const before = await history(pool, { siteId: site.id });
    await pool.query("update upstream_sites set name='后来的名称',type='new-api' where id=$1", [site.id]);
    await pool.query('delete from upstream_sites where id=$1', [site.id]);
    assert.equal(await baseline(pool, site), undefined);
    assert.equal((await pool.query('select count(*)::int as n from sub2api_snapshots')).rows[0].n, 0);
    assert.deepEqual(await history(pool, { siteId: site.id, snapshot: before.snapshot }), before);
    assert.equal(before.items[0].siteName, '事件时站点名');
    assert.equal(before.items[0].groupName, '事件时分组名');
    assert.equal(before.items[0].siteType, 'sub2api');
    for (const value of [-1, 'NaN', 'Infinity', '-Infinity']) {
      await assert.rejects(pool.query('update group_rate_changes set raw_new_multiplier=$1', [value]), /check constraint/);
    }
    assert.deepEqual(await history(pool, { siteId: site.id, snapshot: before.snapshot }), before);
  });
});

test('PostgreSQL: committed watermark excludes a pre-asOf observation saved between OFFSET pages', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool);
    await save(pool, site, [{ id: 'a', multiplier: 1 }], firstTime);
    await save(pool, site, [{ id: 'a', multiplier: 2 }], '2026-10-01T00:01:00Z');
    await save(pool, site, [{ id: 'a', multiplier: 3 }], '2026-10-01T00:02:00Z');
    const late = await pool.connect();
    const history = createGroupRateChangeRepository(pool);
    try {
      await late.query('begin');
      await late.query('select id from upstream_sites where id = $1 for update', [site.id]);
      // 上游已采集且事务已开始，但事件尚未分配提交序号。
      const fetchedAt = '2026-10-01T00:03:00Z';
      const first = await history.listChanges({ pageSize: 1, asOf });
      assert.equal(first.total, 2);
      assert.equal(first.items[0].rawNewMultiplier, 3);
      assert.match(first.snapshot, /^\d+$/);
      await recordGroupRateSnapshot(late, { site, snapshot: snapshot([{ id: 'a', multiplier: 4 }]), fetchedAt });
      await late.query('commit');
      const second = await history.listChanges({ pageSize: 1, page: 2, asOf: first.asOf, snapshot: first.snapshot });
      assert.equal(second.total, 2);
      assert.equal(second.pages, 2);
      assert.equal(second.items[0].rawNewMultiplier, 2);
      assert.notEqual(first.items[0].id, second.items[0].id);
      const refreshed = await history.listChanges({ asOf });
      assert.equal(refreshed.total, 3);
      assert.deepEqual(refreshed.items.map((event) => event.rawNewMultiplier), [4, 3, 2]);
    } finally {
      await late.query('rollback').catch(() => {});
      late.release();
    }
  });
});

test('PostgreSQL: first-page watermark waits for an already inserted but uncommitted event', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool);
    await save(pool, site, [group('a', 1)], firstTime);
    const writer = await pool.connect();
    try {
      await writer.query('begin');
      await writer.query('select id from upstream_sites where id=$1 for update', [site.id]);
      await recordGroupRateSnapshot(writer, { site, snapshot: snapshot([group('a', 2)]), fetchedAt: secondTime });
      let resolved = false;
      const read = createGroupRateChangeRepository(pool).listChanges({ asOf }).then((result) => { resolved = true; return result; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(resolved, false);
      await writer.query('commit');
      const page = await read;
      assert.equal(page.total, 1);
      assert.equal(page.items[0].rawNewMultiplier, 2);
    } finally {
      await writer.query('rollback').catch(() => {});
      writer.release();
    }
  });
});

test('PostgreSQL: confirmed empty membership resets history comparison, unknown empty retains it', pgOptions, async () => {
  await withSchema(async (pool) => {
    const { normalizeSub2ApiSnapshot } = await import('../src/upstreams/sub2api.mjs');
    const site = await addSite(pool);
    const repository = createSnapshotRepository(pool);
    const history = createGroupRateChangeRepository(pool);
    let step = 0;
    const observe = async (groups) => {
      const fetchedAt = new Date(Date.parse(firstTime) + (++step) * 1000);
      const normalizedSnapshot = normalizeSub2ApiSnapshot({ site, groups, keys: [], checkedAt: fetchedAt });
      await repository.saveSnapshot({ site, rawPayload: {}, normalizedSnapshot, fetchedAt });
    };
    const groups = (rate) => [{ id: 1, name: 'g', rate_multiplier: rate }];
    await observe(groups(1));
    await observe([]);
    assert.deepEqual((await pool.query('select groups from group_rate_baselines')).rows[0].groups, []);
    await observe(groups(2));
    assert.equal((await history.listChanges({ asOf })).total, 0);
    await observe(groups(3));
    assert.equal((await history.listChanges({ asOf })).total, 1);
    await observe({ unexpected: true });
    await observe(groups(4));
    const page = await history.listChanges({ asOf });
    assert.equal(page.total, 2);
    assert.equal(page.items[0].rawOldMultiplier, 3);
    assert.equal(page.items[0].rawNewMultiplier, 4);
  });
});


test('PostgreSQL: additive metadata migration preserves legacy events, baseline and sequence on re-entry', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool);
    await save(pool, site, [group('a', 1)], firstTime);
    await pool.query('alter table group_rate_changes drop column platform, drop column site_url');
    await insertEvent(pool, { site, groupName: 'Claude 历史组' });
    const old = (await pool.query('select * from group_rate_changes')).rows;
    const oldBaseline = await baseline(pool, site);
    await createGroupRateTables(pool);
    await createGroupRateTables(pool);
    const migrated = (await pool.query('select * from group_rate_changes')).rows;
    assert.deepEqual(migrated.map(({ platform, site_url, ...rest }) => rest), old);
    assert.equal(migrated[0].platform, null);
    assert.equal(migrated[0].site_url, null);
    assert.deepEqual(await baseline(pool, site), oldBaseline);
    const events = await history(pool);
    assert.equal(events.snapshot, String(old[0].event_sequence));
    assert.equal(events.items[0].platform, 'anthropic');
    assert.equal(events.items[0].siteUrl, 'https://rate.test');
    assert.deepEqual((await pool.query('select * from group_rate_changes')).rows, migrated);
  });
});

test('PostgreSQL: events store locked-site URL and event platform, unaffected by current config/snapshot or deletion', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool, { url: 'https://original.test' });
    await save(pool, site, [group('a', 1, { ratePlatform: 'openai' })], firstTime);
    await pool.query('update upstream_sites set url=$1 where id=$2', ['https://fixture:private@event.test/keys?token=private', site.id]);
    await save(pool, site, [group('a', 2, { name: 'OpenAI', ratePlatform: 'anthropic' })]);
    const event = (await history(pool)).items[0];
    assert.equal(event.platform, 'anthropic');
    assert.equal(event.siteUrl, 'https://event.test');
    const persisted = (await pool.query('select * from group_rate_changes')).rows[0];
    assert.equal(persisted.platform, 'anthropic');
    assert.equal(persisted.site_url, 'https://event.test');
    await pool.query('update upstream_sites set url=$1 where id=$2', ['https://current.test', site.id]);
    await save(pool, site, [group('a', 2, { name: 'Gemini', ratePlatform: 'gemini' })], '2026-10-01T00:02:00Z');
    assert.equal((await history(pool)).total, 1);
    assert.deepEqual((await history(pool)).items[0], event);
    await pool.query('delete from upstream_sites where id=$1', [site.id]);
    assert.deepEqual((await history(pool)).items[0], event);
    assert.deepEqual((await pool.query('select * from group_rate_changes')).rows[0], persisted);
  });
});

test('PostgreSQL: legacy platform fallback matches site/type/group ID, never name or private payload, handles unsafe/deleted links', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool, { url: 'https://fixture:private@legacy.test/keys?token=private' });
    const other = await addSite(pool);
    const newApi = await addSite(pool, { type: 'new-api' });
    await save(pool, site, [group('a', 1, { name: 'renamed', ratePlatform: 'grok', rawPayload: { token: 'private' } }), group('b', 1, { name: 'same-name', ratePlatform: 'gemini' })], firstTime);
    await save(pool, other, [group('c', 1, { ratePlatform: 'openai' })], firstTime);
    await save(pool, newApi, [group('7', 1, { ratePlatform: 'anthropic' })], firstTime);
    await pool.query('update sub2api_snapshots set raw_payload=$1', [{ platform: 'openai', token: 'private' }]);
    await insertEvent(pool, { site, groupId: 'a', groupName: 'Claude legacy' });
    await insertEvent(pool, { site, groupId: 'c', groupName: 'same-name' });
    await insertEvent(pool, { site, groupId: 'missing', groupName: 'Gemini legacy' });
    await insertEvent(pool, { site: newApi, groupId: '7', groupName: 'default' });
    const before = (await pool.query('select * from group_rate_changes order by id')).rows;
    const oldBaseline = await baseline(pool, site);
    const events = await history(pool);
    const item = (id) => events.items.find((event) => event.siteId === site.id && event.groupId === id);
    assert.equal(item('a').platform, 'grok');
    assert.equal(item('c').platform, 'unknown');
    assert.equal(item('missing').platform, 'gemini');
    assert.equal(events.items.find((event) => event.siteId === newApi.id).platform, 'anthropic');
    assert.equal(item('a').siteUrl, 'https://legacy.test');
    assert.doesNotMatch(JSON.stringify(events), /fixture|private|token|rawPayload|raw_payload/);
    assert.deepEqual((await pool.query('select * from group_rate_changes order by id')).rows, before);
    assert.deepEqual(await baseline(pool, site), oldBaseline);
    await pool.query('update upstream_sites set url=$1 where id=$2', ['javascript:alert(1)', site.id]);
    assert.ok((await history(pool)).items.filter((event) => event.siteId === site.id).every((event) => event.siteUrl === ''));
    await pool.query('update sub2api_snapshots set normalized_snapshot=$1 where site_id=$2', [{ groups: { malformed: true } }, site.id]);
    const malformed = await history(pool);
    assert.equal(malformed.items.find((event) => event.siteId === site.id && event.groupId === 'a').platform, 'anthropic');
    await pool.query('delete from upstream_sites where id=$1', [site.id]);
    const deleted = await history(pool);
    assert.equal(deleted.snapshot, events.snapshot);
    assert.equal(deleted.total, events.total);
    assert.equal(deleted.items.find((event) => event.siteId === site.id && event.groupId === 'a').platform, 'anthropic');
    assert.equal(deleted.items.find((event) => event.siteId === site.id && event.groupId === 'c').platform, 'unknown');
    assert.ok(deleted.items.filter((event) => event.siteId === site.id).every((event) => event.siteUrl === ''));
    assert.deepEqual((await pool.query('select * from group_rate_changes order by id')).rows, before);
  });
});

test('PostgreSQL: recorded unknown platform/empty URL never borrow later known metadata', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool, { url: 'javascript:alert(1)' });
    await save(pool, site, [group('a', 1)], firstTime);
    await save(pool, site, [group('a', 2, { name: 'default', ratePlatform: 'unknown' })]);
    const event = (await history(pool)).items[0];
    assert.equal(event.platform, 'unknown');
    assert.equal(event.siteUrl, '');
    await pool.query('update upstream_sites set url=$1 where id=$2', ['https://later.test', site.id]);
    await save(pool, site, [group('a', 2, { name: 'Claude', ratePlatform: 'anthropic' })], '2026-10-01T00:02:00Z');
    assert.deepEqual((await history(pool)).items[0], event);
    await pool.query('delete from upstream_sites where id=$1', [site.id]);
    assert.deepEqual((await history(pool)).items[0], event);
  });
});

test('PostgreSQL: legacy snapshots never promote display-only defaults into history platform facts', pgOptions, async () => {
  await withSchema(async (pool) => {
    const site = await addSite(pool);
    const newApi = await addSite(pool, { type: 'new-api' });
    // These are pre-migration normalized snapshots: provenance was already lost.
    await save(pool, site, [group('default', 1, { name: 'default', platform: 'openai' }), group('claude', 1, { name: 'Claude 专用', platform: 'openai' })], firstTime);
    await save(pool, newApi, [group('account', 1, { name: 'account', platform: 'anthropic' })], firstTime);
    await insertEvent(pool, { site, groupId: 'default', groupName: 'default' });
    await insertEvent(pool, { site, groupId: 'claude', groupName: 'Claude 专用' });
    await insertEvent(pool, { site: newApi, groupId: 'account', groupName: 'account' });
    const before = (await pool.query('select * from group_rate_changes order by id')).rows;
    const read = await history(pool);
    assert.equal(read.items.find((x) => x.groupId === 'default').platform, 'unknown');
    assert.equal(read.items.find((x) => x.groupId === 'claude').platform, 'anthropic');
    assert.equal(read.items.find((x) => x.groupId === 'account').platform, 'unknown');
    assert.deepEqual((await pool.query('select * from group_rate_changes order by id')).rows, before);
    // Once an adapter provides strict evidence, legacy rows may use it, still read-only.
    await save(pool, site, [group('default', 1, { name: 'default', platform: 'openai', ratePlatform: 'grok' })], secondTime);
    assert.equal((await history(pool)).items.find((x) => x.groupId === 'default').platform, 'grok');
    assert.deepEqual((await pool.query('select * from group_rate_changes order by id')).rows, before);
  });
});
