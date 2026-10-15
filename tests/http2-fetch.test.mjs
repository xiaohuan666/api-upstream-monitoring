import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, createSecureServer } from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

import { createHttp2Fetch } from '../src/upstreams/http2-fetch.mjs';
import { withUpstreamApi } from '../src/upstreams/api-transport.mjs';
import { fetchNewApiSnapshot } from '../src/upstreams/newapi.mjs';
import { fetchAvailableModels, testModelLatency } from '../src/model-probe.mjs';

const directory = mkdtempSync(join(tmpdir(), 'aum-http2-cert-'));
let key;
let cert;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
  key = readFileSync(join(directory, 'key.pem'));
  cert = readFileSync(join(directory, 'cert.pem'));
} finally {
  rmSync(directory, { recursive: true });
}

const logger = { info() {} };
const trustedConnect = (origin, options) => connect(origin, { ...options, ca: cert });
const trustedHttp2 = (options) => createHttp2Fetch({ ...options, connectSession: trustedConnect });

async function serve(t, handler, server = createSecureServer({ key, cert })) {
  const sessions = new Set();
  server.on('session', (session) => { sessions.add(session); session.on('error', () => {}); });
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    handler(stream, headers);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const session of sessions) session.destroy(); server.closeAllConnections?.(); server.close(); });
  return `https://127.0.0.1:${server.address().port}`;
}

test('HTTP2 multiplexes requests, preserves POST and separate cookies, and keeps TLS verification', async (t) => {
  const requests = [];
  let connections = 0;
  const origin = await serve(t, (stream, headers) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      requests.push({ headers, body: Buffer.concat(chunks).toString() });
      stream.respond({ ':status': 200, 'set-cookie': ['session=one; Path=/', 'refresh=two; Path=/auth'] });
      stream.end('{"success":true}');
    });
  });
  const client = createHttp2Fetch({ connectSession: (...args) => { connections++; return trustedConnect(...args); } });
  t.after(() => client.close());
  const responses = await Promise.all([
    client.fetch(`${origin}/api/status?query=one`, { headers: { authorization: 'Bearer private', connection: 'keep-alive' } }),
    client.fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"private"}' }),
  ]);
  assert.equal(connections, 1);
  assert.deepEqual(responses[0].headers.getSetCookie(), ['session=one; Path=/', 'refresh=two; Path=/auth']);
  assert.equal(JSON.parse(await responses[0].text()).success, true);
  assert.equal(requests[0].headers[':path'], '/api/status?query=one');
  assert.equal(requests[0].headers.authorization, 'Bearer private');
  assert.equal(requests[0].headers.connection, undefined);
  assert.equal(requests[1].body, '{"password":"private"}');
  const untrusted = createHttp2Fetch({ timeoutMs: 1000 });
  t.after(() => untrusted.close());
  await assert.rejects(untrusted.fetch(`${origin}/api/status`), /self-signed|certificate|pending stream.*canceled/i);
});

test('HTTP2 keeps redirects visible without sending authorization to another origin', async (t) => {
  let requests = 0;
  const origin = await serve(t, (stream) => {
    requests++;
    stream.respond({ ':status': 302, location: 'https://different-origin.invalid/secret' });
    stream.end();
  });
  const client = trustedHttp2({});
  t.after(() => client.close());
  const response = await client.fetch(origin, { headers: { authorization: 'Bearer private' } });
  assert.equal(response.status, 302);
  assert.equal(requests, 1);
});

test('HTTP2 body timeout and early close reject without hanging; client cleanup closes sessions', async (t) => {
  const origin = await serve(t, (stream, headers) => {
    if (headers[':path'] === '/early') return stream.close();
    stream.respond({ ':status': 200 });
    stream.write('{');
  });
  const client = trustedHttp2({ timeoutMs: 100 });
  t.after(() => client.close());
  const stalled = await client.fetch(`${origin}/stall`);
  await assert.rejects(stalled.text(), /timeout|aborted/i);
  await assert.rejects(client.fetch(`${origin}/early`), /headers missing|closed|stream/i);
  client.close();
  await assert.rejects(client.fetch(origin), /client is closed/);
});

test('HTTP2 failure on an HTTP1-only server rejects within the timeout', async (t) => {
  const server = createHttpsServer({ key, cert }, (_req, res) => { res.end('{}'); });
  const origin = await serve(t, () => {}, server);
  const client = trustedHttp2({ timeoutMs: 200 });
  t.after(() => client.close());
  await assert.rejects(client.fetch(origin), /Protocol error|protocol|timeout|stream/i);
});

test('new-api challenge retries real HTTP2 without Referer, rotates cookies, and never launches a browser', async (t) => {
  const requests = [];
  let firstTransportRequests = 0;
  let closed = false;
  const origin = await serve(t, (stream, headers) => {
    assert.equal(headers.referer, undefined);
    requests.push(headers[':path']);
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const path = headers[':path'];
      let data;
      if (path === '/api/user/login') {
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { username: 'test-user', password: 'private' });
        stream.respond({ ':status': 200, 'set-cookie': ['new_api_refresh=rotated; Path=/api/user/auth/refresh; HttpOnly'] });
        stream.end(JSON.stringify({ success: true, data: { access_token: 'valid-token' } }));
        return;
      }
      if (headers.authorization !== 'Bearer valid-token') {
        stream.respond({ ':status': 401 });
        stream.end('{"success":false,"message":"expired"}');
        return;
      }
      if (path === '/api/status') data = { quota_per_unit: 1 };
      if (path === '/api/user/self') data = { quota: 7 };
      if (path === '/api/user/self/groups') data = { default: { ratio: 1 } };
      if (path.startsWith('/api/token/?')) data = { items: [{ id: 1, group: 'default' }] };
      if (path === '/api/token/batch/keys') {
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { ids: [1] });
        data = { keys: { 1: 'sk-test' } };
      }
      assert.ok(data, path);
      stream.respond({ ':status': 200 });
      stream.end(JSON.stringify({ success: true, data }));
    });
  });
  const result = await fetchNewApiSnapshot({ id: 'nice-fixture', url: origin, newApiUserId: '1', authToken: 'expired', username: 'test-user', password: 'private' }, {
    logger,
    fetch: async (_url, init) => {
      firstTransportRequests++;
      assert.equal(init.headers.referer, undefined);
      return new Response('<html>challenge</html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    },
    createHttp2Fetch: (options) => {
      const client = trustedHttp2(options);
      return { fetch: client.fetch, close() { closed = true; client.close(); } };
    },
    browserType: { launch() { throw new Error('must not launch a browser'); } },
  });
  assert.equal(firstTransportRequests, 4);
  assert.equal(result.normalizedSnapshot.balanceAmount, 7);
  assert.equal(result.normalizedSnapshot.tokens[0].key, 'sk-test');
  assert.equal(result.authUpdate.refreshToken, 'rotated');
  assert.equal(closed, true);
  assert.equal(requests.filter((path) => path === '/api/user/login').length, 1);
});

test('HTTP2 is not retried for ambiguous POST network failures or JSON authentication errors', async () => {
  for (const networkError of [true, false]) {
    await withUpstreamApi({ id: 'site' }, {
      logger,
      fetch: async () => {
        if (networkError) throw new Error('connection closed');
        return new Response('{"success":false}', { status: 401 });
      },
      createHttp2Fetch: () => { throw new Error('must not retry'); },
    }, async (fetch) => {
      if (networkError) await assert.rejects(fetch('https://site.invalid/login', { method: 'POST' }), /connection closed/);
      else assert.equal((await fetch('https://site.invalid/login', { method: 'POST' })).status, 401);
    });
  }
});

test('HTTP2 challenge failure still reaches browser fallback and cleans up the API client', async () => {
  let closed = false;
  let launches = 0;
  await assert.rejects(fetchNewApiSnapshot({ id: 'site', url: 'https://site.invalid', newApiUserId: '1', authToken: 'test' }, {
    logger,
    fetch: async () => new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    createHttp2Fetch: () => ({ fetch: async () => { throw new Error('HTTP2 protocol error'); }, close() { closed = true; } }),
    browserType: { launch() { assert.equal(closed, true); launches++; throw new Error('browser timeout'); } },
  }), /API 同步失败.*Playwright 兜底失败/);
  assert.equal(launches, 1);
});

test('model listing retries a challenge over HTTP2 with the application user-agent', async (t) => {
  let firstRequests = 0;
  const origin = await serve(t, (stream, headers) => {
    assert.equal(headers[':path'], '/v1/models');
    assert.equal(headers['user-agent'], 'api-upstream-monitoring/0.1');
    assert.equal(headers.authorization, 'Bearer sk-test');
    assert.equal(headers.referer, undefined);
    stream.respond({ ':status': 200 });
    stream.end('{"data":[{"id":"claude-fable-5"}]}');
  });
  const models = await fetchAvailableModels({
    baseUrl: origin, apiKey: 'sk-test', logger,
    fetchImpl: async () => {
      firstRequests++;
      return new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    },
    createHttp2Fetch: trustedHttp2,
  });
  assert.equal(firstRequests, 1);
  assert.deepEqual(models, [{ id: 'claude-fable-5', ownedBy: '' }]);
});

for (const [platform, path] of [['openai', '/v1/chat/completions'], ['anthropic', '/v1/messages']]) {
  test(`${platform} probe retries HTTP2, waits for the first chunk and cancels an unfinished stream`, { timeout: 3000 }, async (t) => {
    let closed;
    const streamClosed = new Promise((resolve) => { closed = resolve; });
    let clock = 1000;
    const origin = await serve(t, (stream, headers) => {
      assert.equal(headers[':path'], path);
      assert.equal(headers['user-agent'], 'api-upstream-monitoring/0.1');
      assert.equal(headers.authorization, 'Bearer sk-test');
      if (platform === 'anthropic') {
        assert.equal(headers['x-api-key'], 'sk-test');
        assert.equal(headers['anthropic-version'], '2023-06-01');
      }
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(body.model, 'model-test');
        assert.equal(body.max_tokens, 1);
        assert.equal(body.stream, true);
        stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
        setTimeout(() => { clock = 1800; stream.write('data: {"ok":true}\n\n'); }, 50);
      });
      stream.on('close', closed);
    });
    const result = await testModelLatency({
      baseUrl: origin, apiKey: 'sk-test', model: 'model-test', platform, logger, timeoutMs: 1000,
      now: () => clock,
      fetchImpl: async () => new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
      createHttp2Fetch: trustedHttp2,
    });
    assert.equal(result.success, true);
    assert.equal(result.responseTimeMs, 800);
    await streamClosed;
  });
}
