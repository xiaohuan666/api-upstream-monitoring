import { normalizeSiteUrl } from './domain.mjs';

export const MY_SITE_TYPES = ['sub2api', 'new-api'];

export async function createMySitesTables(pool) {
  await pool.query(`
    create table if not exists my_sites (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      type text not null default 'sub2api' check (type in ('sub2api', 'new-api')),
      url text not null,
      admin_key text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query('drop trigger if exists my_sites_set_updated_at on my_sites');
  await pool.query(`
    create trigger my_sites_set_updated_at
    before update on my_sites
    for each row
    execute function set_updated_at()
  `);
  await pool.query(`
    create table if not exists my_site_accounts (
      id uuid primary key default gen_random_uuid(),
      my_site_id uuid not null references my_sites(id) on delete cascade,
      my_group_id text not null,
      my_group_name text not null default '',
      my_account_id text not null,
      upstream_site_id uuid not null references upstream_sites(id) on delete cascade,
      upstream_group_id text not null,
      last_synced_rate numeric,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (my_site_id, my_group_id, upstream_site_id, upstream_group_id)
    )
  `);
  await pool.query('drop trigger if exists my_site_accounts_set_updated_at on my_site_accounts');
  await pool.query(`
    create trigger my_site_accounts_set_updated_at
    before update on my_site_accounts
    for each row
    execute function set_updated_at()
  `);
  await pool.query(`
    create index if not exists my_site_accounts_upstream_idx
    on my_site_accounts (upstream_site_id, upstream_group_id)
  `);
  // IP 映射：监控侧代理 ↔ 我站点（sub2api）侧代理记录
  await pool.query(`
    create table if not exists my_site_proxies (
      id uuid primary key default gen_random_uuid(),
      my_site_id uuid not null references my_sites(id) on delete cascade,
      proxy_id uuid not null references proxies(id) on delete cascade,
      my_proxy_id text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (my_site_id, proxy_id)
    )
  `);
  await pool.query('drop trigger if exists my_site_proxies_set_updated_at on my_site_proxies');
  await pool.query(`
    create trigger my_site_proxies_set_updated_at
    before update on my_site_proxies
    for each row
    execute function set_updated_at()
  `);
}

export function validateMySiteInput(input) {
  const name = String(input?.name ?? '').trim();
  const type = String(input?.type ?? 'sub2api').trim();
  // 只保留根 URL：粘贴 https://example.com/admin 这类长链接时存 https://example.com
  const url = normalizeSiteUrl(input?.url);
  const adminKey = String(input?.admin_key ?? input?.adminKey ?? '').trim();

  if (!name) throw new Error('Site name is required');
  if (!MY_SITE_TYPES.includes(type)) throw new Error(`Unsupported my site type: ${type}`);
  if (!url) throw new Error('Site URL is required');
  if (!adminKey) throw new Error('Admin API key is required');

  return { name, type, url, adminKey };
}

export function normalizeMySiteRecord(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type ?? 'sub2api',
    url: row.url ?? '',
    adminKey: row.admin_key ?? '',
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function createMySiteRepository(pool) {
  return {
    async listMySites() {
      const result = await pool.query('select * from my_sites order by created_at asc');
      return result.rows.map(normalizeMySiteRecord);
    },

    async getMySiteById(id) {
      const result = await pool.query('select * from my_sites where id = $1', [id]);
      return result.rows[0] ? normalizeMySiteRecord(result.rows[0]) : null;
    },

    async createMySite(input) {
      const mySite = validateMySiteInput(input);
      const result = await pool.query(
        `
          insert into my_sites (name, type, url, admin_key)
          values ($1, $2, $3, $4)
          returning *
        `,
        [mySite.name, mySite.type, mySite.url, mySite.adminKey],
      );
      return normalizeMySiteRecord(result.rows[0]);
    },

    async updateMySite(id, input) {
      const mySite = validateMySiteInput(input);
      const result = await pool.query(
        `
          update my_sites
          set name = $1, type = $2, url = $3, admin_key = $4
          where id = $5
          returning *
        `,
        [mySite.name, mySite.type, mySite.url, mySite.adminKey, id],
      );
      return result.rows[0] ? normalizeMySiteRecord(result.rows[0]) : null;
    },

    async deleteMySite(id) {
      const result = await pool.query('delete from my_sites where id = $1', [id]);
      return result.rowCount > 0;
    },
  };
}

export class MySiteAccountConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MySiteAccountConflictError';
    this.statusCode = 409;
  }
}

export function normalizeMySiteAccountRecord(row) {
  return {
    id: row.id,
    mySiteId: row.my_site_id,
    myGroupId: String(row.my_group_id ?? ''),
    myGroupName: row.my_group_name ?? '',
    myAccountId: String(row.my_account_id ?? ''),
    upstreamSiteId: row.upstream_site_id,
    upstreamGroupId: String(row.upstream_group_id ?? ''),
    lastSyncedRate: row.last_synced_rate === null || row.last_synced_rate === undefined
      ? null
      : Number(row.last_synced_rate),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function createMySiteAccountRepository(pool) {
  return {
    async getAccountById(id) {
      const result = await pool.query('select * from my_site_accounts where id = $1', [id]);
      return result.rows[0] ? normalizeMySiteAccountRecord(result.rows[0]) : null;
    },

    async listAccounts({ mySiteId = null, upstreamSiteId = null, upstreamGroupId = null } = {}) {
      const conditions = [];
      const values = [];
      if (mySiteId) {
        values.push(mySiteId);
        conditions.push(`my_site_id = $${values.length}`);
      }
      if (upstreamSiteId) {
        values.push(upstreamSiteId);
        conditions.push(`upstream_site_id = $${values.length}`);
      }
      if (upstreamGroupId) {
        values.push(String(upstreamGroupId));
        conditions.push(`upstream_group_id = $${values.length}`);
      }
      const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
      const result = await pool.query(
        `select * from my_site_accounts ${where} order by created_at asc`,
        values,
      );
      return result.rows.map(normalizeMySiteAccountRecord);
    },

    async createAccount(input) {
      const account = validateMySiteAccountInput(input);
      try {
        const result = await pool.query(
          `
            insert into my_site_accounts (
              my_site_id,
              my_group_id,
              my_group_name,
              my_account_id,
              upstream_site_id,
              upstream_group_id,
              last_synced_rate
            )
            values ($1, $2, $3, $4, $5, $6, $7)
            returning *
          `,
          [
            account.mySiteId,
            account.myGroupId,
            account.myGroupName,
            account.myAccountId,
            account.upstreamSiteId,
            account.upstreamGroupId,
            account.lastSyncedRate,
          ],
        );
        return normalizeMySiteAccountRecord(result.rows[0]);
      } catch (error) {
        if (error?.code === '23505') {
          throw new MySiteAccountConflictError('该分组下已创建过账号');
        }
        throw error;
      }
    },

    async markRateSynced(id, rate) {
      const numericRate = Number(rate);
      if (!Number.isFinite(numericRate)) throw new Error('Synced rate must be a finite number');
      const result = await pool.query(
        `
          update my_site_accounts
          set last_synced_rate = $2
          where id = $1
          returning *
        `,
        [id, numericRate],
      );
      return result.rows[0] ? normalizeMySiteAccountRecord(result.rows[0]) : null;
    },

    async deleteAccountById(id) {
      const result = await pool.query('delete from my_site_accounts where id = $1', [id]);
      return result.rowCount > 0;
    },
  };
}

export function normalizeMySiteProxyRecord(row) {
  return {
    id: row.id,
    mySiteId: row.my_site_id,
    proxyId: row.proxy_id,
    myProxyId: String(row.my_proxy_id ?? ''),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function createMySiteProxyRepository(pool) {
  return {
    async listLinks({ mySiteId = null, proxyId = null } = {}, client = pool) {
      const conditions = [];
      const values = [];
      if (mySiteId) {
        values.push(mySiteId);
        conditions.push(`my_site_id = $${values.length}`);
      }
      if (proxyId) {
        values.push(proxyId);
        conditions.push(`proxy_id = $${values.length}`);
      }
      const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
      const result = await client.query(
        `select * from my_site_proxies ${where} order by created_at asc`,
        values,
      );
      return result.rows.map(normalizeMySiteProxyRecord);
    },

    async createLink({ mySiteId, proxyId, myProxyId }, client = pool) {
      try {
        const result = await client.query(
          `
            insert into my_site_proxies (my_site_id, proxy_id, my_proxy_id)
            values ($1, $2, $3)
            returning *
          `,
          [mySiteId, proxyId, String(myProxyId ?? '')],
        );
        return normalizeMySiteProxyRecord(result.rows[0]);
      } catch (error) {
        if (error?.code === '23505') {
          throw new MySiteAccountConflictError('该代理已创建过映射');
        }
        throw error;
      }
    },

    async deleteLinkById(id) {
      const result = await pool.query('delete from my_site_proxies where id = $1', [id]);
      return result.rowCount > 0;
    },
  };
}

function validateMySiteAccountInput(input) {
  const mySiteId = String(input?.my_site_id ?? input?.mySiteId ?? '').trim();
  const myGroupId = String(input?.my_group_id ?? input?.myGroupId ?? '').trim();
  const myGroupName = String(input?.my_group_name ?? input?.myGroupName ?? '').trim();
  const myAccountId = String(input?.my_account_id ?? input?.myAccountId ?? '').trim();
  const upstreamSiteId = String(input?.upstream_site_id ?? input?.upstreamSiteId ?? '').trim();
  const upstreamGroupId = String(input?.upstream_group_id ?? input?.upstreamGroupId ?? '').trim();
  const lastSyncedRate = input?.last_synced_rate ?? input?.lastSyncedRate ?? null;

  if (!mySiteId) throw new Error('My site id is required');
  if (!myGroupId) throw new Error('My group id is required');
  if (!myAccountId) throw new Error('My account id is required');
  if (!upstreamSiteId) throw new Error('Upstream site id is required');
  if (!upstreamGroupId) throw new Error('Upstream group id is required');
  if (lastSyncedRate !== null && !Number.isFinite(Number(lastSyncedRate))) {
    throw new Error('Last synced rate must be a finite number');
  }

  return {
    mySiteId,
    myGroupId,
    myGroupName,
    myAccountId,
    upstreamSiteId,
    upstreamGroupId,
    lastSyncedRate: lastSyncedRate === null ? null : Number(lastSyncedRate),
  };
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
