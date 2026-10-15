import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runBrowserTask } from '../src/upstreams/browser-task.mjs';
import { fetchNewApiSnapshot } from '../src/upstreams/newapi.mjs';
import { fetchSub2ApiSnapshot } from '../src/upstreams/sub2api.mjs';
import { fetchSub2ApiFlowSnapshot } from '../src/upstreams/sub2api-flow.mjs';

const never = () => new Promise(() => {});
const logger = { info() {} };
function fakeBrowser({ launch, newContext, close } = {}) {
  const state = { closes: 0, launches: [] };
  const browser = {
    newContext: newContext ?? (async () => ({})),
    async close() { state.closes++; await close?.(state.closes); },
  };
  const browserType = {
    async launch(options) { state.launches.push(options); return launch ? await launch(browser) : browser; },
  };
  return { browserType, state, browser };
}

const budgets = { timeoutMs: 60, launchTimeoutMs: 40, cleanupTimeoutMs: 30 };

test('browser task returns the original result only after closing its browser', async () => {
  const { browserType, state } = fakeBrowser();
  const result = { authUpdate: { authToken: 'fixture-rotated' }, groupsComplete: false };
  assert.equal(await runBrowserTask({ ...budgets, browserType }, async () => result), result);
  assert.equal(state.closes, 1);
  assert.equal(state.launches[0].timeout, 40);
});

test('browser task preserves operation/auth errors and closes the browser', async () => {
  const { browserType, state } = fakeBrowser();
  const failure = new Error('/api/v1/auth/refresh HTTP 401');
  await assert.rejects(runBrowserTask({ ...budgets, browserType }, async () => { throw failure; }), (e) => e === failure);
  assert.equal(state.closes, 1);
});

test('browser task closes a hanging evaluate and the next task succeeds', async () => {
  const { browserType, state } = fakeBrowser();
  await assert.rejects(runBrowserTask({ ...budgets, browserType }, never), { code: 'BROWSER_TASK_TIMEOUT', stage: 'task' });
  assert.equal(state.closes, 1);
  assert.equal(await runBrowserTask({ ...budgets, browserType }, async () => 'next'), 'next');
  assert.equal(state.closes, 2);
});

test('context creation is covered by the complete task deadline', async () => {
  const { browserType, state } = fakeBrowser({ newContext: never });
  await assert.rejects(runBrowserTask({ ...budgets, browserType }, (browser) => browser.newContext()), { stage: 'task' });
  assert.equal(state.closes, 1);
});

test('launch errors preserve their identity', async () => {
  const failure = new Error('fixture launch failed');
  const { browserType } = fakeBrowser({ launch() { throw failure; } });
  await assert.rejects(runBrowserTask({ ...budgets, browserType }, never), (e) => e === failure);
});

test('hanging injected launch is bounded and a late fake browser is closed without running a task', async () => {
  let release;
  const { browserType, state } = fakeBrowser({ launch: () => new Promise((resolve) => { release = resolve; }) });
  let ran = false;
  await assert.rejects(runBrowserTask({ ...budgets, browserType }, () => { ran = true; }), { stage: 'launch' });
  release({ async close() { state.closes++; } });
  await delay(5);
  assert.equal(state.closes, 1);
  assert.equal(ran, false);
});

test('total deadline can expire before launch deadline without running a late task', async () => {
  const { browserType, state } = fakeBrowser({ launch: async (browser) => { await delay(45); return browser; } });
  let ran = false;
  await assert.rejects(runBrowserTask({ ...budgets, timeoutMs: 20, launchTimeoutMs: 100, browserType }, () => { ran = true; }), { stage: 'task' });
  await delay(60);
  assert.equal(state.closes, 1);
  assert.equal(ran, false);
});

test('hanging graceful cleanup escalates and awaits forced cleanup', async () => {
  const { browserType, state } = fakeBrowser({ close: (attempt) => attempt === 1 ? never() : undefined });
  const events = [];
  assert.equal(await runBrowserTask({ ...budgets, browserType, logger: { info: (...e) => events.push(e) } }, async () => 42), 42);
  assert.equal(state.closes, 2);
  assert.match(JSON.stringify(events), /force-kill/);
});

test('unexpected owner exit requires forced cleanup before publishing a collected snapshot', async () => {
  const failure = Object.assign(new Error('owner exited without cleanup'), { code: 'BROWSER_OWNER_EXITED' });
  const { browserType, state } = fakeBrowser({ close(attempt) { if (attempt === 1) throw failure; } });
  const snapshot = { normalizedSnapshot: { balanceAmount: 7 } };
  assert.equal(await runBrowserTask({ ...budgets, browserType }, async () => snapshot), snapshot);
  assert.equal(state.closes, 2, 'owner failure still runs forced reclamation');
});

test('owner exit without confirmed forced reclamation cannot publish a snapshot', async () => {
  const ownerFailure = Object.assign(new Error('owner exited without cleanup'), { code: 'BROWSER_OWNER_EXITED' });
  const { browserType, state } = fakeBrowser({ close(attempt) { if (attempt === 1) throw ownerFailure; return never(); } });
  await assert.rejects(runBrowserTask({ ...budgets, browserType }, async () => ({ normalizedSnapshot: { balanceAmount: 7 } })), { code: 'BROWSER_TASK_TIMEOUT', stage: 'reap' });
  assert.equal(state.closes, 2);
});

test('forced reclamation after owner loss preserves the original task error', async () => {
  const ownerFailure = Object.assign(new Error('owner exited without cleanup'), { code: 'BROWSER_OWNER_EXITED' });
  const taskFailure = new Error('fixture auth rejected');
  const { browserType, state } = fakeBrowser({ close(attempt) { if (attempt === 1) throw ownerFailure; } });
  await assert.rejects(runBrowserTask({ ...budgets, browserType }, async () => { throw taskFailure; }), (e) => e === taskFailure);
  assert.equal(state.closes, 2);
});

test('a throwing diagnostic logger cannot skip browser cleanup', async () => {
  const { browserType, state } = fakeBrowser();
  await assert.rejects(runBrowserTask({
    ...budgets, browserType, logger: { info() { throw new Error('logger unavailable'); } },
  }, never), { stage: 'task' });
  assert.equal(state.closes, 1);
});

test('cleanup failure cannot publish a snapshot or replace an auth error', async () => {
  const { browserType } = fakeBrowser({ close: never });
  const failure = new Error('fixture auth rejected');
  await assert.rejects(runBrowserTask({ ...budgets, browserType }, async () => { throw failure; }), (e) => {
    assert.ok(e instanceof AggregateError);
    assert.equal(e.errors[0], failure);
    assert.equal(e.errors[1].stage, 'reap');
    return true;
  });
  await assert.rejects(runBrowserTask({ ...budgets, browserType }, async () => ({ snapshot: 'must not publish' })), { stage: 'reap' });
});

test('browser deadline cannot be disabled accidentally', async () => {
  for (const timeoutMs of [0, -1, Infinity, NaN, 2 ** 31]) {
    await assert.rejects(runBrowserTask({ timeoutMs }, never), RangeError);
  }
});

const site = {
  id: 'local-fixture', url: 'http://127.0.0.1:1', authToken: 'fixture-token',
  username: 'fixture@example.invalid', password: 'fixture-password', userId: '1',
};
const challenge = async () => new Response('<html>Just a moment</html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
for (const [name, adapter] of [
  ['newapi', fetchNewApiSnapshot], ['sub2api', fetchSub2ApiSnapshot], ['sub2api-flow', fetchSub2ApiFlowSnapshot],
]) {
  test(`${name} browser fallback bounds a hung evaluate without returning a partial snapshot`, async () => {
    const { browserType, state } = fakeBrowser({
      newContext: async () => ({
        addCookies: async () => {},
        newPage: async () => ({ url: () => site.url, goto: async () => {}, evaluate: never }),
      }),
    });
    await assert.rejects(adapter(site, {
      fetch: challenge, browserType, timeoutMs: 60, browserCleanupTimeoutMs: 30, logger,
    }), (e) => {
      assert.match(e.message, /Playwright.*timeout/);
      assert.equal(e.cause.errors[1].code, 'BROWSER_TASK_TIMEOUT');
      return true;
    });
    assert.equal(state.closes, 1);
  });
}
