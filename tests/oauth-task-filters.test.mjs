import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOAuthOnboardingService } from '../src/oauth-onboarding.mjs';
import { handleOAuthOnboarding } from '../src/oauth-onboarding-http.mjs';
import { createOAuthTaskHistoryStore } from '../src/oauth-task-history-store.mjs';

const SITE = '11111111-1111-4111-8111-111111111111';
const CURSOR = '22222222-2222-4222-8222-222222222222';
const STATES = ['queued', 'running', 'pushing', 'succeeded', 'failed', 'needs_attention', 'uncertain'];
function readService(store) {
  return createOAuthOnboardingService({ store, credentialVault: {}, mySiteRepository: {}, proxyRepository: {}, mySiteProxyRepository: {} });
}

test('read-list validation normalizes only whitelisted filters before any store call', async () => {
  const calls = [];
  const service = readService({ async expireStale() { calls.push('expire'); }, async listBatches(params) { calls.push(params); return { batches: [], nextCursor: null }; } });
  const expected = { email: 'literal%_@example.test', before: CURSOR, status: 'uncertain', mySiteId: SITE,
    createdFrom: '2026-10-01T00:00:00.100Z', createdBefore: '2026-10-08T00:00:00.000Z' };
  await service.listBatches({ ...expected, email: ' Literal%_@Example.Test ', createdFrom: '2026-10-01T00:00:00.1Z', createdBefore: '2026-10-08T00:00:00Z' });
  assert.deepEqual(calls, ['expire', expected]);
  calls.length = 0;
  for (const status of STATES) await service.listBatches({ status });
  assert.deepEqual(calls.filter((call) => typeof call === 'object').map((call) => call.status), STATES);
  calls.length = 0;
  for (const input of [
    null, [], { unknown: 'ignored' }, { email: 'x'.repeat(255) }, { email: 1 }, { before: 'not-uuid' },
    { status: "failed' OR true --" }, { status: 'active' }, { status: 1 }, { mySiteId: 'anything' }, { mySiteId: [] },
    { createdFrom: '2026-02-30T00:00:00Z' }, { createdFrom: '2026-02-29T00:00:00Z' },
    { createdFrom: '0000-01-01T00:00:00Z' }, { createdFrom: '2026-10-01' }, { createdFrom: 'infinity' },
    { createdFrom: '2026-10-01T00:00:00+08:00' }, { createdBefore: 0 }, { createdBefore: '2026-10-01T24:00:00Z' },
    { createdFrom: '2026-10-02T00:00:00Z', createdBefore: '2026-10-01T00:00:00Z' },
    { createdFrom: '2026-10-01T00:00:00Z', createdBefore: '2026-10-01T00:00:00Z' },
  ]) await assert.rejects(service.listBatches(input), { code: 'INVALID_PAGE', statusCode: 400 });
  assert.deepEqual(calls, [], 'invalid filters must not expire or query history');
  await service.listBatches({ status: '', mySiteId: '', createdFrom: '', createdBefore: '' });
  assert.deepEqual(calls[1], { email: '', before: null, status: null, mySiteId: null, createdFrom: null, createdBefore: null });
});

test('HTTP list forwards allowed filters, rejects duplicate/unknown keys, and never silently ignores failed filters', async (t) => {
  const calls = [];
  const service = readService({ async expireStale() {}, async listBatches(query) { calls.push(query); return { batches: [], nextCursor: null }; } });
  const server = createServer((req, res) => { void handleOAuthOnboarding(req, res, new URL(req.url, 'http://localhost'), service); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/oauth-onboarding/batches`;
  const params = { email: '100%_', before: CURSOR, status: 'failed', mySiteId: SITE,
    createdFrom: '2026-10-01T00:00:00.000Z', createdBefore: '2026-10-08T00:00:00.000Z' };
  const response = await fetch(`${endpoint}?${new URLSearchParams(params)}`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { batches: [], nextCursor: null });
  assert.deepEqual(calls, [params]);
  calls.length = 0;
  for (const query of ['status=failed&status=succeeded', 'unexpected=true', 'status=made_up', 'mySiteId=not-a-uuid', 'createdFrom=2026-02-30T00%3A00%3A00Z']) {
    const invalid = await fetch(`${endpoint}?${query}`);
    assert.equal(invalid.status, 400); assert.equal(invalid.headers.get('cache-control'), 'no-store');
    assert.equal((await invalid.json()).code, 'INVALID_PAGE');
  }
  assert.deepEqual(calls, []);
});

test('history query binds literal email/status/site/time/cursor independently without credential joins or post-pagination filtering', async () => {
  let observed;
  const source = { id: CURSOR, createdAt: '2026-10-07T00:00:00Z', jobs: [{ email: 'x', status: 'failed', credentialStored: false }] };
  const store = createOAuthTaskHistoryStore({ async query(sql, args) { observed = { sql, args }; return { rows: [{ id: CURSOR }] }; } }, { async getBatch() { return source; } });
  const query = { email: "x%' OR true --", before: CURSOR, status: 'failed', mySiteId: SITE,
    createdFrom: '2026-10-01T00:00:00.000Z', createdBefore: '2026-10-08T00:00:00.000Z' };
  await store.listBatches(query);
  assert.deepEqual(observed.args, [query.email, CURSOR, 'failed', SITE, query.createdFrom, query.createdBefore]);
  assert.ok(!observed.sql.includes(query.email));
  assert.match(observed.sql, /strpos\(lower\(j.email\),lower\(\$1\)\)/);
  assert.match(observed.sql, /j.status=\$3/);
  assert.match(observed.sql, /b.my_site_id=\$4/);
  assert.match(observed.sql, /b.created_at >= \$5/);
  assert.match(observed.sql, /b.created_at < \$6/);
  assert.match(observed.sql, /order by b.created_at desc,b.id desc limit 31/);
  assert.doesNotMatch(observed.sql, /oauth_onboarding_job_secrets|envelope|password/);
});
