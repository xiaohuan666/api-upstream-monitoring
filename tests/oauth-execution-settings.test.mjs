import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OAUTH_EXECUTION_CONCURRENCY, OAUTH_EXECUTION_LIMITS, validateOAuthExecutionSettings,
  createOAuthExecutionSettingsStore, readOAuthExecutionSettings } from '../src/oauth-execution-settings.mjs';

test('execution settings default to five with integer bounds distinct from import concurrency', () => {
  assert.equal(DEFAULT_OAUTH_EXECUTION_CONCURRENCY, 5);
  assert.deepEqual(OAUTH_EXECUTION_LIMITS, { min: 1, max: 20 });
  for (const concurrency of [1, 5, 20]) assert.deepEqual(validateOAuthExecutionSettings({ concurrency }), { concurrency });
});

test('execution settings reject unknown fields and noninteger values without coercion', () => {
  for (const input of [null, [], {}, '5', { concurrency: 5, extra: true }, ...[0, 21, -1, 1.5, '5', null, NaN, Infinity, undefined].map(concurrency => ({ concurrency }))]) {
    assert.throws(() => validateOAuthExecutionSettings(input), { code: 'INVALID_OAUTH_SETTINGS', statusCode: 400 });
  }
});

test('missing settings fail closed rather than silently allocating default slots', async () => {
  await assert.rejects(readOAuthExecutionSettings({ async query() { return { rows: [] }; } }), { code: 'OAUTH_SETTINGS_UNAVAILABLE', statusCode: 503 });
  await assert.rejects(readOAuthExecutionSettings({ async query() { throw new Error('db offline'); } }), /db offline/);
});

test('settings save validates before connecting and rolls back a failed write while releasing client', async () => {
  const calls = [];
  const store = createOAuthExecutionSettingsStore({ async connect() { calls.push('connect'); return {
    async query(sql) { calls.push(sql); if (sql.startsWith('insert')) throw new Error('write failed'); },
    release() { calls.push('release'); },
  }; } });
  await assert.rejects(store.saveExecutionSettings({ concurrency: 0 }), { code: 'INVALID_OAUTH_SETTINGS' });
  assert.deepEqual(calls, []);
  await assert.rejects(store.saveExecutionSettings({ concurrency: 3 }), /write failed/);
  assert.equal(calls[1], 'begin');
  assert.match(calls[2], /pg_advisory_xact_lock.*oauth-onboarding-admission/);
  assert.deepEqual(calls.slice(-2), ['rollback', 'release']);
});
