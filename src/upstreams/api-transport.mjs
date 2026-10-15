import { request } from 'playwright';
import { createHttp2Fetch } from './http2-fetch.mjs';

export function hasActiveProxy(proxy) {
  return Boolean(proxy && proxy.status !== 'inactive' && proxy.host && proxy.port);
}

export function nonJsonResponseMessage(path, response) {
  const reason = response.headers?.get?.('cf-mitigated') === 'challenge'
    ? 'Cloudflare challenge (non-JSON response)'
    : 'non-JSON response';
  return `${path} HTTP ${response.status}: ${reason}`;
}

/** Run a scoped API operation through the configured route without launching a browser. */
export async function withUpstreamApi(site, options, operation) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  let context;
  let http2;
  let useHttp2 = false;
  try {
    if (hasActiveProxy(site.proxy)) {
      const proxy = site.proxy;
      const server = new URL(`${proxy.protocol}://${proxy.host}:${Number(proxy.port)}`);
      const settings = { server: server.toString() };
      if (String(proxy.protocol).startsWith('socks')) {
        // The HTTP request client reads SOCKS credentials from the proxy URL.
        server.username = proxy.username ?? '';
        server.password = proxy.password ?? '';
        settings.server = server.toString();
      } else {
        if (proxy.username) settings.username = String(proxy.username);
        if (proxy.password) settings.password = String(proxy.password);
      }
      try {
        context = await (options.apiRequest ?? request).newContext({ proxy: settings, timeout: timeoutMs });
      } catch (error) {
        throw Object.assign(new Error('API proxy connection setup failed', { cause: error }), { apiTransportBlocked: true });
      }
    }

    const fetchImpl = context
      ? async (url, init = {}) => {
        let response;
        try {
          response = await context.fetch(url, {
            method: init.method ?? 'GET',
            headers: init.headers,
            data: init.body,
            timeout: timeoutMs,
            failOnStatusCode: false,
          });
        } catch (error) {
          // Playwright embeds request headers (including API keys) in its errors.
          const reason = /timeout|timed out/i.test(error.message) ? 'timeout' : 'connection failed';
          throw new Error(`API proxy request ${reason}`, { cause: error });
        }
        try {
          const headers = new Headers();
          for (const { name, value } of response.headersArray()) headers.append(name, value);
          const body = await response.text();
          return {
            ok: response.ok(),
            status: response.status(),
            statusText: response.statusText(),
            headers,
            text: async () => body,
          };
        } finally {
          await response.dispose();
        }
      }
      : async (url, init = {}) => {
        const requestInit = {
          ...init,
          signal: init.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        };
        if (useHttp2) return await http2.fetch(url, requestInit);
        const response = await (options.fetch ?? globalThis.fetch)(url, requestInit);
        // A challenge did not reach upstream authentication; retry it over HTTP/2
        // before starting a browser. Never replay an ambiguous failed login/refresh.
        if (new URL(url).protocol !== 'https:' || response.headers?.get?.('cf-mitigated') !== 'challenge') {
          return response;
        }
        if (!http2) {
          http2 = (options.createHttp2Fetch ?? createHttp2Fetch)({ timeoutMs });
          useHttp2 = true;
          (options.logger ?? console).info?.('[upstream-transport]', JSON.stringify({
            siteId: site.id, operation: options.operation ?? 'snapshot', host: new URL(url).host,
            transport: 'http2', reason: 'Cloudflare challenge',
          }));
        }
        await response.body?.cancel();
        return await http2.fetch(url, requestInit);
      };

    return await operation(fetchImpl);
  } finally {
    http2?.close();
    await context?.dispose();
  }
}

/** Settle sibling requests before switching transports or disposing their client. */
export async function settleSnapshotRequests(requests) {
  const results = await Promise.allSettled(requests);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map((result) => result.value);
}
