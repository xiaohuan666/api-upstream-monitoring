import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROXY_EXPORT_FORMATS,
  buildProxyExportContent,
  buildSub2ApiProxyPayload,
  formatProxyLine,
  proxyExportFormat,
} from '../src/proxy-export.mjs';

const authed = { name: 'a', protocol: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p:x', status: 'active', expiresAt: '2026-10-02T00:00:00.000Z' };
const plain = { name: 'b', protocol: 'http', host: '5.6.7.8', port: 8080, username: '', password: '', status: 'inactive' };

test('export formats mirror the four import shapes plus sub2api JSON', () => {
  assert.deepEqual(
    PROXY_EXPORT_FORMATS.map((format) => format.id),
    ['url-auth', 'url', 'bare-auth', 'bare', 'sub2api-json'],
  );
  assert.equal(proxyExportFormat('bare').extension, 'txt');
  assert.equal(proxyExportFormat('sub2api-json').extension, 'json');
  assert.equal(proxyExportFormat('missing').id, 'url-auth');
});

test('formatProxyLine renders auth variants and drops auth when the format cannot carry it', () => {
  assert.equal(formatProxyLine(authed, 'url-auth'), 'socks5://u:p:x@1.2.3.4:1080');
  assert.equal(formatProxyLine(authed, 'url'), 'socks5://1.2.3.4:1080');
  assert.equal(formatProxyLine(authed, 'bare-auth'), '1.2.3.4:1080:u:p:x');
  assert.equal(formatProxyLine(authed, 'bare'), '1.2.3.4:1080');

  assert.equal(formatProxyLine(plain, 'url-auth'), 'http://5.6.7.8:8080');
  assert.equal(formatProxyLine(plain, 'bare-auth'), '5.6.7.8:8080');
  assert.equal(formatProxyLine(plain, 'sub2api-json'), null);
});

test('buildProxyExportContent joins text formats line by line', () => {
  const content = buildProxyExportContent([authed, plain], 'url-auth');
  assert.equal(content, 'socks5://u:p:x@1.2.3.4:1080\nhttp://5.6.7.8:8080');
});

test('provider metadata leaves every export format unchanged', () => {
  const date = new Date('2026-09-24T00:00:00Z');
  for (const { id } of PROXY_EXPORT_FORMATS) {
    assert.equal(buildProxyExportContent([{ ...authed, provider: '服务商' }], id, date), buildProxyExportContent([authed], id, date));
  }
  assert.equal(Object.hasOwn(buildSub2ApiProxyPayload([{ ...authed, provider: '服务商' }]).proxies[0], 'provider'), false);
});

test('buildSub2ApiProxyPayload matches the sub2api data export shape', () => {
  const exportedAt = new Date('2026-08-29T12:00:00.000Z');
  const payload = buildSub2ApiProxyPayload([authed, plain], exportedAt);

  assert.equal(payload.type, 'sub2api-data');
  assert.equal(payload.version, 1);
  assert.equal(payload.exported_at, '2026-08-29T12:00:00.000Z');
  assert.deepEqual(payload.accounts, []);
  assert.deepEqual(payload.proxies, [
    {
      proxy_key: 'socks5|1.2.3.4|1080|u|p:x',
      name: 'a',
      protocol: 'socks5',
      host: '1.2.3.4',
      port: 1080,
      username: 'u',
      password: 'p:x',
      status: 'active',
      expires_at: Math.floor(Date.parse('2026-10-02T00:00:00.000Z') / 1000),
    },
    {
      proxy_key: 'http|5.6.7.8|8080||',
      name: 'b',
      protocol: 'http',
      host: '5.6.7.8',
      port: 8080,
      status: 'inactive',
    },
  ]);

  const content = buildProxyExportContent([authed], 'sub2api-json', exportedAt);
  assert.deepEqual(JSON.parse(content), buildSub2ApiProxyPayload([authed], exportedAt));
});
