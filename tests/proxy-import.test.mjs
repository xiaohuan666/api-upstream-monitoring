import test from 'node:test';
import assert from 'node:assert/strict';

import { parseProxyImportLine, parseProxyImportText, proxyDedupeKey } from '../src/proxy-import.mjs';

test('parses url format with protocol prefix and auth', () => {
  assert.deepEqual(parseProxyImportLine('socks5://user:pass@192.168.1.1:1080'), {
    protocol: 'socks5',
    host: '192.168.1.1',
    port: 1080,
    username: 'user',
    password: 'pass',
  });
  assert.deepEqual(parseProxyImportLine('http://192.168.1.1:8080'), {
    protocol: 'http',
    host: '192.168.1.1',
    port: 8080,
    username: '',
    password: '',
  });
  assert.equal(parseProxyImportLine('HTTPS://u:p@proxy.example.com:443').protocol, 'https');
  assert.equal(parseProxyImportLine('socks5h://1.2.3.4:1080').protocol, 'socks5h');
});

test('parses bare host:port:user:pass as socks5 by default', () => {
  assert.deepEqual(parseProxyImportLine('1.2.3.4:1080:myuser:mypass'), {
    protocol: 'socks5',
    host: '1.2.3.4',
    port: 1080,
    username: 'myuser',
    password: 'mypass',
  });
  // 密码允许再含冒号
  assert.equal(parseProxyImportLine('1.2.3.4:1080:u:p:a:s:s')?.password, 'p:a:s:s');
});

test('parses bare host:port as socks5 without auth', () => {
  assert.deepEqual(parseProxyImportLine('1.2.3.4:1080'), {
    protocol: 'socks5',
    host: '1.2.3.4',
    port: 1080,
    username: '',
    password: '',
  });
});

test('rejects empty, malformed and out-of-range lines', () => {
  assert.equal(parseProxyImportLine(''), null);
  assert.equal(parseProxyImportLine('   '), null);
  assert.equal(parseProxyImportLine('not-a-proxy'), null);
  assert.equal(parseProxyImportLine('ftp://1.2.3.4:21'), null);
  assert.equal(parseProxyImportLine('1.2.3.4:0'), null);
  assert.equal(parseProxyImportLine('1.2.3.4:65536'), null);
  assert.equal(parseProxyImportLine('1.2.3.4:abc'), null);
  assert.equal(parseProxyImportLine(':1080'), null);
});

test('parseProxyImportText dedupes within batch and counts outcomes', () => {
  const result = parseProxyImportText([
    'socks5://u:p@1.2.3.4:1080',
    '1.2.3.4:1080:u:p', // 与上一行同 host:port:user:pass
    '2.3.4.5:8080:root:toor',
    'bad-line',
    '',
    '2.3.4.5:8080:root:toor', // 文本内重复
  ].join('\n'));

  assert.equal(result.total, 5);
  assert.equal(result.valid, 2);
  assert.equal(result.invalid, 1);
  assert.equal(result.duplicate, 2);
  assert.deepEqual(result.proxies, [
    { protocol: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' },
    { protocol: 'socks5', host: '2.3.4.5', port: 8080, username: 'root', password: 'toor' },
  ]);
});

test('proxy dedupe preserves credential boundaries and existing endpoint identity', () => {
  assert.notEqual(
    proxyDedupeKey({ host: 'proxy', port: 80, username: 'alice:x', password: 'y' }),
    proxyDedupeKey({ host: 'proxy', port: 80, username: 'alice', password: 'x:y' }),
  );
  assert.equal(
    proxyDedupeKey({ host: 'proxy', port: '80', username: null, password: null, protocol: 'http' }),
    proxyDedupeKey({ host: 'proxy', port: 80, username: '', password: '', protocol: 'socks5' }),
  );
});

test('import preview excludes existing connections before naming regardless of provider or protocol', () => {
  const existing = [{ host: '192.0.2.1', port: 1080, username: 'u', password: 'p', provider: 'old', name: 'old-001' }];
  const result = parseProxyImportText('http://u:p@192.0.2.1:1080\n192.0.2.2:1080:u:p\n192.0.2.2:1080:u:p\n192.0.2.1:1080:u:different', existing);
  assert.equal(result.duplicate, 2);
  assert.equal(result.valid, 2);
  assert.deepEqual(result.proxies.map(({ host, password }) => [host, password]), [['192.0.2.2', 'p'], ['192.0.2.1', 'different']]);
});

test('encoded URL credentials match their decoded stored identity', () => {
  const existing = [{ host: 'proxy.test', port: 80, username: 'a:b', password: 'p@ss' }];
  assert.equal(parseProxyImportText('http://a%3Ab:p%40ss@proxy.test:80', existing).valid, 0);
  assert.equal(parseProxyImportLine('http://u:%xx@proxy.test:80'), null);
});


test('URL imports require an explicit port including HTTP default ports', () => {
  for (const protocol of ['http', 'https', 'socks5', 'socks5h']) {
    assert.equal(parseProxyImportLine(`${protocol}://u:p@proxy.test`), null);
    assert.equal(parseProxyImportLine(`${protocol}://[2001:db8::1]`), null);
  }
  assert.equal(parseProxyImportLine('http://proxy.test:80').port, 80);
  assert.equal(parseProxyImportLine('https://proxy.test:443/').port, 443);
  assert.equal(parseProxyImportLine('http://[2001:db8::1]:80').port, 80);
});

test('IPv6 imports dedupe equivalent host spellings against existing and batch entries', () => {
  const existing = [{ host: '[2001:0DB8:0000:0:0:0:0:1]', port: 1080, username: 'u', password: 'p' }];
  const result = parseProxyImportText([
    'socks5://u:p@[2001:db8::1]:1080',
    'socks5://u:p@[2001:db8::2]:1080',
    'http://u:p@[2001:0db8:0:0:0:0:0:2]:1080',
  ].join('\n'), existing);
  assert.equal(result.duplicate, 2);
  assert.equal(result.valid, 1);
  assert.equal(result.proxies[0].host, '2001:db8::2');
  assert.equal(proxyDedupeKey(existing[0]), proxyDedupeKey({ ...existing[0], host: '2001:db8::1' }));
});

test('URL encoded password spaces remain significant in import and deduplication', () => {
  const line = 'socks5h://u:%20p%20@proxy.test:1080';
  const parsed = parseProxyImportLine(line);
  assert.equal(parsed.password, ' p ');
  assert.equal(parseProxyImportText(line, [{ ...parsed, password: 'p' }]).valid, 1);
  assert.equal(parseProxyImportText(line, [parsed]).duplicate, 1);
});
