import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequestHandler } from '../src/http.mjs';

async function fixture(t, service = {}) {
  const requests = [];
  const handler = createRequestHandler({ publicDir: new URL('../', import.meta.url), oauthOnboarding: {
    async options() { return { mySites: [], proxies: [] }; },
    async groups(id) { requests.push(['groups', id]); return []; },
    async list() { return []; }, async get(id) { return { id }; },
    async submit(body) { requests.push(['submit', structuredClone(body)]); return { id: body.requestId }; },
    async reconcile(id) { requests.push(['reconcile', id]); return { id, status: 'uncertain' }; }, ...service,
  } });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('OAuth APIs are no-store and submit only JSON, preserving response schema', async (t) => {
  const f = await fixture(t);
  const options = await fetch(`${f.url}/api/oauth-onboarding/options`);
  assert.equal(options.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await options.json(), { mySites: [], proxies: [] });
  const response = await fetch(`${f.url}/api/oauth-onboarding/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', origin: f.url }, body: JSON.stringify({ requestId: 'id', password: 'test-only', totpSecret: 'test-only' }) });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { job: { id: 'id' } });
});

test('cross-site and non-JSON posts never reach credential service', async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { 'content-type': 'text/plain' },
    { 'content-type': 'application/json', origin: 'https://evil.example' },
    { 'content-type': 'application/json', origin: 'null' },
    { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
  ]) {
    const response = await fetch(`${f.url}/api/oauth-onboarding/jobs`, { method: 'POST', headers, body: '{}' });
    assert.ok([403, 415].includes(response.status));
  }
  assert.deepEqual(f.requests, []);
});

test('JSON errors and oversized request never echo passwords', async (t) => {
  const f = await fixture(t);
  const marker = 'DO_NOT_ECHO_THIS_PASSWORD';
  for (const body of [`{"password":"${marker}"`, JSON.stringify({ password: marker.repeat(1000) })]) {
    const response = await fetch(`${f.url}/api/oauth-onboarding/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.ok([400, 413].includes(response.status));
    assert.ok(!(await response.text()).includes(marker));
  }
  assert.deepEqual(f.requests, []);
});

test('untrusted upstream error messages never appear in public error responses', async (t) => {
  const f = await fixture(t, { async list() { throw new Error('Bearer ADMIN_TOKEN_MUST_NOT_LEAK'); } });
  const response = await fetch(`${f.url}/api/oauth-onboarding/jobs`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'OAuth 入池服务暂时不可用', code: 'INTERNAL_ERROR' });
});

test('unknown subpaths remain isolated and reconciliation is explicit POST only', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/api/oauth-onboarding/jobs/id/reconcile`)).status, 404);
  assert.equal((await fetch(`${f.url}/api/oauth-onboarding/nope`)).status, 404);
  const response = await fetch(`${f.url}/api/oauth-onboarding/jobs/id/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(f.requests, [['reconcile', 'id']]);
  assert.equal((await fetch(`${f.url}/oauth-accounts`)).status, 200);
});

test('batch and preference routes are isolated no-store APIs; accepted request secrets are released', async (t) => {
  let retained;
  const { url } = await fixture(t, {
    async preferences(id) { return { preferences: { groupIds: [1], importOptions: { concurrency: 50 } }, capabilities: { atomicSchedulable: true }, target: id }; },
    async submitBatch(body) { retained = body; return { id: body.requestId, jobs: [] }; },
    async getBatch(id) { return { id, jobs: [] }; },
  });
  const pref = await fetch(`${url}/api/oauth-onboarding/preferences?mySiteId=test`);
  assert.equal(pref.headers.get('cache-control'), 'no-store');
  assert.equal((await pref.json()).capabilities.atomicSchedulable, true);
  const response = await fetch(`${url}/api/oauth-onboarding/batches`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'batch-test', accounts: [{ email: 'test@example.test', password: 'private-secret', totpSecret: 'private-totp' }] }) });
  assert.equal(response.status, 202); assert.equal((await response.json()).batch.id, 'batch-test');
  assert.equal(retained.accounts, undefined);
  assert.deepEqual(await (await fetch(`${url}/api/oauth-onboarding/batches/batch-test`)).json(), { batch: { id: 'batch-test', jobs: [] } });
});

test('batch failures erase nested secret fields and enforce bounded payloads without disclosure', async (t) => {
  let retainedAccount;
  const { url } = await fixture(t, { async submitBatch(body) { retainedAccount = body.accounts[0]; throw new Error('private-secret'); } });
  const post = (value) => fetch(`${url}/api/oauth-onboarding/batches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const result = await post({ accounts: [{ password: 'private-secret', totpSecret: 'private-totp' }] });
  assert.equal(result.status, 500); assert.equal((await result.text()).includes('private-secret'), false);
  assert.equal(retainedAccount.password, undefined); assert.equal(retainedAccount.totpSecret, undefined);
  const tooLarge = await post({ accounts: [{ password: 'X'.repeat(256 * 1024) }] });
  assert.equal(tooLarge.status, 413);
  const crossed = await fetch(`${url}/api/oauth-onboarding/batches`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://other.example.test' }, body: '{}' });
  assert.equal(crossed.status, 403);
});

test('batch history email filter and rerun routes preserve same-origin protection and no-store', async (t) => {
  const calls = [];
  const f = await fixture(t, {
    async listBatches(query) { calls.push(['list', query]); return { batches: [], nextCursor: null }; },
    async getBatch(id, query) { calls.push(['get', id, query]); return { id, jobs: [] }; },
    async rerunBatch(id, body) { calls.push(['batch', id, body]); return { id: body.requestId, jobs: [] }; },
    async rerunJob(id, body) { calls.push(['job', id, body]); return { id: body.requestId, jobs: [] }; },
  });
  await fetch(`${f.url}/api/oauth-onboarding/batches?email=name%25&before=cursor`);
  await fetch(`${f.url}/api/oauth-onboarding/batches/old?email=name%25`);
  assert.deepEqual(calls.splice(0), [['list', { email: 'name%', before: 'cursor' }], ['get', 'old', { email: 'name%' }]]);
  for (const path of ['batches', 'jobs']) {
    const url = `${f.url}/api/oauth-onboarding/${path}/old/rerun`;
    const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(denied.status, 403);
    assert.equal((await fetch(url)).status, 404);
    const accepted = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: f.url }, body: JSON.stringify({ requestId: 'new' }) });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await accepted.json(), { batch: { id: 'new', jobs: [] } });
  }
  assert.deepEqual(calls, [['batch', 'old', { requestId: 'new' }], ['job', 'old', { requestId: 'new' }]]);
});

test('execution settings GET and PUT are no-store and use the shared strict contract', async (t) => {
  const { validateOAuthExecutionSettings, OAUTH_EXECUTION_LIMITS } = await import('../src/oauth-execution-settings.mjs');
  let settings = { concurrency: 5 };
  const f = await fixture(t, {
    async getExecutionSettings() { return { settings, limits: OAUTH_EXECUTION_LIMITS }; },
    async saveExecutionSettings(body) { settings = validateOAuthExecutionSettings(body); return { settings, limits: OAUTH_EXECUTION_LIMITS }; },
  });
  const url = `${f.url}/api/oauth-onboarding/settings`;
  const initial = await fetch(url);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await initial.json(), { settings: { concurrency: 5 }, limits: { min: 1, max: 20 } });
  for (const concurrency of [1, 20, 5]) {
    const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', origin: f.url }, body: JSON.stringify({ concurrency }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).settings.concurrency, concurrency);
  }
  for (const body of ['{}', 'null', '[]', '{"concurrency":"5"}', '{"concurrency":0}', '{"concurrency":21}', '{"concurrency":1.5}', '{"concurrency":1,"concurrency":5}', '{"concurrency":5,"extra":1}']) {
    const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, 400, body);
  }
  assert.deepEqual(settings, { concurrency: 5 });
  for (const headers of [ { 'content-type': 'text/plain' }, { 'content-type': 'application/json', origin: 'https://evil.example' }, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } ]) {
    assert.ok([403, 415].includes((await fetch(url, { method: 'PUT', headers, body: '{"concurrency":2}' })).status));
  }
  assert.equal((await fetch(`${url}?concurrency=2`)).status, 400);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: ' '.repeat(1025) })).status, 413);
});

test('execution settings database failures are redacted for reads and writes', async (t) => {
  const fail = async () => { throw new Error('postgres://SECRET'); };
  const f = await fixture(t, { getExecutionSettings: fail, saveExecutionSettings: fail });
  for (const method of ['GET', 'PUT']) {
    const response = await fetch(`${f.url}/api/oauth-onboarding/settings`, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: '{"concurrency":5}' });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.text()).includes('SECRET'), false);
  }
});
