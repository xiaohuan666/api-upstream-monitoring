import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createRequestHandler } from '../src/http.mjs';

const removedApiRoutes = [
  ['GET', '/api/pricing/targets'],
  ['POST', '/api/pricing/targets'],
  ['PUT', '/api/pricing/targets/target-1'],
  ['DELETE', '/api/pricing/targets/target-1'],
  ['GET', '/api/pricing/targets/target-1/remote-accounts'],
  ['GET', '/api/pricing/targets/target-1/remote-groups'],
  ['GET', '/api/pricing/mappings?targetId=target-1'],
  ['POST', '/api/pricing/mappings'],
  ['PUT', '/api/pricing/mappings/mapping-1'],
  ['DELETE', '/api/pricing/mappings/mapping-1'],
  ['GET', '/api/pricing/policies?targetId=target-1'],
  ['POST', '/api/pricing/policies'],
  ['PUT', '/api/pricing/policies/policy-1'],
  ['DELETE', '/api/pricing/policies/policy-1'],
  ['GET', '/api/pricing/decisions?targetId=target-1'],
  ['GET', '/api/pricing/decisions/decision-1'],
  ['POST', '/api/pricing/run'],
  ['GET', '/api/pricing/auto-run-settings'],
  ['PUT', '/api/pricing/auto-run-settings'],
  ['GET', '/api/benchmarks?siteId=site-1&groupId=group%2F1'],
  ['POST', '/api/benchmarks'],
  ['GET', '/api/benchmarks/run-1'],
];

async function startHandler(t) {
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: {
      async listSites() { assert.fail('Removed routes must not access site data'); },
      async getSiteById() { assert.fail('Removed routes must not access site data'); },
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('removed pricing and benchmark APIs return 404 for every former operation', async (t) => {
  const base = await startHandler(t);
  for (const [method, pathname] of removedApiRoutes) {
    await t.test(`${method} ${pathname}`, async () => {
      const response = await fetch(`${base}${pathname}`, {
        method,
        ...(method === 'GET' ? {} : {
          headers: { 'content-type': 'application/json' },
          body: '{"targetId":"target-1","siteId":"site-1","groupId":"group/1"}',
        }),
      });
      assert.equal(response.status, 404);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await response.json(), { error: 'Not found' });
    });
  }
});

test('removed write APIs return 404 before parsing a request body', async (t) => {
  const base = await startHandler(t);
  for (const pathname of ['/api/pricing/run', '/api/benchmarks']) {
    const response = await fetch(`${base}${pathname}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid',
    });
    assert.equal(response.status, 404, pathname);
    assert.deepEqual(await response.json(), { error: 'Not found' }, pathname);
  }
});

test('removed pricing and benchmark pages return 404 on direct navigation', async (t) => {
  const base = await startHandler(t);
  for (const pathname of ['/pricing', '/benchmarks']) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 404, pathname);
    assert.equal(await response.text(), 'Not found', pathname);
  }
});
