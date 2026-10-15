import test from 'node:test';
import assert from 'node:assert/strict';

import { createServerLifecycle } from '../src/server-lifecycle.mjs';

test('server startup applies persisted auto-refresh settings before listening', async () => {
  const calls = [];
  const loaded = deferred();
  const applyStarted = deferred();
  const applyCanFinish = deferred();
  const persistedSettings = { enabled: true, intervalValue: 15, intervalUnit: 'minutes' };
  const lifecycle = createServerLifecycle({
    loadAutoRefreshSettings: async () => {
      calls.push('load-started');
      return await loaded.promise;
    },
    applyAutoRefreshSettings: async (settings) => {
      calls.push(['apply', settings]);
      applyStarted.resolve();
      await applyCanFinish.promise;
    },
    listen: () => {
      calls.push('listen');
    },
    stopScheduler: () => {},
    closeServer: () => {},
    closePool: async () => {},
    exit: () => {},
  });

  const starting = lifecycle.start();
  await Promise.resolve();
  assert.deepEqual(calls, ['load-started']);

  loaded.resolve({ preferences: persistedSettings });
  await applyStarted.promise;
  assert.deepEqual(calls, [
    'load-started',
    ['apply', persistedSettings],
  ]);

  applyCanFinish.resolve();
  await starting;
  assert.deepEqual(calls, [
    'load-started',
    ['apply', persistedSettings],
    'listen',
  ]);
});

test('server startup awaits disabled fallback application before listening after load failure', async () => {
  const calls = [];
  const fallbackApplyStarted = deferred();
  const fallbackApplyCanFinish = deferred();
  const lifecycle = createServerLifecycle({
    loadAutoRefreshSettings: async () => {
      calls.push('load-started');
      throw new Error('settings unavailable');
    },
    applyAutoRefreshSettings: async (settings) => {
      calls.push(['apply', settings]);
      fallbackApplyStarted.resolve();
      await fallbackApplyCanFinish.promise;
    },
    listen: () => {
      calls.push('listen');
    },
    stopScheduler: () => {},
    closeServer: () => {},
    closePool: async () => {},
    exit: () => {},
    logger: { error: (message) => calls.push(['error', message]) },
  });

  const starting = lifecycle.start();
  await fallbackApplyStarted.promise;
  assert.deepEqual(calls, [
    'load-started',
    ['error', '[auto-refresh] load settings failed: settings unavailable'],
    ['apply', { enabled: false }],
  ]);

  fallbackApplyCanFinish.resolve();
  await starting;
  assert.deepEqual(calls, [
    'load-started',
    ['error', '[auto-refresh] load settings failed: settings unavailable'],
    ['apply', { enabled: false }],
    'listen',
  ]);
});

test('registered signal shutdown stops scheduling before server, pool, and process teardown', async () => {
  const calls = [];
  const handlers = new Map();
  const lifecycle = createServerLifecycle({
    loadAutoRefreshSettings: async () => ({ preferences: { enabled: false } }),
    applyAutoRefreshSettings: async () => {},
    listen: () => {},
    stopScheduler: () => {
      calls.push('scheduler-stop');
    },
    closeServer: () => {
      calls.push('server-close');
    },
    closePool: async () => {
      calls.push('pool-close');
    },
    exit: (code) => {
      calls.push(['exit', code]);
    },
    registerSignal: (signal, handler) => {
      handlers.set(signal, handler);
    },
  });

  lifecycle.registerShutdownSignals();
  assert.deepEqual([...handlers.keys()], ['SIGINT', 'SIGTERM']);

  await handlers.get('SIGTERM')();
  assert.deepEqual(calls, [
    'scheduler-stop',
    'server-close',
    'pool-close',
    ['exit', 0],
  ]);
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
