import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { requestThroughProxy, probeProxy, createProxyProbeService } from '../src/proxy-probe.mjs';

async function proxyServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { protocol: 'http', host: '127.0.0.1', port: server.address().port, username: 'alice', password: 'p@ss:"word\\x' };
}

test('curl traverses saved HTTP proxy with authentication and returns its exit location', async (t) => {
  let requests = 0;
  const proxy = await proxyServer(t, (req, res) => {
    requests++;
    assert.equal(req.url, 'http://probe.invalid/json');
    assert.equal(req.headers['proxy-authorization'], 'Basic ' + Buffer.from('alice:p@ss:"word\\x').toString('base64'));
    res.end(JSON.stringify({ status: 'success', query: '203.0.113.8', country: '美国', regionName: '加利福尼亚', city: '洛杉矶' }));
  });
  const result = await probeProxy(proxy, { targets: [{ url: 'http://probe.invalid/json', parser: 'ip-api' }] });
  assert.equal(requests, 1);
  assert.equal(result.ok, true);
  assert.equal(result.city, '洛杉矶');
  assert.equal(result.ip, '203.0.113.8');
  assert.ok(result.latencyMs >= 0);
});

test('geo failure falls back through the same proxy and preserves unknown location', async (t) => {
  const urls = [];
  const proxy = await proxyServer(t, (req, res) => {
    urls.push(req.url);
    if (req.url.endsWith('/geo')) { res.statusCode = 429; res.end('rate limited'); }
    else res.end(JSON.stringify({ ip: '2001:db8::2' }));
  });
  const result = await probeProxy(proxy, { targets: [{ url: 'http://probe.invalid/geo', parser: 'ip-api' }, { url: 'http://probe.invalid/ip', parser: 'ipify' }] });
  assert.deepEqual(urls, ['http://probe.invalid/geo', 'http://probe.invalid/ip']);
  assert.equal(result.ok, true);
  assert.equal(result.country, '');
  assert.equal(result.ip, '2001:db8::2');
});

test('invalid exit bodies and failed authentication never pass or expose credentials', async (t) => {
  const proxy = await proxyServer(t, (req, res) => { res.statusCode = 407; res.end('secret-password'); });
  const result = await probeProxy(proxy, { targets: [{ url: 'http://probe.invalid/json', parser: 'ip-api' }] });
  assert.equal(result.ok, false);
  assert.equal(result.ip, '');
  assert.doesNotMatch(JSON.stringify(result), /secret-password|word/);
  assert.equal((await probeProxy(proxy, { request: async () => '{"status":"success","query":"not-an-ip"}' })).ok, false);
});

test('probe transport bounds response size and duration', async (t) => {
  const proxy = await proxyServer(t, (req, res) => {
    if (req.url.endsWith('/large')) res.end('a'.repeat(70000));
  });
  await assert.rejects(requestThroughProxy(proxy, 'http://probe.invalid/large'), /响应过大/);
  await assert.rejects(requestThroughProxy(proxy, 'http://probe.invalid/hang', { timeoutMs: 100 }), /超时/);
});

test('service deduplicates in-flight tests, bounds concurrency and rejects stale writes', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const saved = [];
  const service = createProxyProbeService({ concurrency: 2, repository: {
    async getProxyById(id) { return id === 'missing' ? null : { id }; },
    async saveProxyProbe(proxy, result) { saved.push(proxy.id); return proxy.id !== 'edited'; },
  }, probe: async () => { calls++; active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 10)); active--; return { ok: true }; } });
  const first = service.test('a');
  assert.equal(service.test('a'), first);
  await Promise.all([first, service.test('b'), service.test('c')]);
  assert.equal(calls, 3);
  assert.equal(peak, 2);
  assert.deepEqual(saved.sort(), ['a', 'b', 'c']);
  await assert.rejects(service.test('edited'), (error) => error.statusCode === 409);
  await assert.rejects(service.test('missing'), (error) => error.statusCode === 404);
});

test('authenticated SOCKS5 and SOCKS5H probes use the selected server', async (t) => {
  const { createServer: createTCPServer } = await import('node:net');
  for (const protocol of ['socks5', 'socks5h']) {
    let authed = false;
    let requested = false;
    const sockets = new Set();
    const server = createTCPServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      let stage = 0;
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 0) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          buffer = buffer.subarray(2 + buffer[1]);
          socket.write(Buffer.from([5, 2]));
          stage = 1;
        }
        if (stage === 1) {
          if (buffer.length < 2) return;
          const userEnd = 2 + buffer[1];
          if (buffer.length <= userEnd || buffer.length < userEnd + 1 + buffer[userEnd]) return;
          const end = userEnd + 1 + buffer[userEnd];
          assert.equal(buffer.subarray(2, userEnd).toString(), 'user:name');
          assert.equal(buffer.subarray(userEnd + 1, end).toString(), ' p@ss:%/ word ');
          authed = true;
          buffer = buffer.subarray(end);
          socket.write(Buffer.from([1, 0]));
          stage = 2;
        }
        if (stage === 2) {
          if (buffer.length < 5) return;
          const size = buffer[3] === 1 ? 10 : buffer[3] === 4 ? 22 : 7 + buffer[4];
          if (buffer.length < size) return;
          if (protocol === 'socks5h') assert.equal(buffer[3], 3);
          buffer = buffer.subarray(size);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          stage = 3;
        }
        if (stage === 3 && buffer.includes('\r\n\r\n')) {
          requested = true;
          const body = JSON.stringify({ status: 'success', query: '203.0.113.10', country: '测试地区' });
          socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
          stage = 4;
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const proxy = { protocol, host: '127.0.0.1', port: server.address().port, username: 'user:name', password: ' p@ss:%/ word ' };
      const url = protocol === 'socks5h' ? 'http://probe.invalid/geo' : 'http://198.51.100.6/geo';
      const result = await probeProxy(proxy, { targets: [{ url, parser: 'ip-api' }] });
      assert.equal(result.ok, true, protocol);
      assert.equal(authed && requested, true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
