import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiRequest } from './helpers/api-request.mjs';

import {
  buildModelsUrlCandidates,
  fetchAvailableModels,
  testModelLatency,
} from '../src/model-probe.mjs';

test('buildModelsUrlCandidates follows cc-switch model endpoint candidates', () => {
  assert.deepEqual(
    buildModelsUrlCandidates('https://api.example.com'),
    ['https://api.example.com/v1/models'],
  );
  assert.deepEqual(
    buildModelsUrlCandidates('https://api.provider-b.example.test/api/coding/paas/v4'),
    [
      'https://api.provider-b.example.test/api/coding/paas/v4/models',
      'https://api.provider-b.example.test/api/coding/paas/v4/v1/models',
    ],
  );
  assert.deepEqual(
    buildModelsUrlCandidates('https://api.provider.example.test/anthropic'),
    [
      'https://api.provider.example.test/anthropic/v1/models',
      'https://api.provider.example.test/v1/models',
      'https://api.provider.example.test/models',
    ],
  );
});

test('fetchAvailableModels tries 404 candidates then returns sorted model ids', async () => {
  const calls = [];
  const models = await fetchAvailableModels({
    baseUrl: 'https://api.provider.example.test/anthropic',
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return jsonResponse({ error: 'not found' }, { status: 404 });
      }
      return jsonResponse({
        data: [
          { id: 'z-model', owned_by: 'relay' },
          { id: 'a-model', owned_by: 'relay' },
        ],
      });
    },
  });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://api.provider.example.test/anthropic/v1/models',
    'https://api.provider.example.test/v1/models',
  ]);
  assert.equal(calls[1].init.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(models, [
    { id: 'a-model', ownedBy: 'relay' },
    { id: 'z-model', ownedBy: 'relay' },
  ]);
});

test('fetchAvailableModels uses a browser-free API proxy client when proxy is configured', async () => {
  const calls = [];
  const models = await fetchAvailableModels({
    baseUrl: 'https://relay.example.com',
    apiKey: 'sk-test',
    proxy: activeProxy(),
    apiRequest: createApiRequest(async () => jsonResponse({
      data: [{ id: 'gpt-5.5', owned_by: 'relay' }],
    }), calls),
    fetchImpl: async () => {
      throw new Error('direct fetch should not be used');
    },
  });

  assert.deepEqual(calls[0], { type: 'context', options: {
    proxy: { server: 'http://127.0.0.1:7897/' }, timeout: 15000,
  } });
  assert.equal(calls[1].url, 'https://relay.example.com/v1/models');
  assert.deepEqual(calls[1].init, {
    method: 'GET',
    headers: {
      authorization: 'Bearer sk-test',
      accept: 'application/json',
      'user-agent': 'api-upstream-monitoring/0.1',
    },
    data: undefined,
    timeout: 15000,
    failOnStatusCode: false,
  });
  assert.deepEqual(calls.at(-2), { type: 'response-disposed' });
  assert.deepEqual(calls.at(-1), { type: 'disposed' });
  assert.deepEqual(models, [{ id: 'gpt-5.5', ownedBy: 'relay' }]);
});

test('testModelLatency sends a real OpenAI-compatible model request and reports latency', async () => {
  const calls = [];
  const result = await testModelLatency({
    baseUrl: 'https://relay.example.com',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    platform: 'openai',
    now: fakeClock([1000, 1368]),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return textResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    },
  });

  assert.equal(calls[0].url, 'https://relay.example.com/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Who are you?' }],
    max_tokens: 1,
    stream: true,
  });
  assert.deepEqual(result, {
    success: true,
    status: 'healthy',
    message: '模型响应正常',
    responseTimeMs: 368,
    httpStatus: 200,
    modelUsed: 'gpt-4o-mini',
    testedAt: 1000,
  });
});

test('testModelLatency uses a browser-free API proxy client when proxy is configured', async () => {
  const calls = [];
  const result = await testModelLatency({
    baseUrl: 'https://relay.example.com',
    apiKey: 'sk-test',
    model: 'gpt-5.5',
    platform: 'openai',
    proxy: activeProxy(),
    apiRequest: createApiRequest(async () => textResponse('data: {}\n\n'), calls),
    now: fakeClock([1000, 1420]),
    fetchImpl: async () => {
      throw new Error('direct fetch should not be used');
    },
  });

  assert.equal(calls[1].url, 'https://relay.example.com/v1/chat/completions');
  assert.deepEqual(calls[1].init, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'accept-encoding': 'identity',
      'user-agent': 'api-upstream-monitoring/0.1',
    },
    data: JSON.stringify({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'Who are you?' }],
      max_tokens: 1,
      stream: true,
    }),
    timeout: 45000,
    failOnStatusCode: false,
  });
  assert.equal(result.success, true);
  assert.equal(result.responseTimeMs, 420);
  assert.equal(result.modelUsed, 'gpt-5.5');
});

test('model latency includes the wait for first body bytes and cancels the remaining stream', async () => {
  let clock = 1000;
  let cancelled = false;
  const result = await testModelLatency({
    baseUrl: 'https://site.invalid', apiKey: 'sk-test', model: 'test', now: () => clock,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        clock = 1420;
        controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 })),
  });
  assert.equal(result.responseTimeMs, 420);
  assert.equal(cancelled, true);
});

test('an empty model stream cannot report a successful probe', async () => {
  await assert.rejects(testModelLatency({
    baseUrl: 'https://site.invalid', apiKey: 'sk-test', model: 'test',
    fetchImpl: async () => new Response(''),
  }), /empty response/);
});

test('a proxy challenge never causes a direct HTTP2 request', async () => {
  const events = [];
  const result = await testModelLatency({
    baseUrl: 'https://site.invalid', apiKey: 'sk-test', model: 'test', proxy: activeProxy(),
    apiRequest: createApiRequest(async () => new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } }), events),
    fetchImpl: () => { throw new Error('must not bypass proxy'); },
    createHttp2Fetch: () => { throw new Error('must not bypass proxy'); },
  });
  assert.equal(result.success, false);
  assert.equal(result.httpStatus, 403);
  assert.equal(events.at(-1).type, 'disposed');
});

test('proxy network errors never expose the API key embedded in request-client errors', async () => {
  let disposed = false;
  await assert.rejects(fetchAvailableModels({
    baseUrl: 'https://site.invalid', apiKey: 'sk-private', proxy: activeProxy(),
    apiRequest: { newContext: async () => ({
      fetch: async () => { throw new Error('Connection failed\nauthorization: Bearer sk-private'); },
      dispose: async () => { disposed = true; },
    }) },
  }), (error) => {
    assert.equal(error.message, 'API proxy request connection failed');
    assert.equal(error.message.includes('sk-private'), false);
    return true;
  });
  assert.equal(disposed, true);
});

test('model requests preserve an explicit caller user-agent', async () => {
  await fetchAvailableModels({
    baseUrl: 'https://site.invalid', apiKey: 'sk-test', userAgent: 'custom-client/1',
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers['user-agent'], 'custom-client/1');
      return jsonResponse({ data: [] });
    },
  });
});

function fakeClock(values) {
  let index = 0;
  return () => values[index++] ?? values.at(-1);
}

function activeProxy() {
  return {
    protocol: 'http',
    host: '127.0.0.1',
    port: 7897,
    username: '',
    password: '',
    status: 'active',
  };
}

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    async text() {
      return JSON.stringify(payload);
    },
    async json() {
      return payload;
    },
  };
}

function textResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    async text() {
      return payload;
    },
  };
}
