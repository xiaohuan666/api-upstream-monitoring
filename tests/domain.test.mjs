import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyProbe,
  createMockSnapshot,
  normalizeSiteUrl,
  normalizePlatformDisplay,
  summarizeFleet,
} from '../src/domain.mjs';

test('normalizeSiteUrl trims input, removes trailing slashes, and preserves scheme', () => {
  assert.equal(normalizeSiteUrl(' https://api.example.com/// '), 'https://api.example.com');
});

test('normalizeSiteUrl adds https when scheme is missing', () => {
  assert.equal(normalizeSiteUrl('gateway.example.com'), 'https://gateway.example.com');
});

test('normalizeSiteUrl keeps only the root URL and drops paths, query and hash', () => {
  assert.equal(normalizeSiteUrl('https://relay.example.test/keys'), 'https://relay.example.test');
  assert.equal(normalizeSiteUrl('gateway.example.com/base/?a=1#top'), 'https://gateway.example.com');
  assert.equal(normalizeSiteUrl('http://relay.example.com:8443/v1/models'), 'http://relay.example.com:8443');
});

test('classifyProbe maps latency and failures to operational status', () => {
  assert.equal(classifyProbe({ ok: true, latencyMs: 380 }), 'healthy');
  assert.equal(classifyProbe({ ok: true, latencyMs: 1250 }), 'slow');
  assert.equal(classifyProbe({ ok: false, latencyMs: null }), 'down');
});

test('normalizePlatformDisplay maps known platforms to stable labels and keys', () => {
  assert.deepEqual(normalizePlatformDisplay('openai'), { key: 'openai', label: 'OpenAI' });
  assert.deepEqual(normalizePlatformDisplay('Anthropic'), { key: 'anthropic', label: 'Anthropic' });
  assert.deepEqual(normalizePlatformDisplay('claude'), { key: 'anthropic', label: 'Anthropic' });
  assert.deepEqual(normalizePlatformDisplay('grok'), { key: 'grok', label: 'Grok' });
  assert.deepEqual(normalizePlatformDisplay('gemini'), { key: 'gemini', label: 'Gemini' });
  assert.deepEqual(normalizePlatformDisplay('custom-api'), { key: 'openai', label: 'OpenAI' });
});

test('createMockSnapshot returns deterministic balances, groups, token, and probe per site', () => {
  const site = {
    id: 'site-alpha',
    name: 'Alpha Relay',
    url: 'https://alpha.example.com',
    type: 'sub2api',
    username: 'ops@example.com',
  };

  const snapshotA = createMockSnapshot(site);
  const snapshotB = createMockSnapshot(site);

  assert.deepEqual(snapshotA, snapshotB);
  assert.equal(snapshotA.siteId, 'site-alpha');
  assert.equal(typeof snapshotA.balanceCny, 'number');
  assert.ok(snapshotA.groups.length >= 3);
  assert.match(snapshotA.token, /^sk-/);
  assert.ok(['healthy', 'slow', 'down'].includes(snapshotA.probe.status));
});

test('summarizeFleet totals balances in CNY display terms and counts balance alerts', () => {
  const sites = [
    { id: 's-1', name: '美元站', usdToCnyRate: 7, balanceAlert: 100 },
    { id: 's-2', name: '人民币站', usdToCnyRate: 1, balanceAlert: 100 },
    { id: 's-3', name: '无阈值站', usdToCnyRate: 1, balanceAlert: 0 },
  ];
  const snapshots = {
    's-1': { balanceAmount: 10, balanceCurrency: 'USD', groups: [], probe: { status: 'healthy' } },
    's-2': { balanceAmount: 50, balanceCurrency: 'CNY', groups: [{ id: 'g1' }], probe: { status: 'slow' } },
    's-3': { balanceAmount: 5, balanceCurrency: 'CNY', groups: [], probe: { status: 'down' } },
  };

  const summary = summarizeFleet(sites, snapshots);

  // 10 USD * 7 + 50 CNY + 5 CNY = 125 CNY
  assert.equal(summary.balanceCny, 125);
  // s-1 展示 70 < 100 告警；s-2 展示 50 < 100 告警；s-3 无阈值不告警
  assert.equal(summary.balanceAlertCount, 2);
  assert.equal(summary.siteCount, 3);
  assert.equal(summary.groupCount, 1);
  assert.equal(summary.downCount, 1);
  assert.equal(summary.slowCount, 1);
});
