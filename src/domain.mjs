import { displayBalance } from './currency-display.mjs';

const GROUP_NAMES_BY_TYPE = {
  sub2api: ['default', 'premium', 'claude', 'openai', 'long-context'],
  'new-api': ['default', 'vip', 'gpt-4', 'claude', 'gemini'],
  other: ['default', 'fast', 'stable', 'backup'],
};

export function normalizeSiteUrl(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  // 只保留根 URL：粘贴 https://example.com/keys 这类长链接时存 https://example.com
  try {
    return new URL(withScheme).origin;
  } catch {
    return withScheme.replace(/\/+$/, '');
  }
}

export function classifyProbe({ ok, latencyMs }) {
  if (!ok) return 'down';
  if (Number(latencyMs) > 900) return 'slow';
  return 'healthy';
}

const PLATFORM_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  grok: 'Grok',
  gemini: 'Gemini',
};

export function normalizePlatformDisplay(value) {
  const key = normalizeProviderPlatform(value);
  return { key, label: PLATFORM_LABELS[key] };
}

// 平台归一化口径：anthropic / grok / gemini 各自独立，其余一律归并为 openai
export function normalizeProviderPlatform(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key.includes('anthropic') || key.includes('claude')) return 'anthropic';
  if (key.includes('grok')) return 'grok';
  if (key.includes('gemini')) return 'gemini';
  return 'openai';
}

export function createMockSnapshot(site) {
  const seed = hashSite(site);
  const type = site.type || 'other';
  const groupNames = GROUP_NAMES_BY_TYPE[type] ?? GROUP_NAMES_BY_TYPE.other;
  const latencyMs = 180 + (seed % 1380);
  const ok = seed % 11 !== 0;
  const balanceCny = Number(((seed % 70000) / 100 + 38.6).toFixed(2));
  const balanceUsd = Number((balanceCny / 7.25).toFixed(2));

  return {
    siteId: site.id,
    balanceCny,
    balanceUsd,
    token: `sk-${toBase36(seed).padStart(18, '0')}${toBase36(seed * 17).slice(0, 10)}`,
    groups: groupNames.map((name, index) => {
      const multiplier = Number((0.5 + ((seed >> (index + 1)) % 18) / 10).toFixed(2));
      return {
        id: `${site.id}-${name}`,
        name,
        multiplier,
        quotaCny: Number((balanceCny * (0.12 + index * 0.09)).toFixed(2)),
        enabled: (seed + index) % 5 !== 0,
      };
    }),
    probe: {
      ok,
      latencyMs: ok ? latencyMs : null,
      status: classifyProbe({ ok, latencyMs: ok ? latencyMs : null }),
      checkedAt: new Date(seedDate(seed)).toISOString(),
    },
    refreshedAt: new Date(seedDate(seed + 29)).toISOString(),
  };
}

export function summarizeFleet(sites, snapshots) {
  const snapshotList = Object.values(snapshots);
  const downCount = snapshotList.filter((item) => item.probe.status === 'down').length;
  const slowCount = snapshotList.filter((item) => item.probe.status === 'slow').length;
  const groupCount = snapshotList.reduce((sum, item) => sum + item.groups.length, 0);

  // 总余额按各站点展示口径求和（USD 站点按配置倍率折 CNY），余额不足同理按展示金额判断
  let balanceCny = 0;
  let balanceAlertCount = 0;
  for (const site of sites) {
    const snapshot = snapshots[site.id];
    if (!snapshot) continue;
    const balance = displayBalance({ site, snapshot });
    balanceCny += balance.amount;
    const threshold = Number(site.balanceAlert ?? 0);
    if (Number.isFinite(threshold) && threshold > 0 && Number(balance.amount) < threshold) {
      balanceAlertCount += 1;
    }
  }

  return {
    siteCount: sites.length,
    balanceCny: Number(balanceCny.toFixed(2)),
    balanceAlertCount,
    downCount,
    slowCount,
    groupCount,
  };
}

function hashSite(site) {
  const input = `${site.id}|${site.name}|${site.url}|${site.type}|${site.username}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function toBase36(value) {
  return Math.abs(Number(value)).toString(36);
}

function seedDate(seed) {
  const base = Date.UTC(2026, 6, 4, 9, 0, 0);
  return base - (seed % 86_400_000);
}
