import test from 'node:test';
import assert from 'node:assert/strict';
import { loginWithChallengeRetry, OAUTH_CHALLENGE_RETRY_DELAY_MS } from '../src/oauth-login-retry.mjs';

function harness(overrides = {}) {
  const controller = new AbortController();
  const events = [];
  const options = {
    signal: controller.signal,
    async prepare(attempt) { events.push(['prepare', attempt]); return { sessionId: `session-${attempt}`, loginInput: { authUrl: `auth-${attempt}` } }; },
    async login(input) { events.push(['login', input.authUrl]); return { code: 'accepted' }; },
    async onChallenge(_error, attempt) { events.push(['challenge', attempt]); },
    async onRetry() { events.push(['retry']); },
    async wait(ms, signal) { events.push(['wait', ms]); assert.equal(signal, controller.signal); },
    ...overrides,
  };
  return { controller, options, events };
}
const challenge = () => Object.assign(new Error('challenge'), { safe: true, code: 'OAUTH_HTTP_CHALLENGE' });

test('one challenge waits before preparing a fresh login transaction, without replaying the old URL', async () => {
  const h = harness();
  h.options.login = async ({ authUrl }) => { h.events.push(['login', authUrl]); if (authUrl === 'auth-1') throw challenge(); return { code: 'second-code' }; };
  const result = await loginWithChallengeRetry(h.options);
  assert.equal(result.sessionId, 'session-2'); assert.equal(result.attempt, 2);
  assert.deepEqual(h.events, [['prepare', 1], ['login', 'auth-1'], ['challenge', 1], ['retry'], ['wait', OAUTH_CHALLENGE_RETRY_DELAY_MS], ['prepare', 2], ['login', 'auth-2']]);
});

test('second challenge stops; two login attempts and one wait is the hard limit', async () => {
  const h = harness({ login: async () => { throw challenge(); } });
  await assert.rejects(loginWithChallengeRetry(h.options), { code: 'OAUTH_HTTP_CHALLENGE' });
  assert.deepEqual(h.events.filter(([name]) => name === 'prepare'), [['prepare', 1], ['prepare', 2]]);
  assert.equal(h.events.filter(([name]) => name === 'wait').length, 1);
});

for (const code of ['OAUTH_NETWORK_ERROR', 'OAUTH_HTTP_REJECTED', 'OAUTH_INVALID_CREDENTIALS', 'OAUTH_TOTP_REJECTED', 'OAUTH_EMAIL_OTP_REQUIRED', 'OAUTH_VERIFICATION_REQUIRED', 'OAUTH_SENTINEL_FAILED', 'OAUTH_TIMEOUT']) {
  test(`${code} is not automatically retried`, async () => {
    const error = Object.assign(new Error(code), { safe: true, code });
    const h = harness({ login: async () => { throw error; } });
    await assert.rejects(loginWithChallengeRetry(h.options), error);
    assert.deepEqual(h.events, [['prepare', 1]]);
  });
}

test('an untrusted challenge string does not authorize a retry', async () => {
  const error = Object.assign(new Error('raw'), { code: 'OAUTH_HTTP_CHALLENGE' });
  const h = harness({ login: async () => { throw error; } });
  await assert.rejects(loginWithChallengeRetry(h.options), error);
  assert.deepEqual(h.events, [['prepare', 1]]);
});

test('preparation errors including similarly named challenges are never retried', async () => {
  const h = harness({ prepare: async () => { throw challenge(); } });
  await assert.rejects(loginWithChallengeRetry(h.options), { code: 'OAUTH_HTTP_CHALLENGE' });
  assert.deepEqual(h.events, []);
});

test('production delay is cancellable without starting the second attempt', async () => {
  const h = harness({ login: async () => { throw challenge(); }, wait: undefined });
  h.options.onRetry = async () => { setImmediate(() => h.controller.abort()); };
  await assert.rejects(loginWithChallengeRetry(h.options), { code: 'TASK_INTERRUPTED' });
  assert.deepEqual(h.events, [['prepare', 1], ['challenge', 1]]);
});

test('failed retry-state persistence cannot authorize a second login', async () => {
  const error = new Error('lease failure');
  const h = harness({ login: async () => { throw challenge(); }, onRetry: async () => { throw error; } });
  await assert.rejects(loginWithChallengeRetry(h.options), error);
  assert.deepEqual(h.events, [['prepare', 1], ['challenge', 1]]);
});

test('cancellation during preparation stops login, and after callback stops exchange delivery', async () => {
  const h = harness();
  const prepare = h.options.prepare;
  h.options.prepare = async (attempt) => { h.controller.abort(); return prepare(attempt); };
  await assert.rejects(loginWithChallengeRetry(h.options), { code: 'TASK_INTERRUPTED' });
  assert.deepEqual(h.events, [['prepare', 1]]);
  const g = harness();
  g.options.login = async () => { g.controller.abort(); return { code: 'accepted' }; };
  await assert.rejects(loginWithChallengeRetry(g.options), { code: 'TASK_INTERRUPTED' });
});

test('first-attempt success does not delay or perform any retry work', async () => {
  const h = harness();
  const result = await loginWithChallengeRetry(h.options);
  assert.equal(result.attempt, 1); assert.equal(result.sessionId, 'session-1');
  assert.deepEqual(h.events, [['prepare', 1], ['login', 'auth-1']]);
});
