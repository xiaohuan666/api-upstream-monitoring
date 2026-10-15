import test from 'node:test';
import assert from 'node:assert/strict';

import { modelTestDisplay } from '../src/model-test-display.mjs';

test('modelTestDisplay marks failed tests as red down state', () => {
  assert.deepEqual(
    modelTestDisplay({ status: 'down', responseTimeMs: 1200 }),
    { tone: 'down', label: '不通' },
  );
  assert.deepEqual(
    modelTestDisplay({ status: 'failed', responseTimeMs: 1200 }),
    { tone: 'down', label: '不通' },
  );
});

test('modelTestDisplay classifies latency thresholds', () => {
  assert.deepEqual(
    modelTestDisplay({ status: 'healthy', responseTimeMs: 2999 }),
    { tone: 'fast', label: '快' },
  );
  assert.deepEqual(
    modelTestDisplay({ status: 'healthy', responseTimeMs: 3000 }),
    { tone: 'normal', label: '正常' },
  );
  assert.deepEqual(
    modelTestDisplay({ status: 'healthy', responseTimeMs: 4999 }),
    { tone: 'normal', label: '正常' },
  );
  assert.deepEqual(
    modelTestDisplay({ status: 'slow', responseTimeMs: 5000 }),
    { tone: 'slow', label: '慢' },
  );
});

test('modelTestDisplay keeps unknown results neutral', () => {
  assert.deepEqual(
    modelTestDisplay(null),
    { tone: 'unknown', label: '未知' },
  );
});
