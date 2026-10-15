import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';

import { fetchNewApiSnapshot } from '../src/upstreams/newapi.mjs';
import { fetchSub2ApiSnapshot } from '../src/upstreams/sub2api.mjs';
import { fetchSub2ApiFlowSnapshot } from '../src/upstreams/sub2api-flow.mjs';
import { withUpstreamApi } from '../src/upstreams/api-transport.mjs';
import { createApiRequest } from './helpers/api-request.mjs';

const logger = { info() {} };
const site = {
  id: 'site-1', url: 'https://upstream.test', newApiUserId: '12',
  authToken: 'valid-token', username: 'user@example.test', password: 'private-password',
};

function apiResponse(url, init) {
  const path = new URL(url).pathname;
  assert.equal(init.headers.authorization, 'Bearer valid-token');
  const data = {
    '/api/status': { quota_per_unit: 1 },
    '/api/user/self': { id: 12, quota: 7 },
    '/api/user/self/groups': {},
    '/api/token/': { items: [] },
    '/api/v1/user/profile': { balance: 7 },
    '/api/v1/groups/available': [],
    '/api/v1/groups/rates': {},
    '/api/v1/keys': { items: [] },
  };
  assert.ok(Object.hasOwn(data, path), path);
  return new Response(JSON.stringify({ success: true, code: 0, data: data[path] }));
}

const adapters = [
  ['new-api', fetchNewApiSnapshot],
  ['sub2api', fetchSub2ApiSnapshot],
  ['credential-flow', fetchSub2ApiFlowSnapshot],
];

for (const [type, adapter] of adapters) {
  for (const protocol of ['http', 'socks5']) {
    test(`${type} uses ${protocol} proxy API successfully without a browser or direct traffic`, async () => {
      const events = [];
      let launches = 0;
      const result = await adapter({
        ...site, type,
        proxy: { protocol, host: 'proxy.test', port: 1080, username: 'proxy-user', password: 'p@ss' },
      }, {
        logger,
        apiRequest: createApiRequest(apiResponse, events),
        fetch: () => { throw new Error('must not bypass the proxy'); },
        browserType: { launch: () => { launches++; throw new Error('must not launch'); } },
      });
      assert.equal(result.normalizedSnapshot.balanceAmount, 7);
      assert.equal(launches, 0);
      assert.equal(events.filter(({ type }) => type === 'request').length, 4);
      assert.equal(events.filter(({ type }) => type === 'response-disposed').length, 4);
      assert.equal(events.at(-1).type, 'disposed');
      const proxy = events[0].options.proxy;
      if (protocol === 'http') {
        assert.deepEqual(proxy, { server: 'http://proxy.test:1080/', username: 'proxy-user', password: 'p@ss' });
      } else {
        assert.equal(proxy.server, 'socks5://proxy-user:p%40ss@proxy.test:1080');
      }
    });
  }

  test(`${type} disabled proxy uses API directly without creating a proxy client`, async () => {
    const result = await adapter({ ...site, proxy: { host: 'proxy.test', port: 1080, status: 'inactive' } }, {
      logger,
      fetch: apiResponse,
      apiRequest: { newContext() { throw new Error('proxy is inactive'); } },
      browserType: { launch() { throw new Error('must not launch'); } },
    });
    assert.equal(result.normalizedSnapshot.balanceAmount, 7);
  });

  test(`${type} records API failure before browser fallback and preserves both failures without secrets`, async () => {
    const stages = [];
    const lifecycle = [];
    let resolveSibling;
    let launched = false;
    await assert.rejects(adapter({ ...site, type, proxy: { protocol: 'http', host: 'proxy.test', port: 8080 } }, {
      logger: { info(_tag, event) { stages.push(JSON.parse(event)); } },
      apiRequest: createApiRequest(async (url) => {
        if (url.endsWith('/api/status') || url.endsWith('/api/v1/user/profile')) {
          return new Response('private-password', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
        }
        // A failed sibling must not dispose the client or launch a browser mid-flight.
        await new Promise((resolve) => { resolveSibling = resolve; setImmediate(resolveSibling); });
        assert.equal(launched, false);
        assert.equal(lifecycle.some(({ type }) => type === 'disposed'), false);
        return apiResponse(url, { headers: { authorization: 'Bearer valid-token' } });
      }, lifecycle),
      browserType: { launch() {
        launched = true;
        assert.equal(lifecycle.at(-1).type, 'disposed');
        throw new Error('page.evaluate: /api/user/self HTTP 403: Just a moment private-password Bearer valid-token');
      } },
    }), (error) => {
      assert.match(error.message, /API 同步失败.*HTTP 403.*Playwright 兜底失败.*HTTP 403/);
      assert.doesNotMatch(error.message, /private-password|valid-token/);
      assert.equal(error.cause.errors.length, 2);
      return true;
    });
    assert.deepEqual(stages.map(({ stage, result }) => [stage, result]), [
      ['api', 'started'], ['api', 'failed'], ['browser', 'started'], ['browser', 'failed'],
    ]);
    assert.doesNotMatch(JSON.stringify(stages), /private-password|valid-token/);
    assert.match(stages[1].reason, /Cloudflare challenge/);
  });
}

test('new-api proxy login retains separate session/refresh cookies and POST body', async () => {
  const events = [];
  const cookieHeaders = new Headers();
  cookieHeaders.append('set-cookie', 'session=new-session; Path=/; HttpOnly');
  cookieHeaders.append('set-cookie', 'new_api_refresh=refresh-next; Path=/api/user/auth/refresh; HttpOnly');
  const result = await fetchNewApiSnapshot({
    ...site, proxy: { protocol: 'http', host: 'proxy.test', port: 8080 },
  }, {
    logger,
    apiRequest: createApiRequest(async (url, init) => {
      if (url.endsWith('/api/user/login')) {
        assert.deepEqual(JSON.parse(init.body), { username: site.username, password: site.password });
        return new Response(JSON.stringify({ success: true, data: {} }), { headers: cookieHeaders });
      }
      if (init.headers.cookie !== 'session=new-session') {
        return new Response(JSON.stringify({ message: 'expired' }), { status: 401 });
      }
      return apiResponse(url, { headers: { authorization: 'Bearer valid-token' } });
    }, events),
    browserType: { launch() { throw new Error('must not launch'); } },
  });
  assert.equal(result.authUpdate.authToken, 'session=new-session');
  assert.equal(result.normalizedSnapshot.balanceAmount, 7);
  assert.equal(events.at(-1).type, 'disposed');
});

test('new-api response-body timeout falls back after the API attempt', async () => {
  let launches = 0;
  await assert.rejects(fetchNewApiSnapshot(site, {
    logger,
    fetch: async () => ({ status: 200, text: async () => { throw new Error('body timeout'); } }),
    browserType: { launch() { launches++; throw new Error('browser timeout'); } },
  }), /API 同步失败.*timeout.*Playwright 兜底失败.*timeout/);
  assert.equal(launches, 1);
});

test('credential-flow can log in over API without a stored token or browser', async () => {
  const calls = [];
  const result = await fetchSub2ApiFlowSnapshot({ ...site, authToken: '' }, {
    logger,
    fetch: async (url, init) => {
      calls.push(url);
      if (url.endsWith('/api/v1/auth/login')) {
        assert.deepEqual(JSON.parse(init.body), { email: site.username, password: site.password });
        return new Response(JSON.stringify({ data: { access_token: 'valid-token', refresh_token: 'rotated' } }));
      }
      return apiResponse(url, init);
    },
    browserType: { launch() { throw new Error('must not launch'); } },
  });
  assert.ok(calls[0].endsWith('/api/v1/auth/login'));
  assert.equal(result.authUpdate.refreshToken, 'rotated');
  assert.equal(result.normalizedSnapshot.balanceAmount, 7);
});

test('API transport sends real HTTP requests through an authenticated proxy and preserves Set-Cookie', async (t) => {
  const target = createServer((_req, res) => {
    res.writeHead(200, { 'set-cookie': ['session=one; Path=/', 'refresh=two; Path=/auth'] });
    res.end('{"success":true}');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  t.after(() => { target.closeAllConnections(); target.close(); });
  const proxy = createServer();
  const connections = [];
  const sockets = new Set();
  proxy.on('connect', (req, socket, head) => {
    connections.push({ url: req.url, authorization: req.headers['proxy-authorization'] });
    const upstream = connect(target.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket);
    sockets.add(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); proxy.close(); });
  await withUpstreamApi({ proxy: {
    protocol: 'http', host: '127.0.0.1', port: proxy.address().port, username: 'proxy-user', password: 'proxy-pass',
  } }, { timeoutMs: 2000 }, async (fetch) => {
    const response = await fetch('http://upstream.invalid/api/status');
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(await response.text()).success, true);
    assert.deepEqual(response.headers.getSetCookie(), ['session=one; Path=/', 'refresh=two; Path=/auth']);
  });
  assert.deepEqual(connections, [{
    url: 'upstream.invalid:80',
    authorization: `Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`,
  }]);
});

test('API transport supports real SOCKS5 authentication and proxy-side DNS without Chromium', async (t) => {
  const credentials = [];
  const targets = [];
  const sockets = new Set();
  const proxy = createTcpServer((socket) => {
    sockets.add(socket);
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 2]));
        stage = 'auth';
      }
      if (stage === 'auth') {
        if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return;
        const passwordIndex = 2 + buffer[1];
        const length = passwordIndex + 1 + buffer[passwordIndex];
        if (buffer.length < length) return;
        credentials.push([
          buffer.subarray(2, passwordIndex).toString(),
          buffer.subarray(passwordIndex + 1, length).toString(),
        ]);
        buffer = buffer.subarray(length);
        socket.write(Buffer.from([1, 0]));
        stage = 'connect';
      }
      if (stage === 'connect') {
        if (buffer.length < 5 || buffer.length < 7 + buffer[4]) return;
        targets.push({ addressType: buffer[3], host: buffer.subarray(5, 5 + buffer[4]).toString() });
        buffer = buffer.subarray(7 + buffer[4]);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        stage = 'http';
      }
      if (stage === 'http' && buffer.includes('\r\n\r\n')) {
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
      }
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); proxy.close(); });
  await withUpstreamApi({ proxy: {
    protocol: 'socks5', host: '127.0.0.1', port: proxy.address().port, username: 'proxy-user', password: 'p@ss:word',
  } }, { timeoutMs: 2000 }, async (fetch) => {
    assert.equal((await fetch('http://upstream.invalid/api/status')).status, 200);
  });
  assert.deepEqual(credentials, [['proxy-user', 'p@ss:word']]);
  assert.deepEqual(targets, [{ addressType: 3, host: 'upstream.invalid' }]);
});
