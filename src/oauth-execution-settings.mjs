/** Global execution slots, separate from per-account import concurrency. */
export const DEFAULT_OAUTH_EXECUTION_CONCURRENCY = 5;
export const OAUTH_EXECUTION_LIMITS = Object.freeze({ min: 1, max: 20 });

function invalidSettings() {
  return Object.assign(new Error('入池并发数必须为 1–20 的整数，且只允许 concurrency 字段'), {
    safe: true, code: 'INVALID_OAUTH_SETTINGS', statusCode: 400,
  });
}

/** @param {unknown} input @returns {{concurrency: number}} */
export function validateOAuthExecutionSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'concurrency')
    || !Number.isSafeInteger(input.concurrency)
    || input.concurrency < OAUTH_EXECUTION_LIMITS.min || input.concurrency > OAUTH_EXECUTION_LIMITS.max) {
    throw invalidSettings();
  }
  return { concurrency: input.concurrency };
}

/** A singleton row makes startup idempotent without overwriting an operator's choice. */
export async function createOAuthExecutionSettingsTable(pool) {
  await pool.query(`create table if not exists oauth_onboarding_settings (
    singleton boolean primary key default true check (singleton),
    concurrency integer not null default 5 check (concurrency between 1 and 20),
    updated_at timestamptz not null default now()
  )`);
  await pool.query(`insert into oauth_onboarding_settings(singleton,concurrency) values(true,$1)
    on conflict(singleton) do nothing`, [DEFAULT_OAUTH_EXECUTION_CONCURRENCY]);
}

/** Read the same committed setting inside the caller's admission transaction; never cache per process. */
export async function readOAuthExecutionSettings(client) {
  const row = (await client.query('select concurrency from oauth_onboarding_settings where singleton=true')).rows[0];
  // Missing/corrupt state is not permission to start default-sized work.
  if (!row) throw Object.assign(new Error('入池并发配置不可用，请重新加载配置'), {
    safe: true, code: 'OAUTH_SETTINGS_UNAVAILABLE', statusCode: 503,
  });
  return validateOAuthExecutionSettings({ concurrency: row.concurrency });
}

export function createOAuthExecutionSettingsStore(pool) {
  return {
    getExecutionSettings: () => readOAuthExecutionSettings(pool),
    async saveExecutionSettings(input) {
      const settings = validateOAuthExecutionSettings(input);
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Serialize changes with all admission/claim operations, including other processes.
        await client.query("select pg_advisory_xact_lock(hashtextextended('oauth-onboarding-admission',0))");
        await client.query(`insert into oauth_onboarding_settings(singleton,concurrency) values(true,$1)
          on conflict(singleton) do update set concurrency=excluded.concurrency,updated_at=now()`, [settings.concurrency]);
        await client.query('commit');
        return settings;
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },
  };
}
