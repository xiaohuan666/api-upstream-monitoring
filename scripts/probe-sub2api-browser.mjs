import { chromium } from 'playwright';

const baseUrl = normalizeBaseUrl(process.env.SUB2API_BASE_URL);
const authToken = process.env.SUB2API_AUTH_TOKEN;

if (!baseUrl) throw new Error('SUB2API_BASE_URL is required');
if (!authToken) throw new Error('SUB2API_AUTH_TOKEN is required');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: 'zh-CN',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0',
});

try {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.evaluate((token) => {
    localStorage.setItem('auth_token', token);
  }, stripBearer(authToken));

  const result = await page.evaluate(async ({ token }) => {
    const headers = {
      accept: 'application/json, text/plain, */*',
      authorization: token,
    };
    const readJson = async (path) => {
      const response = await fetch(path, { headers });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 500) };
      }
      return {
        status: response.status,
        ok: response.ok,
        data,
      };
    };

    const [profile, groups, rates, keys, channels] = await Promise.all([
      readJson('/api/v1/user/profile'),
      readJson('/api/v1/groups/available'),
      readJson('/api/v1/groups/rates'),
      readJson('/api/v1/keys?page=1&page_size=100&sort_by=created_at&sort_order=desc&timezone=Asia%2FShanghai'),
      readJson('/api/v1/channels/available'),
    ]);

    return { profile, groups, rates, keys, channels };
  }, { token: authToken });

  process.stdout.write(JSON.stringify(summarize(result), null, 2));
} finally {
  await browser.close();
}

function summarize(result) {
  const profile = unwrapData(result.profile.data);
  const groupsData = unwrapData(result.groups.data);
  const ratesData = unwrapData(result.rates.data);
  const keysData = unwrapData(result.keys.data);
  const groups = Array.isArray(groupsData) ? groupsData : [];
  const rates = ratesData && typeof ratesData === 'object' ? ratesData : {};
  const keys = normalizePaginatedItems(keysData);

  return {
    status: {
      profile: result.profile.status,
      groups: result.groups.status,
      rates: result.rates.status,
      keys: result.keys.status,
      channels: result.channels.status,
    },
    balance: profile?.balance ?? null,
    user: profile
      ? {
          id: profile.id,
          email: profile.email,
          username: profile.username,
          concurrency: profile.concurrency,
        }
      : null,
    groupCount: groups.length,
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      platform: group.platform,
      subscriptionType: group.subscription_type,
      rateMultiplier: rates[group.id] ?? group.rate_multiplier ?? null,
      defaultRateMultiplier: group.rate_multiplier ?? null,
      peakRateEnabled: group.peak_rate_enabled ?? false,
      peakStart: group.peak_start ?? '',
      peakEnd: group.peak_end ?? '',
      peakRateMultiplier: group.peak_rate_multiplier ?? null,
      isExclusive: group.is_exclusive ?? false,
    })),
    keyCount: keys.length,
    keys: keys.map((key) => ({
      id: key.id,
      name: key.name,
      key: key.key,
      groupId: key.group_id,
      quota: key.quota,
      usedQuota: key.used_quota,
      active: key.active,
      createdAt: key.created_at,
    })),
  };
}

function normalizePaginatedItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.records)) return data.records;
  return [];
}

function unwrapData(value) {
  if (value && typeof value === 'object' && 'data' in value && 'code' in value) {
    return value.data;
  }
  return value;
}

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

function stripBearer(value) {
  return String(value).replace(/^Bearer\s+/i, '');
}
