const PLATFORM_ALIASES = new Map([
  ['openai', 'openai'], ['gpt', 'openai'], ['chatgpt', 'openai'],
  ['anthropic', 'anthropic'], ['claude', 'anthropic'],
  ['grok', 'grok'], ['xai', 'grok'], ['x.ai', 'grok'],
  ['gemini', 'gemini'], ['google', 'gemini'],
  ['unknown', 'unknown'],
]);

/** Unlike the general platform normalizer, missing metadata never implies OpenAI. */
export function normalizeRateHistoryPlatform(value) {
  if (typeof value !== 'string') return 'unknown';
  return PLATFORM_ALIASES.get(value.trim().toLowerCase()) ?? 'unknown';
}

/** Only explicit, unambiguous provider/model names count as group-name evidence. */
export function inferRateHistoryPlatform(groupName) {
  if (typeof groupName !== 'string') return 'unknown';
  const platforms = [
    ['openai', /(?:^|[^a-z0-9])(?:openai|chatgpt|gpt|codex)(?=$|[^a-z])/i],
    ['anthropic', /(?:^|[^a-z0-9])(?:anthropic|claude)(?=$|[^a-z])/i],
    ['grok', /(?:^|[^a-z0-9])grok(?=$|[^a-z])/i],
    ['gemini', /(?:^|[^a-z0-9])gemini(?=$|[^a-z])/i],
  ].filter(([, pattern]) => pattern.test(groupName));
  return platforms.length === 1 ? platforms[0][0] : 'unknown';
}

/** Called at the adapter boundary, before the ordinary UI defaults unknown values. */
export function observeRateHistoryPlatform(upstreamPlatform, groupName) {
  const explicit = normalizeRateHistoryPlatform(upstreamPlatform);
  return explicit !== 'unknown' ? explicit : inferRateHistoryPlatform(groupName);
}

/** A site link is an HTTP(S) origin, never a credential, query, fragment or path. */
export function normalizeRateHistorySiteUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return '';
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && url.hostname ? url.origin : '';
  } catch {
    return '';
  }
}

/** Event metadata wins; snapshot/configuration are read-only legacy display fallbacks. */
export function resolveRateHistoryMetadata({ platform, siteUrl, snapshotPlatform, currentSiteUrl, groupName }) {
  const eventPlatform = typeof platform === 'string' && platform.trim()
    ? normalizeRateHistoryPlatform(platform) : undefined;
  const snapshot = normalizeRateHistoryPlatform(snapshotPlatform);
  return {
    platform: eventPlatform ?? (snapshot !== 'unknown' ? snapshot : inferRateHistoryPlatform(groupName)),
    // NULL marks legacy rows; an empty recorded URL must stay unavailable.
    siteUrl: typeof siteUrl === 'string'
      ? normalizeRateHistorySiteUrl(siteUrl) : normalizeRateHistorySiteUrl(currentSiteUrl),
  };
}
