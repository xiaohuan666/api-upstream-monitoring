import { hasActiveProxy } from './api-transport.mjs';

/** Keep API-first ordering and stage diagnostics identical across adapters. */
export async function fetchSnapshotWithFallback(site, options, { api, browser, shouldFallback }) {
  const logger = options.logger ?? console;
  const report = (stage, result, error) => {
    logger.info?.('[snapshot-sync]', JSON.stringify({
      siteId: site.id,
      type: site.type,
      variant: site.syncVariant ?? site.sync_variant ?? 'default',
      route: hasActiveProxy(site.proxy) ? 'proxy' : 'direct',
      stage,
      result,
      ...(error ? { reason: summarizeSyncError(error) } : {}),
    }));
  };
  report('api', 'started');
  let apiError;
  try {
    const result = await api();
    report('api', 'succeeded');
    return result;
  } catch (error) {
    report('api', 'failed', error);
    if (!shouldFallback(error) && !error?.apiTransportBlocked) throw error;
    apiError = error;
  }
  report('browser', 'started');
  try {
    const result = await browser();
    report('browser', 'succeeded');
    return result;
  } catch (error) {
    report('browser', 'failed', error);
    throw new Error(
      `API 同步失败：${summarizeSyncError(apiError)}；Playwright 兜底失败：${summarizeSyncError(error)}`,
      { cause: new AggregateError([apiError, error]) },
    );
  }
}

// Only emit known diagnostics, never arbitrary upstream bodies, URLs or credentials.
function summarizeSyncError(error) {
  const message = String(error?.message ?? '');
  const endpoint = message.match(/\/api\/(?:v1\/)?(?:user\/(?:self(?:\/groups)?|profile|auth\/refresh|login)|auth\/(?:refresh|login)|groups\/(?:available|rates)|token\/(?:batch\/keys)?|keys|status)\b/)?.[0];
  const status = message.match(/HTTP \d{3}\b/)?.[0];
  let reason = 'request failed';
  if (/cloudflare|cf-mitigated|Just a moment|challenge/i.test(message)) reason = 'Cloudflare challenge';
  else if (/non-JSON|<!doctype|<html/i.test(message)) reason = 'non-JSON response';
  else if (/timeout|timed out|abort/i.test(message)) reason = 'timeout';
  else if (/SESSION_BINDING_MISMATCH/.test(message)) reason = 'SESSION_BINDING_MISMATCH';
  else if (/proxy/i.test(message)) reason = 'proxy connection failed';
  return [endpoint, status, reason].filter(Boolean).join(' ');
}
