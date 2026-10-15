import { classifyProbe } from './domain.mjs';
import { withUpstreamApi } from './upstreams/api-transport.mjs';

const DEFAULT_USER_AGENT = 'api-upstream-monitoring/0.1';

const KNOWN_COMPAT_SUFFIXES = [
  '/api/claudecode',
  '/api/anthropic',
  '/apps/anthropic',
  '/api/coding',
  '/claudecode',
  '/anthropic',
  '/step_plan',
  '/coding',
  '/claude',
];

const ERROR_BODY_MAX_CHARS = 512;

export function buildModelsUrlCandidates(baseUrl, { isFullUrl = false, modelsUrlOverride = '' } = {}) {
  const override = String(modelsUrlOverride ?? '').trim();
  if (override) return [override];

  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Base URL is empty');

  if (isFullUrl) {
    const index = trimmed.indexOf('/v1/');
    if (index >= 0) return [`${trimmed.slice(0, index)}/v1/models`];
    const slash = trimmed.lastIndexOf('/');
    if (slash > 'https://'.length) return [`${trimmed.slice(0, slash)}/v1/models`];
    throw new Error('Cannot derive models endpoint from full URL');
  }

  const candidates = [];
  if (endsWithVersionSegment(trimmed)) {
    candidates.push(`${trimmed}/models`);
    if (!trimmed.endsWith('/v1')) candidates.push(`${trimmed}/v1/models`);
  } else {
    candidates.push(`${trimmed}/v1/models`);
  }

  const stripped = stripCompatSuffix(trimmed);
  if (stripped) {
    const root = stripped.replace(/\/+$/, '');
    candidates.push(`${root}/v1/models`);
    candidates.push(`${root}/models`);
  }

  return unique(candidates);
}

export async function fetchAvailableModels({
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  proxy = null,
  siteId,
  apiRequest,
  createHttp2Fetch,
  logger,
  userAgent = '',
  timeoutMs = 15_000,
} = {}) {
  const key = String(apiKey ?? '').trim();
  if (!key) throw new Error('API key is required to fetch models');
  if (!fetchImpl) throw new Error('fetch is not available');

  const candidates = buildModelsUrlCandidates(baseUrl);
  let lastError = 'no candidates';
  return await withUpstreamApi({ id: siteId, proxy }, {
    fetch: fetchImpl, apiRequest, createHttp2Fetch, logger, timeoutMs, operation: 'models',
  }, async (effectiveFetch) => {
    for (const url of candidates) {
      const response = await effectiveFetch(url, {
        headers: cleanHeaders({
          authorization: `Bearer ${key}`,
          accept: 'application/json',
          'user-agent': String(userAgent ?? '').trim() || DEFAULT_USER_AGENT,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        const payload = await parseJson(response);
        return normalizeModels(payload).sort((left, right) => left.id.localeCompare(right.id));
      }

      const body = truncate(await response.text().catch(() => ''));
      if (response.status === 404 || response.status === 405) {
        lastError = `HTTP ${response.status}: ${body}`;
        continue;
      }
      throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
    }

    throw new Error(`All candidates failed: ${lastError}`);
  });
}

export async function testModelLatency({
  baseUrl,
  apiKey,
  model,
  platform = 'openai',
  fetchImpl = globalThis.fetch,
  proxy = null,
  siteId,
  apiRequest,
  createHttp2Fetch,
  logger,
  userAgent = '',
  timeoutMs = 45_000,
  testPrompt = 'Who are you?',
  now = Date.now,
} = {}) {
  const key = String(apiKey ?? '').trim();
  const selectedModel = String(model ?? '').trim();
  if (!key) throw new Error('API key is required to test model');
  if (!selectedModel) throw new Error('Model is required');
  if (!fetchImpl) throw new Error('fetch is not available');

  const startedAt = now();
  const platformKey = String(platform ?? '').toLowerCase();
  const request = platformKey === 'anthropic'
    ? anthropicRequest(baseUrl, key, selectedModel, testPrompt, timeoutMs)
    : openAiRequest(baseUrl, key, selectedModel, testPrompt, timeoutMs);

  request.init.headers['user-agent'] = String(userAgent ?? '').trim() || DEFAULT_USER_AGENT;
  return await withUpstreamApi({ id: siteId, proxy }, {
    fetch: fetchImpl, apiRequest, createHttp2Fetch, logger, timeoutMs, operation: 'model-test',
  }, async (effectiveFetch) => {
    const response = await effectiveFetch(request.url, request.init);

    if (!response.ok) {
      const body = truncate(await response.text().catch(() => ''));
      return {
        success: false,
        status: 'down',
        message: `HTTP ${response.status}: ${body || response.statusText}`,
        responseTimeMs: Math.max(0, now() - startedAt),
        httpStatus: response.status,
        modelUsed: selectedModel,
        testedAt: toIsoOrNumber(startedAt),
      };
    }

    await readFirstChunk(response);
    const responseTimeMs = Math.max(0, now() - startedAt);
    return {
      success: true,
      status: classifyProbe({ ok: true, latencyMs: responseTimeMs }),
      message: '模型响应正常',
      responseTimeMs,
      httpStatus: response.status,
      modelUsed: selectedModel,
      testedAt: toIsoOrNumber(startedAt),
    };
  });
}

function openAiRequest(baseUrl, apiKey, model, prompt, timeoutMs) {
  return {
    url: resolveEndpointUrl(baseUrl, 'chat/completions'),
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'accept-encoding': 'identity',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1,
        stream: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  };
}

function anthropicRequest(baseUrl, apiKey, model, prompt, timeoutMs) {
  return {
    url: resolveEndpointUrl(baseUrl, 'messages'),
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'accept-encoding': 'identity',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  };
}

function resolveEndpointUrl(baseUrl, endpoint) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Base URL is empty');
  if (base.endsWith('/v1')) return `${base}/${endpoint}`;
  return `${base}/v1/${endpoint}`;
}

async function parseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function normalizeModels(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : [];
  return list
    .map((model) => ({
      id: String(model.id ?? '').trim(),
      ownedBy: model.owned_by ? String(model.owned_by) : '',
    }))
    .filter((model) => model.id);
}

async function readFirstChunk(response) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      const { done } = await reader.read();
      if (done) throw new Error('Model returned an empty response');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock?.();
    }
    return;
  }
  await response.text();
}

function endsWithVersionSegment(url) {
  const last = url.split('/').at(-1) ?? '';
  return /^v\d+$/.test(last);
}

function stripCompatSuffix(url) {
  return KNOWN_COMPAT_SUFFIXES.find((suffix) => url.endsWith(suffix))
    ? url.slice(0, -KNOWN_COMPAT_SUFFIXES.find((suffix) => url.endsWith(suffix)).length)
    : null;
}

function unique(values) {
  const result = [];
  for (const value of values) {
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function cleanHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => String(value ?? '').trim()),
  );
}

function truncate(value) {
  const text = String(value ?? '');
  return text.length > ERROR_BODY_MAX_CHARS
    ? `${text.slice(0, ERROR_BODY_MAX_CHARS)}...`
    : text;
}

function toIsoOrNumber(value) {
  return typeof value === 'number' && value < 10_000_000_000 ? value : new Date(value).toISOString();
}
