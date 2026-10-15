import { randomUUID } from 'node:crypto';
import { resolveRateHistoryMetadata } from './group-rate-metadata.mjs';
import { diffGroupRateSnapshot, parseGroupRateChangeQuery } from './group-rate-changes.mjs';

export { parseGroupRateChangeQuery } from './group-rate-changes.mjs';

/** Initialize after upstream_sites exists. History deliberately has no site FK. */
export async function createGroupRateTables(pool) {
  await pool.query(`
    create table if not exists group_rate_baselines (
      site_id uuid primary key references upstream_sites(id) on delete cascade,
      site_type text not null,
      balance_currency text not null,
      fetched_at timestamptz not null,
      groups jsonb not null check (jsonb_typeof(groups) = 'array')
    )
  `);
  await pool.query(`
    create table if not exists group_rate_changes (
      id uuid primary key,
      event_sequence bigserial not null,
      site_id uuid not null,
      site_name text not null,
      site_type text not null,
      group_id text not null,
      group_name text not null,
      platform text,
      site_url text,
      raw_old_multiplier double precision not null check (raw_old_multiplier >= 0 and raw_old_multiplier < 'Infinity'::double precision),
      raw_new_multiplier double precision not null check (raw_new_multiplier >= 0 and raw_new_multiplier < 'Infinity'::double precision),
      old_multiplier double precision not null check (old_multiplier >= 0 and old_multiplier < 'Infinity'::double precision),
      new_multiplier double precision not null check (new_multiplier >= 0 and new_multiplier < 'Infinity'::double precision),
      changed_at timestamptz not null
    )
  `);
  await pool.query('alter table group_rate_changes add column if not exists platform text');
  await pool.query('alter table group_rate_changes add column if not exists site_url text');
  await pool.query('alter table group_rate_changes add column if not exists event_sequence bigserial not null');
  await pool.query('create unique index if not exists group_rate_changes_sequence_idx on group_rate_changes (event_sequence)');
  await pool.query('create index if not exists group_rate_changes_time_idx on group_rate_changes (changed_at desc, id desc)');
  await pool.query('create index if not exists group_rate_changes_site_time_idx on group_rate_changes (site_id, changed_at desc, id desc)');
}

/**
 * Caller MUST already be in a transaction and hold upstream_sites FOR UPDATE for
 * site.id. No begin/commit, independent pool query or swallowed audit errors here.
 * Returns the newly inserted event items (empty for initialization/ignored input).
 */
export async function recordGroupRateSnapshot(client, { site, snapshot, fetchedAt }) {
  const result = await client.query(`
    select site_type, balance_currency, fetched_at, groups
    from group_rate_baselines where site_id = $1
  `, [site.id]);
  const row = result.rows[0];
  const previous = row ? {
    siteType: row.site_type,
    balanceCurrency: row.balance_currency,
    fetchedAt: row.fetched_at,
    groups: row.groups,
  } : null;
  const transition = diffGroupRateSnapshot({ site, snapshot, fetchedAt, baseline: previous });
  if (!transition.baseline) return [];
  const items = transition.changes.map((change) => ({ id: randomUUID(), ...change }));
  if (items.length) {
    // 先串行化事件序号分配与提交；第一页只短暂获取共享锁读取提交水位。
    await client.query("select pg_advisory_xact_lock(740231, 'group_rate_changes'::regclass::oid::integer)");
    // One insert for any number of groups avoids the PostgreSQL parameter limit.
    await client.query(`
      insert into group_rate_changes (
        id, site_id, site_name, site_type, group_id, group_name, platform, site_url,
        raw_old_multiplier, raw_new_multiplier, old_multiplier, new_multiplier, changed_at
      )
      select id, site_id, site_name, site_type, group_id, group_name, platform, site_url,
             raw_old_multiplier, raw_new_multiplier, old_multiplier, new_multiplier, changed_at
      from jsonb_to_recordset($1::jsonb) as events (
        id uuid, site_id uuid, site_name text, site_type text, group_id text, group_name text, platform text, site_url text,
        raw_old_multiplier double precision, raw_new_multiplier double precision,
        old_multiplier double precision, new_multiplier double precision, changed_at timestamptz
      )
    `, [JSON.stringify(items.map((item) => ({
      id: item.id,
      site_id: item.siteId,
      site_name: item.siteName,
      site_type: item.siteType,
      group_id: item.groupId,
      group_name: item.groupName,
      platform: item.platform,
      site_url: item.siteUrl,
      raw_old_multiplier: item.rawOldMultiplier,
      raw_new_multiplier: item.rawNewMultiplier,
      old_multiplier: item.oldMultiplier,
      new_multiplier: item.newMultiplier,
      changed_at: item.changedAt,
    })))]);
  }
  const next = transition.baseline;
  await client.query(`
    insert into group_rate_baselines (site_id, site_type, balance_currency, fetched_at, groups)
    values ($1, $2, $3, $4, $5::jsonb)
    on conflict (site_id) do update set
      site_type = excluded.site_type,
      balance_currency = excluded.balance_currency,
      fetched_at = excluded.fetched_at,
      groups = excluded.groups
  `, [site.id, next.siteType, next.balanceCurrency, next.fetchedAt, JSON.stringify(next.groups)]);
  return items;
}

/** Read-only history. options may be the parsed HTTP query or typed equivalents. */
export function createGroupRateChangeRepository(pool) {
  return {
    async listChanges(options = {}) {
      const query = normalizeListOptions(options);
      const snapshot = query.snapshot ?? await readCommittedSequence(pool);
      const values = [query.asOf, snapshot];
      const predicates = ['changed_at <= $1::timestamptz', 'event_sequence <= $2::bigint'];
      const bind = (value) => { values.push(value); return `$${values.length}`; };
      if (query.windowStart) predicates.push(`changed_at >= ${bind(query.windowStart)}::timestamptz`);
      if (query.siteId) predicates.push(`site_id = ${bind(query.siteId)}::uuid`);
      if (query.direction) predicates.push(query.direction === 'up'
        ? 'raw_new_multiplier > raw_old_multiplier' : 'raw_new_multiplier < raw_old_multiplier');
      if (query.q) {
        // Escape LIKE metacharacters so q is a literal substring, not a wildcard.
        const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
        const placeholder = bind(pattern);
        predicates.push(`(site_name ilike ${placeholder} escape E'\\\\' or group_name ilike ${placeholder} escape E'\\\\')`);
      }
      const limit = bind(query.pageSize);
      const offset = bind((query.page - 1) * query.pageSize);
      // 已提交事件的单调序号固定分页集合，迟到观测只能进入下一轮刷新。
      // 共享锁已释放；历史COUNT/分页扫描不阻塞上游快照提交。
      const result = await pool.query(`
        with filtered as (
          select * from group_rate_changes where ${predicates.join(' and ')}
        ), page_rows as (
          select * from filtered order by changed_at desc, id desc limit ${limit} offset ${offset}
        ), enriched_page as (
          select p.*, s.url as current_site_url, metadata.platform as snapshot_platform
          from page_rows p
          left join upstream_sites s on s.id = p.site_id
          left join lateral (
            select g.value ->> 'ratePlatform' as platform
            from (
              select normalized_snapshot -> 'groups' as groups from sub2api_snapshots
              where site_id = p.site_id and p.site_type = 'sub2api'
              union all
              select normalized_snapshot -> 'groups' as groups from new_api_snapshots
              where site_id = p.site_id and p.site_type = 'new-api'
            ) snapshots
            cross join lateral jsonb_array_elements(
              case when jsonb_typeof(snapshots.groups) = 'array' then snapshots.groups else '[]'::jsonb end
            ) g(value)
            where nullif(btrim(p.platform), '') is null and g.value ->> 'id' = p.group_id
            limit 1
          ) metadata on true
        )
        select (select count(*) from filtered) as total,
          coalesce((select jsonb_agg(to_jsonb(p) order by p.changed_at desc, p.id desc) from enriched_page p), '[]'::jsonb) as items
      `, values);
      const total = Number(result.rows[0].total);
      if (!Number.isSafeInteger(total)) throw new RangeError('Group rate history count exceeds safe integer range');
      return {
        items: result.rows[0].items.map(mapChange),
        total,
        page: query.page,
        pageSize: query.pageSize,
        pages: Math.max(1, Math.ceil(total / query.pageSize)),
        asOf: query.asOf,
        snapshot,
        windowStart: query.windowStart,
      };
    },
  };
}

function normalizeListOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Expected query options');
  const params = new URLSearchParams();
  const allowedKeys = new Set(['window', 'page', 'pageSize', 'siteId', 'direction', 'q', 'asOf', 'windowStart', 'snapshot']);
  for (const [key, value] of Object.entries(options)) {
    if (!allowedKeys.has(key)) throw new RangeError(`Unknown group rate query option: ${key}`);
    // Derived windowStart is not an independent filter; always recompute it from
    // the validated asOf/window so callers cannot accidentally change the window.
    if (key === 'windowStart') continue;
    if (value === null || value === undefined) continue;
    if (key === 'page' || key === 'pageSize') {
      if (typeof value !== 'number' && typeof value !== 'string') throw new TypeError(`Invalid ${key}`);
    } else if (key === 'asOf' && value instanceof Date) {
      params.set(key, value.toISOString());
      continue;
    } else if (typeof value !== 'string') {
      throw new TypeError(`Invalid ${key}`);
    }
    params.set(key, String(value));
  }
  return parseGroupRateChangeQuery(params);
}

function mapChange(row) {
  return {
    id: row.id,
    siteId: row.site_id,
    siteName: row.site_name,
    siteType: row.site_type,
    groupId: row.group_id,
    groupName: row.group_name,
    ...resolveRateHistoryMetadata({
      platform: row.platform, siteUrl: row.site_url, snapshotPlatform: row.snapshot_platform,
      currentSiteUrl: row.current_site_url, groupName: row.group_name,
    }),
    oldMultiplier: Number(row.old_multiplier),
    newMultiplier: Number(row.new_multiplier),
    rawOldMultiplier: Number(row.raw_old_multiplier),
    rawNewMultiplier: Number(row.raw_new_multiplier),
    changedAt: new Date(row.changed_at).toISOString(),
  };
}

// 只锁住索引MAX查询，不持有跨请求事务；序号可随常规逻辑备份/恢复迁移。
async function readCommittedSequence(pool) {
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    await client.query("set local lock_timeout = '5s'");
    await client.query("select pg_advisory_xact_lock_shared(740231, 'group_rate_changes'::regclass::oid::integer)");
    const result = await client.query('select coalesce(max(event_sequence), 0)::text as watermark from group_rate_changes');
    await client.query('commit');
    return result.rows[0].watermark;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
