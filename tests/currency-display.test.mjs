import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ceilToScale,
  depletionEtaDisplay,
  depletionEtaMinutes,
  isDepletionAlert,
  displayBalance,
  displayMultiplier,
  formatMultiplier,
} from '../src/currency-display.mjs';

test('a 1 USD to 7 CNY site converts the displayed multiplier and its USD balance', () => {
  const site = { usdToCnyRate: 7 };
  const snapshot = { balanceAmount: 1.87, balanceCurrency: 'USD' };

  assert.equal(displayMultiplier({ site, snapshot, multiplier: 0.039 }), 0.273);
  assert.deepEqual(displayBalance({ site, snapshot }), { amount: 13.09, currency: 'CNY' });
});

test('balance conversion does not introduce binary floating-point display noise', () => {
  const site = { usdToCnyRate: 7.2 };
  const snapshot = { balanceAmount: 595.56, balanceCurrency: 'USD' };

  assert.deepEqual(displayBalance({ site, snapshot }), { amount: 4288.032, currency: 'CNY' });
});

test('multiplier conversion does not introduce binary floating-point display noise', () => {
  const site = { usdToCnyRate: 7 };
  const snapshot = { balanceCurrency: 'USD' };

  assert.equal(displayMultiplier({ site, snapshot, multiplier: 0.1 }), 0.7);
});

test('multiplier formatting preserves all available decimal places without rounding', () => {
  assert.equal(formatMultiplier(0.003), '0.003');
  assert.equal(formatMultiplier(0.039), '0.039');
  assert.equal(formatMultiplier(0.0000001), '0.0000001');
});

test('a 1 USD to 1 CNY site keeps its multiplier and relabels its USD balance as CNY', () => {
  const site = { usdToCnyRate: 1 };
  const snapshot = { balanceAmount: 13.81, balanceCurrency: 'usd' };

  assert.equal(displayMultiplier({ site, snapshot, multiplier: 0.05 }), 0.05);
  assert.deepEqual(displayBalance({ site, snapshot }), { amount: 13.81, currency: 'CNY' });
});

test('an upstream CNY site is never converted by the USD rate', () => {
  const site = { usdToCnyRate: 7 };
  const snapshot = { balanceAmount: 123.35, balanceCurrency: 'CNY' };

  assert.equal(displayMultiplier({ site, snapshot, multiplier: 0.1 }), 0.1);
  assert.deepEqual(displayBalance({ site, snapshot }), { amount: 123.35, currency: 'CNY' });
});

test('ceilToScale rounds up only when extra precision exists', () => {
  assert.equal(ceilToScale('0.18', 4), '0.18');
  assert.equal(ceilToScale('0.18000000000000002', 4), '0.1801');
  assert.equal(ceilToScale('1.152', 4), '1.152');
  assert.equal(ceilToScale('1.15201', 4), '1.1521');
  assert.equal(ceilToScale(0.15, 4), '0.15');
});

test('depletionEtaDisplay extrapolates from two probe balances to hours and minutes', () => {
  // 两次探测间隔 30 分钟，余额 60 → 45，速率 30/小时；45 / 30 = 1.5 小时
  const snapshot = {
    balanceAmount: 45,
    balanceCurrency: 'CNY',
    refreshedAt: '2026-07-04T02:00:00.000Z',
    previousBalance: { amount: 60, currency: 'CNY', refreshedAt: '2026-07-04T01:30:00.000Z' },
  };
  assert.equal(depletionEtaDisplay({ site: {}, snapshot }), '1小时30分钟');
});

test('depletionEtaDisplay shows minutes only when under an hour and rounds to minutes', () => {
  // 间隔 10 分钟消耗 10 → 1/分钟；余 15.4 → 15.4 分钟 ≈ 15分钟
  const snapshot = {
    balanceAmount: 15.4,
    balanceCurrency: 'CNY',
    refreshedAt: '2026-07-04T00:10:00.000Z',
    previousBalance: { amount: 25.4, currency: 'CNY', refreshedAt: '2026-07-04T00:00:00.000Z' },
  };
  assert.equal(depletionEtaDisplay({ site: {}, snapshot }), '15分钟');
});

test('depletionEtaDisplay applies the site USD rate to both probes before diffing', () => {
  // USD 站 1:7：间隔 60 分钟，10 USD → 8 USD（=70 → 56 CNY，消耗 14/小时）；56/14 = 4 小时
  const snapshot = {
    balanceAmount: 8,
    balanceCurrency: 'USD',
    refreshedAt: '2026-07-04T02:00:00.000Z',
    previousBalance: { amount: 10, currency: 'USD', refreshedAt: '2026-07-04T01:00:00.000Z' },
  };
  assert.equal(depletionEtaDisplay({ site: { usdToCnyRate: 7 }, snapshot }), '4小时0分钟');
});

test('depletionEtaDisplay falls back without anchor, top-up, zero rate or error snapshots', () => {
  const base = {
    balanceAmount: 45,
    balanceCurrency: 'CNY',
    refreshedAt: '2026-07-04T02:00:00.000Z',
  };
  assert.equal(depletionEtaDisplay({ site: {}, snapshot: base }), '—');
  assert.equal(depletionEtaDisplay({
    site: {},
    snapshot: { ...base, previousBalance: { amount: 40, currency: 'CNY', refreshedAt: '2026-07-04T01:00:00.000Z' } },
  }), '—');
  assert.equal(depletionEtaDisplay({
    site: {},
    snapshot: { ...base, previousBalance: { amount: 45, currency: 'CNY', refreshedAt: '2026-07-04T01:00:00.000Z' } },
  }), '—');
  assert.equal(depletionEtaDisplay({
    site: {},
    snapshot: { ...base, error: 'boom', previousBalance: { amount: 60, currency: 'CNY', refreshedAt: '2026-07-04T01:00:00.000Z' } },
  }), '—');
  assert.equal(depletionEtaDisplay({
    site: {},
    snapshot: { ...base, previousBalance: { amount: 60, currency: 'CNY', refreshedAt: '2026-07-04T02:00:00.000Z' } },
  }), '—');
});

test('depletionEtaDisplay reports already depleted balances', () => {
  const snapshot = {
    balanceAmount: 0,
    balanceCurrency: 'CNY',
    refreshedAt: '2026-07-04T02:00:00.000Z',
    previousBalance: { amount: 60, currency: 'CNY', refreshedAt: '2026-07-04T01:00:00.000Z' },
  };
  assert.equal(depletionEtaDisplay({ site: {}, snapshot }), '已归0');
});

test('depletion alert uses unrounded time, honors per-site hours and ignores uncomputable estimates', () => {
  const snapshot = {
    balanceAmount: 60,
    balanceCurrency: 'CNY',
    refreshedAt: '2026-07-04T01:00:00.000Z',
    previousBalance: { amount: 120, currency: 'CNY', refreshedAt: '2026-07-04T00:00:00.000Z' },
  };
  assert.equal(depletionEtaMinutes({ site: {}, snapshot }), 60);
  assert.equal(isDepletionAlert({ site: {}, snapshot }), false);
  assert.equal(isDepletionAlert({ site: { depletionAlertHours: 1.5 }, snapshot }), true);
  assert.equal(isDepletionAlert({ site: { depletionAlertHours: 0 }, snapshot }), false);
  assert.equal(isDepletionAlert({ site: { depletionAlertHours: 2 }, snapshot: { ...snapshot, previousBalance: null } }), false);
  assert.equal(isDepletionAlert({ site: { depletionAlertHours: 2 }, snapshot: { ...snapshot, error: 'failed' } }), false);
  assert.equal(isDepletionAlert({ site: {}, snapshot: { ...snapshot, balanceAmount: 0 } }), true);
  const nearBoundary = { ...snapshot, balanceAmount: 60.01 };
  assert.equal(depletionEtaDisplay({ site: {}, snapshot: nearBoundary }), '1小时0分钟');
  assert.equal(isDepletionAlert({ site: {}, snapshot: nearBoundary }), false);
});
