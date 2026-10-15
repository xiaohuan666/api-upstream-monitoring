import { Pool } from 'pg';
import { createGroupRateTables, recordGroupRateSnapshot } from './group-rate-store.mjs';

import {
  AUTO_REFRESH_PREFERENCE_KEY,
  DEFAULT_AUTO_REFRESH_SETTINGS,
  normalizeAutoRefreshSettings,
} from './auto-refresh-settings.mjs';
import { normalizeSiteUrl } from './domain.mjs';
import { normalizeProxyProvider, allocateProxyProviderNames } from './proxy-provider.mjs';
import { normalizeProxyHost, proxyDedupeKey } from './proxy-identity.mjs';
import {
  DEFAULT_GROUP_VIEW_PREFERENCES,
  GROUP_VIEW_PREFERENCE_KEY,
  normalizeGroupFilterPreset,
  normalizeGroupViewPreferences,
} from './group-view-preferences.mjs';

import { RATE_HISTORY_PREFERENCE_KEY, normalizeRateHistoryPreferences } from './rate-history-preferences.mjs';

export const SITE_TYPES = ['sub2api', 'new-api', 'other'];
export const SYNC_VARIANTS = ['standard', 'credential-flow'];
export const PROXY_PROTOCOLS = ['http', 'https', 'socks5', 'socks5h'];
export const PROXY_STATUSES = ['active', 'inactive'];

const SITE_COLUMNS = `
  id,
  name,
  url,
  base_url,
  type,
  username,
  password,
  new_api_user_id,
  sync_variant,
  auth_token,
  refresh_token,
  auth_token_rotated_at,
  refresh_token_rotated_at,
  usd_to_cny_rate,
  balance_alert,
  depletion_alert_hours,
  watched,
  proxy_id,
  created_at,
  updated_at
`;

const SITE_SELECT_COLUMNS = `
  s.id,
  s.name,
  s.url,
  s.base_url,
  s.type,
  s.username,
  s.password,
  s.new_api_user_id,
  s.sync_variant,
  s.auth_token,
  s.refresh_token,
  s.auth_token_rotated_at,
  s.refresh_token_rotated_at,
  s.usd_to_cny_rate,
  s.balance_alert,
  s.depletion_alert_hours,
  s.watched,
  s.proxy_id,
  s.created_at,
  s.updated_at,
  p.name as proxy_name,
  p.provider as proxy_provider,
  p.protocol as proxy_protocol,
  p.host as proxy_host,
  p.port as proxy_port,
  p.username as proxy_username,
  p.password as proxy_password,
  p.status as proxy_status
`;

export function createPoolFromEnv(env = process.env) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  return new Pool({ connectionString: env.DATABASE_URL });
}

export async function initializeDatabase(pool) {
  await pool.query('create extension if not exists pgcrypto');
  await pool.query(`
    create or replace function set_updated_at()
    returns trigger as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$ language plpgsql
  `);
  await createProxyTable(pool);
  await pool.query(`
    create table if not exists upstream_sites (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      url text not null,
      base_url text not null default '',
      type text not null check (type in ('sub2api', 'new-api', 'other')),
      username text not null default '',
      password text not null default '',
      new_api_user_id text not null default '',
      sync_variant text not null default 'standard',
      auth_token text not null default '',
      refresh_token text not null default '',
      auth_token_rotated_at timestamptz not null default now(),
      refresh_token_rotated_at timestamptz not null default now(),
      usd_to_cny_rate numeric not null default 1
        constraint upstream_sites_usd_to_cny_rate_positive check (usd_to_cny_rate > 0),
      balance_alert numeric not null default 0
        constraint upstream_sites_balance_alert_nonnegative check (balance_alert >= 0),
      depletion_alert_hours numeric not null default 1
        constraint upstream_sites_depletion_alert_hours_nonnegative check (depletion_alert_hours >= 0),
      proxy_id uuid references proxies(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query("alter table upstream_sites add column if not exists auth_token text not null default ''");
  await pool.query("alter table upstream_sites add column if not exists new_api_user_id text not null default ''");
  await pool.query("alter table upstream_sites add column if not exists sync_variant text not null default 'standard'");
  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint
        where conname = 'upstream_sites_sync_variant_check'
          and conrelid = 'upstream_sites'::regclass
      ) then
        alter table upstream_sites
        add constraint upstream_sites_sync_variant_check check (sync_variant in ('standard', 'credential-flow'));
      end if;
    end
    $$
  `);
  await pool.query("update upstream_sites set new_api_user_id = username where type = 'new-api' and new_api_user_id = '' and username ~ '^\\d+$'");
  await pool.query("alter table upstream_sites add column if not exists refresh_token text not null default ''");
  await pool.query('alter table upstream_sites add column if not exists auth_token_rotated_at timestamptz not null default now()');
  await pool.query('alter table upstream_sites add column if not exists refresh_token_rotated_at timestamptz not null default now()');
  await pool.query('alter table upstream_sites add column if not exists usd_to_cny_rate numeric not null default 1');
  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint
        where conname = 'upstream_sites_usd_to_cny_rate_positive'
          and conrelid = 'upstream_sites'::regclass
      ) then
        alter table upstream_sites
        add constraint upstream_sites_usd_to_cny_rate_positive check (usd_to_cny_rate > 0);
      end if;
    end
    $$
  `);
  await pool.query("alter table upstream_sites add column if not exists proxy_id uuid references proxies(id) on delete set null");
  await pool.query("alter table upstream_sites add column if not exists base_url text not null default ''");
  await pool.query("update upstream_sites set base_url = url where base_url = ''");
  await pool.query('alter table upstream_sites add column if not exists balance_alert numeric not null default 0');
  await pool.query('alter table upstream_sites add column if not exists depletion_alert_hours numeric not null default 1');
  await pool.query('alter table upstream_sites add column if not exists watched boolean not null default false');
  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint
        where conname = 'upstream_sites_balance_alert_nonnegative'
          and conrelid = 'upstream_sites'::regclass
      ) then
        alter table upstream_sites
        add constraint upstream_sites_balance_alert_nonnegative check (balance_alert >= 0);
      end if;
    end
    $$
  `);
  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint
        where conname = 'upstream_sites_depletion_alert_hours_nonnegative'
          and conrelid = 'upstream_sites'::regclass
      ) then
        alter table upstream_sites
        add constraint upstream_sites_depletion_alert_hours_nonnegative check (depletion_alert_hours >= 0);
      end if;
    end
    $$
  `);
  await pool.query('drop trigger if exists upstream_sites_set_updated_at on upstream_sites');
  await pool.query(`
    create trigger upstream_sites_set_updated_at
    before update on upstream_sites
    for each row
    execute function set_updated_at()
  `);
  await createSnapshotTable(pool, 'sub2api_snapshots');
  await createSnapshotTable(pool, 'new_api_snapshots');
  await enforceSingleSnapshotPerSite(pool, 'sub2api_snapshots');
  await enforceSingleSnapshotPerSite(pool, 'new_api_snapshots');
  await createGroupRateTables(pool);
  await createGroupModelSettingsTable(pool);
  await pool.query("alter table group_model_settings add column if not exists test_model text not null default ''");
  await pool.query('alter table group_model_settings add column if not exists score numeric not null default 0');
  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint
        where conname = 'group_model_settings_score_range'
          and conrelid = 'group_model_settings'::regclass
      ) then
        alter table group_model_settings
        add constraint group_model_settings_score_range check (score >= 0 and score <= 100);
      end if;
    end
    $$
  `);
  await createUiPreferencesTable(pool);
  await createGroupFilterPresetsTable(pool);
  await migrateGroupFilterPresetsFromUiPreferences(pool);
}

export function createSiteRepository(pool) {
  return {
    async listSites() {
      const result = await pool.query(`
        select ${SITE_SELECT_COLUMNS}
        from upstream_sites s
        left join proxies p on p.id = s.proxy_id
        order by s.created_at desc
      `);
      return result.rows.map(normalizeSiteRecord);
    },

    async getSiteById(id) {
      const result = await pool.query(
        `
          select ${SITE_SELECT_COLUMNS}
          from upstream_sites s
          left join proxies p on p.id = s.proxy_id
          where s.id = $1
        `,
        [id],
      );
      return result.rows[0] ? normalizeSiteRecord(result.rows[0]) : null;
    },

    async createSite(input) {
      const site = validateSiteInput(input);
      const result = await pool.query(
        `
          insert into upstream_sites (name, url, base_url, type, username, password, new_api_user_id, sync_variant, auth_token, refresh_token, usd_to_cny_rate, balance_alert, depletion_alert_hours, proxy_id)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          returning ${SITE_COLUMNS}
        `,
        [
          site.name,
          site.url,
          site.baseUrl,
          site.type,
          site.username,
          site.password,
          site.newApiUserId,
          site.syncVariant,
          site.authToken,
          site.refreshToken,
          site.usdToCnyRate,
          site.balanceAlert,
          site.depletionAlertHours,
          site.proxyId,
        ],
      );
      return normalizeSiteRecord(result.rows[0]);
    },

    async updateSite(id, input) {
      const site = validateSiteInput(input);
      const result = await pool.query(
        `
          update upstream_sites
          set name = $1,
              url = $2,
              base_url = $13,
              type = $3,
              username = $4,
              password = $5,
              new_api_user_id = $6,
              sync_variant = $7,
              auth_token = $8,
              refresh_token = $9,
              auth_token_rotated_at = case when auth_token is distinct from $8 then now() else auth_token_rotated_at end,
              refresh_token_rotated_at = case when refresh_token is distinct from $9 then now() else refresh_token_rotated_at end,
              usd_to_cny_rate = $10,
              balance_alert = $11,
              depletion_alert_hours = $15,
              proxy_id = $12
          where id = $14
          returning ${SITE_COLUMNS}
        `,
        [
          site.name,
          site.url,
          site.type,
          site.username,
          site.password,
          site.newApiUserId,
          site.syncVariant,
          site.authToken,
          site.refreshToken,
          site.usdToCnyRate,
          site.balanceAlert,
          site.proxyId,
          site.baseUrl,
          id,
          site.depletionAlertHours,
        ],
      );
      return result.rows[0] ? normalizeSiteRecord(result.rows[0]) : null;
    },

    async updateSiteAuthTokens(id, { authToken, refreshToken, rotatedAt }) {
      const normalizedAuthToken = String(authToken ?? '').trim();
      const normalizedRefreshToken = String(refreshToken ?? '').trim();
      const normalizedRotatedAt = toIso(rotatedAt ?? new Date());
      if (!normalizedAuthToken) throw new Error('Auth token is required');
      const result = await pool.query(
        `
          update upstream_sites
          set auth_token = $1,
              refresh_token = $2,
              auth_token_rotated_at = $3::timestamptz,
              refresh_token_rotated_at = $3::timestamptz
          where id = $4
          returning ${SITE_COLUMNS}
        `,
        [normalizedAuthToken, normalizedRefreshToken, normalizedRotatedAt, id],
      );
      return result.rows[0] ? normalizeSiteRecord(result.rows[0]) : null;
    },

    async setSiteWatched(id, watched) {
      const result = await pool.query(
        `
          update upstream_sites
          set watched = $2
          where id = $1
          returning ${SITE_COLUMNS}
        `,
        [id, Boolean(watched)],
      );
      return result.rows[0] ? normalizeSiteRecord(result.rows[0]) : null;
    },

    async deleteSite(id) {
      const result = await pool.query(
        `
          delete from upstream_sites
          where id = $1
        `,
        [id],
      );
      return result.rowCount > 0;
    },
  };
}

export function createProxyRepository(pool) {
  return {
    async getProxyById(id) {
      const result = await pool.query(
        `
          select
            p.*,
            count(s.id)::int as site_count
          from proxies p
          left join upstream_sites s on s.proxy_id = p.id
          where p.id = $1
          group by p.id
        `,
        [id],
      );
      return result.rows[0] ? normalizeProxyRecord(result.rows[0]) : null;
    },

    async listProxies() {
      const result = await pool.query(`
        select
          p.*,
          count(s.id)::int as site_count
        from proxies p
        left join upstream_sites s on s.proxy_id = p.id
        group by p.id
        order by p.created_at desc
      `);
      return result.rows.map(normalizeProxyRecord);
    },

    async createProxy(input) {
      const proxy = validateProxyInput(input);
      const result = await insertProxy(pool, proxy);
      return normalizeProxyRecord(result.rows[0]);
    },

    async updateProxy(id, input) {
      const proxy = validateProxyInput(input);
      const result = await pool.query(
        `
          update proxies
          set name = $1,
              provider = coalesce($2, provider),
              protocol = $3,
              host = $4,
              port = $5,
              username = $6,
              password = $7,
              status = $8,
              expires_at = $10,
              probe_result = case when (protocol, host, port, username, password)
                is distinct from ($3, $4, $5::integer, $6, $7) then null else probe_result end
          where id = $9
          returning *, (
            select count(*)::int
            from upstream_sites
            where proxy_id = proxies.id
          ) as site_count
        `,
        [proxy.name, input?.provider === undefined ? null : proxy.provider, proxy.protocol, proxy.host, proxy.port, proxy.username, proxy.password, proxy.status, id, proxy.expiresAt],
      );
      return result.rows[0] ? normalizeProxyRecord(result.rows[0]) : null;
    },

    // Compare the tested connection so an in-flight result cannot overwrite an edited proxy.
    async saveProxyProbe(proxy, result) {
      const saved = await pool.query(`
        update proxies set probe_result = $2::jsonb
        where id = $1 and protocol = $3 and host = $4 and port = $5
          and username = $6 and password = $7
        returning id
      `, [proxy.id, JSON.stringify(result), proxy.protocol, proxy.host, proxy.port, proxy.username, proxy.password]);
      return saved.rowCount > 0;
    },

    async deleteProxy(id) {
      const result = await pool.query(
        `
          delete from proxies
          where id = $1
        `,
        [id],
      );
      return result.rowCount > 0;
    },

    async deleteProxiesBatch(ids) {
      const result = await pool.query('delete from proxies where id = any($1::uuid[]) returning id', [ids]);
      return result.rows.map((row) => row.id);
    },

    // 批量导入：去重、补号和插入必须在同一事务里，避免并发批次抢到同一编号。
    async createProxiesBatch(inputs) {
      const validated = inputs.map((input) => validateProxyInput({
        ...input,
        name: normalizeProxyProvider(input?.provider) || String(input?.name ?? '').trim() || 'default',
      }));
      const client = await pool.connect();
      try {
        await client.query('begin');
        // 同时排他于单条编辑/创建；普通读取不被阻塞，事务内不执行网络请求。
        await client.query('lock table proxies in share row exclusive mode');
        const existing = await client.query('select name, provider, host, port, username, password from proxies');
        const seen = new Set(existing.rows.map(proxyDedupeKey));
        const pending = [];
        let skipped = 0;
        for (const proxy of validated) {
          const key = proxyDedupeKey(proxy);
          if (seen.has(key)) {
            skipped += 1;
            continue;
          }
          seen.add(key);
          pending.push(proxy);
        }
        const providerRows = new Map();
        existing.rows.push(...pending.filter((proxy) => !proxy.provider));
        for (const proxy of pending) {
          if (!proxy.provider) continue;
          if (!providerRows.has(proxy.provider)) providerRows.set(proxy.provider, []);
          providerRows.get(proxy.provider).push(proxy);
        }
        for (const [provider, rows] of providerRows) {
          const names = allocateProxyProviderNames(provider, existing.rows, rows.length);
          rows.forEach((proxy, index) => { proxy.name = names[index]; });
          existing.rows.push(...rows.map((proxy) => ({ name: proxy.name, provider: proxy.provider })));
        }
        const created = [];
        for (const proxy of pending) {
          const result = await insertProxy(client, proxy);
          created.push(normalizeProxyRecord(result.rows[0]));
        }
        await client.query('commit');
        return { created, skipped };
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export function createSnapshotRepository(pool) {
  return {
    async saveSnapshot({ site, rawPayload, normalizedSnapshot, fetchedAt = new Date() }) {
      const tableName = snapshotTableName(site.type);
      const client = await pool.connect();
      try {
        await client.query('begin');
        // 跨进程锁住站点，首次基线与后续历史必须和快照一起提交。
        const lockedSite = await client.query(
          'select id, name, url, type, usd_to_cny_rate from upstream_sites where id = $1 for update',
          [site.id],
        );
        const currentSite = lockedSite.rows[0];
        if (!currentSite) throw new Error('Snapshot site no longer exists');
        if (currentSite.type !== site.type) throw new Error('Snapshot site type changed; retry synchronization');
        const enrichedSnapshot = await withPreviousBalance(client, tableName, site, normalizedSnapshot);
        const result = await client.query(
          `
            insert into ${tableName} (site_id, raw_payload, normalized_snapshot, fetched_at)
            values ($1, $2, $3, $4)
            on conflict (site_id) do update
            set raw_payload = excluded.raw_payload,
                normalized_snapshot = excluded.normalized_snapshot,
                fetched_at = excluded.fetched_at
            where ${tableName}.fetched_at <= excluded.fetched_at
            returning id
          `,
          [site.id, rawPayload, enrichedSnapshot, normalizeDateInput(fetchedAt)],
        );
        const snapshotId = result.rows[0]?.id;
        if (!snapshotId) throw new Error('Stale snapshot discarded or snapshot upsert did not return an id');
        await recordGroupRateSnapshot(client, {
          site: { ...site, name: currentSite.name, url: currentSite.url, usdToCnyRate: Number(currentSite.usd_to_cny_rate) },
          snapshot: normalizedSnapshot,
          fetchedAt,
        });
        await client.query('commit');
        return snapshotId;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async getLatestSnapshot(site) {
      const tableName = snapshotTableName(site.type);
      const result = await pool.query(
        `
          select normalized_snapshot, fetched_at
          from ${tableName}
          where site_id = $1
          order by fetched_at desc
          limit 1
        `,
        [site.id],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        ...row.normalized_snapshot,
        refreshedAt: toIso(row.fetched_at),
      };
    },
  };
}

// "预计归0"的历史锚点：新快照成功时，把上一份成功快照的余额与探测时间写进新快照；
// 失败快照不更新锚点，只透传旧锚点，避免错误快照污染余额差值
async function withPreviousBalance(pool, tableName, site, normalizedSnapshot) {
  if (!normalizedSnapshot || typeof normalizedSnapshot !== 'object') return normalizedSnapshot;
  const existing = await pool.query(
    `select normalized_snapshot, fetched_at from ${tableName} where site_id = $1`,
    [site.id],
  );
  const previousRow = existing.rows[0];
  if (!previousRow) return normalizedSnapshot;
  const previous = previousRow.normalized_snapshot ?? {};
  const carried = previous.previousBalance;
  if (normalizedSnapshot.error) {
    return carried ? { ...normalizedSnapshot, previousBalance: carried } : normalizedSnapshot;
  }
  if (previous.error) return normalizedSnapshot;
  const amount = Number(previous.balanceAmount ?? previous.balanceCny ?? NaN);
  if (!Number.isFinite(amount)) return normalizedSnapshot;
  return {
    ...normalizedSnapshot,
    previousBalance: {
      amount,
      currency: String(previous.balanceCurrency ?? ''),
      refreshedAt: toIso(previousRow.fetched_at),
    },
  };
}

export function createGroupModelSettingsRepository(pool) {
  return {
    async listBySiteIds(siteIds) {
      const ids = [...new Set((siteIds ?? []).map(String).filter(Boolean))];
      if (ids.length === 0) return [];
      const result = await pool.query(
        `
          select *
          from group_model_settings
          where site_id = any($1)
          order by updated_at desc
        `,
        [ids],
      );
      return result.rows.map(normalizeGroupModelSettingRecord);
    },

    async getBySiteIdAndGroupId(siteId, groupId) {
      const normalizedSiteId = String(siteId ?? '').trim();
      const normalizedGroupId = String(groupId ?? '').trim();
      if (!normalizedSiteId) throw new Error('Site id is required');
      if (!normalizedGroupId) throw new Error('Group id is required');
      const result = await pool.query(
        `
          select *
          from group_model_settings
          where site_id = $1
            and group_id = $2
          limit 1
        `,
        [normalizedSiteId, normalizedGroupId],
      );
      return result.rows[0] ? normalizeGroupModelSettingRecord(result.rows[0]) : null;
    },

    async upsertSetting({ siteId, groupId, selectedModel, testModel = '', modelOptions = [] }) {
      const normalizedSiteId = String(siteId ?? '').trim();
      const normalizedGroupId = String(groupId ?? '').trim();
      const normalizedModel = String(selectedModel ?? '').trim();
      const normalizedTestModel = String(testModel ?? '').trim();
      const normalizedOptions = normalizeModelOptions(modelOptions, normalizedModel, normalizedTestModel);
      if (!normalizedSiteId) throw new Error('Site id is required');
      if (!normalizedGroupId) throw new Error('Group id is required');

      const result = await pool.query(
        `
          insert into group_model_settings (site_id, group_id, selected_model, test_model, model_options)
          values ($1, $2, $3, $4, $5::jsonb)
          on conflict (site_id, group_id)
          do update set
            selected_model = excluded.selected_model,
            test_model = excluded.test_model,
            model_options = excluded.model_options,
            updated_at = now()
          returning *
        `,
        [normalizedSiteId, normalizedGroupId, normalizedModel, normalizedTestModel, JSON.stringify(normalizedOptions)],
      );
      return normalizeGroupModelSettingRecord(result.rows[0]);
    },

    async updateLastTest(siteId, groupId, result) {
      const normalizedSiteId = String(siteId ?? '').trim();
      const normalizedGroupId = String(groupId ?? '').trim();
      if (!normalizedSiteId) throw new Error('Site id is required');
      if (!normalizedGroupId) throw new Error('Group id is required');
      const testedAt = normalizeDateInput(result.testedAt ?? new Date());

      const queryResult = await pool.query(
        `
          insert into group_model_settings (
            site_id,
            group_id,
            last_test_latency_ms,
            last_test_status,
            last_test_message,
            last_test_model,
            last_test_at
          )
          values ($1, $2, $3, $4, $5, $6, $7)
          on conflict (site_id, group_id)
          do update set
            last_test_latency_ms = excluded.last_test_latency_ms,
            last_test_status = excluded.last_test_status,
            last_test_message = excluded.last_test_message,
            last_test_model = excluded.last_test_model,
            last_test_at = excluded.last_test_at,
            updated_at = now()
          returning *
        `,
        [
          normalizedSiteId,
          normalizedGroupId,
          result.responseTimeMs ?? null,
          result.status ?? '',
          result.message ?? '',
          result.modelUsed ?? '',
          testedAt,
        ],
      );
      return normalizeGroupModelSettingRecord(queryResult.rows[0]);
    },

    async updateScore(siteId, groupId, score) {
      const normalizedSiteId = String(siteId ?? '').trim();
      const normalizedGroupId = String(groupId ?? '').trim();
      const normalizedScore = Number(score);
      if (!normalizedSiteId) throw new Error('Site id is required');
      if (!normalizedGroupId) throw new Error('Group id is required');
      if (!Number.isFinite(normalizedScore) || normalizedScore < 0 || normalizedScore > 100) {
        throw new Error('Score must be a number between 0 and 100');
      }

      const result = await pool.query(
        `
          insert into group_model_settings (site_id, group_id, score)
          values ($1, $2, $3)
          on conflict (site_id, group_id)
          do update set
            score = excluded.score,
            updated_at = now()
          returning *
        `,
        [normalizedSiteId, normalizedGroupId, normalizedScore],
      );
      return normalizeGroupModelSettingRecord(result.rows[0]);
    },
  };
}

export function createUiPreferencesRepository(pool) {
  return {
    async getPreference(preferenceKey) {
      const key = normalizePreferenceKey(preferenceKey);
      const result = await pool.query(
        `
          select *
          from ui_preferences
          where preference_key = $1
          limit 1
        `,
        [key],
      );
      if (!result.rows[0]) {
        return {
          preferenceKey: key,
          preferences: key === RATE_HISTORY_PREFERENCE_KEY
            ? normalizeRateHistoryPreferences() : { ...DEFAULT_GROUP_VIEW_PREFERENCES },
          updatedAt: null,
        };
      }
      return normalizeUiPreferenceRecord(result.rows[0]);
    },

    async upsertPreference(preferenceKey, preferences) {
      const key = normalizePreferenceKey(preferenceKey);
      const normalizedPreferences = key === RATE_HISTORY_PREFERENCE_KEY
        ? normalizeRateHistoryPreferences(preferences) : normalizeGroupViewPreferences(preferences);
      const result = await pool.query(
        `
          insert into ui_preferences (preference_key, preferences)
          values ($1, $2::jsonb)
          on conflict (preference_key)
          do update set
            preferences = excluded.preferences,
            updated_at = now()
          returning *
        `,
        [key, JSON.stringify(normalizedPreferences)],
      );
      return normalizeUiPreferenceRecord(result.rows[0]);
    },

    async listGroupFilterPresets() {
      const result = await pool.query(
        'select name, filters, updated_at from group_filter_presets order by name',
      );
      return result.rows.map((row) => normalizeGroupFilterPresetRecord(row));
    },

    async upsertGroupFilterPreset(input) {
      const preset = normalizeGroupFilterPreset(input);
      if (!preset.name) throw new Error('Preset name is required');
      const originalName = String(input?.originalName ?? input?.original_name ?? '').trim();
      const client = await pool.connect();
      try {
        await client.query('begin');
        if (originalName && originalName !== preset.name) {
          await client.query('delete from group_filter_presets where name = $1', [originalName]);
        }
        const result = await client.query(
          `
            insert into group_filter_presets (name, filters)
            values ($1, $2::jsonb)
            on conflict (name)
            do update set
              filters = excluded.filters,
              updated_at = now()
            returning name, filters, updated_at
          `,
          [preset.name, JSON.stringify(preset)],
        );
        await client.query('commit');
        return normalizeGroupFilterPresetRecord(result.rows[0]);
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteGroupFilterPreset(name) {
      const key = String(name ?? '').trim();
      if (!key) return false;
      const result = await pool.query('delete from group_filter_presets where name = $1', [key]);
      return result.rowCount > 0;
    },

    async getAutoRefreshSettings() {
      const result = await pool.query(
        `
          select *
          from ui_preferences
          where preference_key = $1
          limit 1
        `,
        [AUTO_REFRESH_PREFERENCE_KEY],
      );
      if (!result.rows[0]) {
        return {
          preferenceKey: AUTO_REFRESH_PREFERENCE_KEY,
          preferences: { ...DEFAULT_AUTO_REFRESH_SETTINGS },
          updatedAt: null,
        };
      }
      return normalizeAutoRefreshPreferenceRecord(result.rows[0]);
    },

    async upsertAutoRefreshSettings(settings) {
      const normalizedSettings = normalizeAutoRefreshSettings(settings);
      const result = await pool.query(
        `
          insert into ui_preferences (preference_key, preferences)
          values ($1, $2::jsonb)
          on conflict (preference_key)
          do update set
            preferences = excluded.preferences,
            updated_at = now()
          returning *
        `,
        [AUTO_REFRESH_PREFERENCE_KEY, JSON.stringify(normalizedSettings)],
      );
      return normalizeAutoRefreshPreferenceRecord(result.rows[0]);
    },
  };
}

export function validateSiteInput(input) {
  const name = String(input?.name ?? '').trim();
  const url = normalizeSiteUrl(input?.url);
  // base_url 可留空，保存时自动用站点 URL 兜底
  const baseUrl = normalizeSiteUrl(input?.base_url ?? input?.baseUrl) || url;
  const type = String(input?.type ?? 'other');
  const username = String(input?.username ?? '').trim();
  const password = String(input?.password ?? '');
  const newApiUserId = String(input?.new_api_user_id ?? input?.newApiUserId ?? '').trim();
  const syncVariant = String(input?.sync_variant ?? input?.syncVariant ?? 'standard').trim();
  const authToken = String(input?.auth_token ?? input?.authToken ?? '').trim();
  const refreshToken = String(input?.refresh_token ?? input?.refreshToken ?? '').trim();
  const usdToCnyRate = Number(input?.usd_to_cny_rate ?? input?.usdToCnyRate ?? 1);
  const balanceAlert = Number(input?.balance_alert ?? input?.balanceAlert ?? 0);
  const depletionAlertHours = Number(input?.depletion_alert_hours ?? input?.depletionAlertHours ?? 1);
  const proxyId = normalizeNullableId(input?.proxy_id ?? input?.proxyId);

  if (!name) throw new Error('Site name is required');
  if (!url) throw new Error('Site URL is required');
  if (!SITE_TYPES.includes(type)) throw new Error(`Unsupported site type: ${type}`);
  if (!SYNC_VARIANTS.includes(syncVariant)) throw new Error(`Unsupported sync variant: ${syncVariant}`);
  if (type === 'sub2api' && syncVariant === 'credential-flow' && (!username || !password)) {
    throw new Error('Login username and password are required for credential-flow sub2api');
  }
  if (type === 'sub2api' && syncVariant !== 'credential-flow' && !authToken) {
    throw new Error('Bearer Token is required for sub2api');
  }
  if (type === 'new-api' && !newApiUserId) {
    throw new Error('User id is required for new-api');
  }
  if (type === 'new-api' && !authToken) {
    throw new Error('Cookie is required for new-api');
  }
  if (!Number.isFinite(usdToCnyRate) || usdToCnyRate <= 0) {
    throw new Error('USD to CNY rate must be greater than 0');
  }
  if (!Number.isFinite(balanceAlert) || balanceAlert < 0) {
    throw new Error('Balance alert must be a non-negative number');
  }
  if (!Number.isFinite(depletionAlertHours) || depletionAlertHours < 0) {
    throw new Error('Depletion alert hours must be a non-negative number');
  }

  return { name, url, baseUrl, type, username, password, newApiUserId, syncVariant, authToken, refreshToken, usdToCnyRate, balanceAlert, depletionAlertHours, proxyId };
}

export function normalizeSiteRecord(row) {
  const proxyId = row.proxy_id ?? null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    baseUrl: row.base_url ?? '',
    type: row.type,
    username: row.username,
    password: row.password,
    newApiUserId: row.new_api_user_id ?? '',
    syncVariant: row.sync_variant ?? 'standard',
    authToken: row.auth_token ?? '',
    refreshToken: row.refresh_token ?? '',
    authTokenRotatedAt: toIsoOrFallback(row.auth_token_rotated_at, row.updated_at ?? row.created_at),
    refreshTokenRotatedAt: toIsoOrFallback(row.refresh_token_rotated_at, row.updated_at ?? row.created_at),
    usdToCnyRate: Number(row.usd_to_cny_rate ?? 1),
    balanceAlert: Number(row.balance_alert ?? 0),
    depletionAlertHours: Number(row.depletion_alert_hours ?? 1),
    watched: Boolean(row.watched),
    proxyId,
    proxy: row.proxy_name ? normalizeProxyRecord({
      id: proxyId,
      name: row.proxy_name,
      provider: row.proxy_provider ?? '',
      protocol: row.proxy_protocol,
      host: row.proxy_host,
      port: row.proxy_port,
      username: row.proxy_username ?? '',
      password: row.proxy_password ?? '',
      status: row.proxy_status,
      site_count: row.site_count ?? 0,
      created_at: row.proxy_created_at ?? row.created_at,
      updated_at: row.proxy_updated_at ?? row.updated_at,
    }) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function validateProxyInput(input) {
  const name = String(input?.name ?? '').trim();
  const provider = normalizeProxyProvider(input?.provider);
  const protocol = String(input?.protocol ?? 'http').trim().toLowerCase();
  const host = normalizeProxyHost(input?.host);
  const port = Number(input?.port);
  const username = String(input?.username ?? '').trim();
  const password = String(input?.password ?? '');
  const status = String(input?.status ?? 'active').trim().toLowerCase();

  if (!name) throw new Error('Proxy name is required');
  if (!PROXY_PROTOCOLS.includes(protocol)) throw new Error(`Unsupported proxy protocol: ${protocol}`);
  if (!host) throw new Error('Proxy host is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Proxy port must be between 1 and 65535');
  }
  if (!PROXY_STATUSES.includes(status)) throw new Error(`Unsupported proxy status: ${status}`);

  const expiresAt = normalizeProxyExpiresAt(input?.expires_at ?? input?.expiresAt);

  return { name, provider, protocol, host, port, username, password, status, expiresAt };
}

// 接受 ISO 字符串 / datetime-local 值 / Date；空值 = 长期有效（null）
function normalizeProxyExpiresAt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('Proxy expires_at must be a valid date');
  return date.toISOString();
}

export function normalizeProxyRecord(row) {
  const proxy = {
    id: row.id,
    name: row.name,
    provider: row.provider ?? '',
    probeResult: row.probe_result ?? null,
    protocol: row.protocol,
    host: row.host,
    port: Number(row.port),
    username: row.username ?? '',
    password: row.password ?? '',
    status: row.status ?? 'active',
    siteCount: Number(row.site_count ?? 0),
    expiresAt: row.expires_at ? toIso(row.expires_at) : null,
    createdAt: row.created_at ? toIso(row.created_at) : null,
    updatedAt: row.updated_at ? toIso(row.updated_at) : null,
  };
  return {
    ...proxy,
    url: buildProxyUrl(proxy),
  };
}

export function normalizeGroupModelSettingRecord(row) {
  const lastTestAt = row.last_test_at ? toIso(row.last_test_at) : null;
  const lastTest = row.last_test_status || row.last_test_latency_ms !== null
    ? {
      responseTimeMs: row.last_test_latency_ms,
      status: row.last_test_status ?? '',
      message: row.last_test_message ?? '',
      modelUsed: row.last_test_model ?? '',
      testedAt: lastTestAt,
    }
    : null;

  return {
    siteId: row.site_id,
    groupId: row.group_id,
    selectedModel: row.selected_model ?? '',
    testModel: row.test_model ?? '',
    modelOptions: Array.isArray(row.model_options) ? row.model_options : [],
    score: Number(row.score ?? 0),
    lastTest,
    updatedAt: toIso(row.updated_at),
  };
}

export function normalizeUiPreferenceRecord(row) {
  return {
    preferenceKey: row.preference_key,
    preferences: row.preference_key === RATE_HISTORY_PREFERENCE_KEY
      ? normalizeRateHistoryPreferences(row.preferences) : normalizeGroupViewPreferences(row.preferences ?? {}),
    updatedAt: row.updated_at ? toIso(row.updated_at) : null,
  };
}

export function normalizeAutoRefreshPreferenceRecord(row) {
  return {
    preferenceKey: row.preference_key,
    preferences: normalizeAutoRefreshSettings(row.preferences ?? {}),
    updatedAt: row.updated_at ? toIso(row.updated_at) : null,
  };
}

function buildProxyUrl(proxy) {
  const url = new URL(`${proxy.protocol}://placeholder`);
  const host = normalizeProxyHost(proxy.host);
  url.hostname = host.includes(':') ? `[${host}]` : host;
  url.port = String(proxy.port);
  if (proxy.username) url.username = proxy.username;
  if (proxy.password) url.password = proxy.password;
  return url.toString().replace(/\/$/, '');
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function toIsoOrFallback(value, fallback) {
  return toIso(value ?? fallback ?? new Date());
}

async function createProxyTable(pool) {
  await pool.query(`
    create table if not exists proxies (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      provider text not null default '',
      protocol text not null check (protocol in ('http', 'https', 'socks5', 'socks5h')),
      host text not null,
      port integer not null check (port between 1 and 65535),
      username text not null default '',
      password text not null default '',
      status text not null default 'active' check (status in ('active', 'inactive')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query('drop trigger if exists proxies_set_updated_at on proxies');
  await pool.query(`
    create trigger proxies_set_updated_at
    before update on proxies
    for each row
    execute function set_updated_at()
  `);
  // 到期时间：与 sub2api 代理的 expires_at 对齐，可空表示长期有效
  await pool.query("alter table proxies add column if not exists provider text not null default ''");
  await pool.query('alter table proxies add column if not exists expires_at timestamptz');
  await pool.query('alter table proxies add column if not exists probe_result jsonb');
}

async function insertProxy(client, proxy) {
  return await client.query(
    `
      insert into proxies (name, provider, protocol, host, port, username, password, status, expires_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      returning *, 0::int as site_count
    `,
    [proxy.name, proxy.provider, proxy.protocol, proxy.host, proxy.port, proxy.username, proxy.password, proxy.status, proxy.expiresAt],
  );
}

async function createSnapshotTable(pool, tableName) {
  await pool.query(`
    create table if not exists ${tableName} (
      id uuid primary key default gen_random_uuid(),
      site_id uuid not null references upstream_sites(id) on delete cascade,
      raw_payload jsonb not null,
      normalized_snapshot jsonb not null,
      fetched_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create index if not exists ${tableName}_site_fetched_idx
    on ${tableName} (site_id, fetched_at desc)
  `);
}

async function enforceSingleSnapshotPerSite(pool, tableName) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`lock table ${tableName} in share row exclusive mode`);
    await client.query(`
      delete from ${tableName} as duplicate
      using (
        select id,
               row_number() over (partition by site_id order by fetched_at desc, id desc) as row_number
        from ${tableName}
      ) as ranked
      where duplicate.id = ranked.id
        and ranked.row_number > 1
    `);
    await client.query(`
      create unique index if not exists ${tableName}_site_id_unique_idx
      on ${tableName} (site_id)
    `);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function createGroupModelSettingsTable(pool) {
  await pool.query(`
    create table if not exists group_model_settings (
      id uuid primary key default gen_random_uuid(),
      site_id uuid not null references upstream_sites(id) on delete cascade,
      group_id text not null,
      selected_model text not null default '',
      test_model text not null default '',
      model_options jsonb not null default '[]'::jsonb,
      last_test_latency_ms integer,
      last_test_status text,
      last_test_message text not null default '',
      last_test_model text not null default '',
      last_test_at timestamptz,
      score numeric not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (site_id, group_id)
    )
  `);
  await pool.query(`
    create index if not exists group_model_settings_site_idx
    on group_model_settings (site_id, updated_at desc)
  `);
}

async function createUiPreferencesTable(pool) {
  await pool.query(`
    create table if not exists ui_preferences (
      preference_key text primary key,
      preferences jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query('drop trigger if exists ui_preferences_set_updated_at on ui_preferences');
  await pool.query(`
    create trigger ui_preferences_set_updated_at
    before update on ui_preferences
    for each row
    execute function set_updated_at()
  `);
}

async function createGroupFilterPresetsTable(pool) {
  await pool.query(`
    create table if not exists group_filter_presets (
      name text primary key,
      filters jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query('drop trigger if exists group_filter_presets_set_updated_at on group_filter_presets');
  await pool.query(`
    create trigger group_filter_presets_set_updated_at
    before update on group_filter_presets
    for each row
    execute function set_updated_at()
  `);
}

// 一次性迁移：预设原先是打包在 group-management UI 偏好 blob 里的，任何筛选/排序
// 保存都会全量覆写 blob，旧标签页会把新改的预设盖回去。独立建表后 blob 里的
// filterPresets 字段作废，导入成功即从 blob 中剔除，避免重复导入。
async function migrateGroupFilterPresetsFromUiPreferences(pool) {
  const existing = await pool.query('select count(*)::int as count from group_filter_presets');
  if (Number(existing.rows[0]?.count ?? 0) > 0) return;
  const blob = await pool.query(
    'select preferences from ui_preferences where preference_key = $1 limit 1',
    [GROUP_VIEW_PREFERENCE_KEY],
  );
  const legacy = blob.rows[0]?.preferences?.filterPresets;
  if (!Array.isArray(legacy) || legacy.length === 0) return;
  for (const item of legacy) {
    const preset = normalizeGroupFilterPreset(item);
    if (!preset.name) continue;
    await pool.query(
      `
        insert into group_filter_presets (name, filters)
        values ($1, $2::jsonb)
        on conflict (name) do nothing
      `,
      [preset.name, JSON.stringify(preset)],
    );
  }
  await pool.query(
    `update ui_preferences set preferences = preferences - 'filterPresets' where preference_key = $1`,
    [GROUP_VIEW_PREFERENCE_KEY],
  );
}

function normalizeGroupFilterPresetRecord(row) {
  return {
    ...normalizeGroupFilterPreset({ name: row.name, ...row.filters }),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ?? null,
  };
}

function snapshotTableName(type) {
  if (type === 'sub2api') return 'sub2api_snapshots';
  if (type === 'new-api') return 'new_api_snapshots';
  throw new Error(`Unsupported snapshot site type: ${type}`);
}

function normalizeDateInput(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizeModelOptions(options, ...requiredModels) {
  const byId = new Map();
  for (const item of Array.isArray(options) ? options : []) {
    const id = String(item?.id ?? item ?? '').trim();
    if (!id) continue;
    byId.set(id, {
      id,
      ownedBy: item?.ownedBy ? String(item.ownedBy) : '',
    });
  }
  for (const requiredModel of requiredModels) {
    const id = String(requiredModel ?? '').trim();
    if (id && !byId.has(id)) {
      byId.set(id, { id, ownedBy: 'manual' });
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeNullableId(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

function normalizePreferenceKey(value) {
  const key = String(value ?? '').trim();
  if (!key) throw new Error('Preference key is required');
  return key;
}
