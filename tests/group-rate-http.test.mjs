import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequestHandler } from '../src/http.mjs';

async function startHandler(t, dependencies = {}) {
  const server = createServer(createRequestHandler({
    publicDir: new URL('../', import.meta.url),
    repository: { async listSites() { return []; } },
    ...dependencies,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('rate history endpoint validates, serves uncached read-only data and never synchronizes upstream', async (t) => {
  const calls = [];
  const result = { items: [], total: 0, page: 2, pageSize: 20, pages: 1, asOf: '2026-10-02T10:00:00.000Z', windowStart: '2026-10-01T10:00:00.000Z' };
  const base = await startHandler(t, {
    groupRateChangeRepository: { async listChanges(options) { calls.push(options); return result; } },
    snapshotService: { async refreshSnapshot() { assert.fail('read-only endpoint must not synchronize'); } },
  });
  const response = await fetch(`${base}/api/group-rate-changes?window=24h&page=2&pageSize=20&direction=up&q=%25&asOf=2026-10-02T10%3A00%3A00.000Z`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].page, 2);
  assert.equal(calls[0].q, '%');
  assert.equal(calls[0].windowStart, '2026-10-01T10:00:00.000Z');
  for (const query of ['page=0', 'page=1.1', 'pageSize=101', 'siteId=not-a-uuid', 'direction=added', 'window=1d', 'asOf=bad', 'page=1&page=2', 'q=x&unexpected=1', 'snapshot=bad', 'snapshot=-1']) {
    const invalid = await fetch(`${base}/api/group-rate-changes?${query}`);
    assert.equal(invalid.status, 400, query);
    assert.ok((await invalid.json()).error);
  }
  assert.equal(calls.length, 1);
});

test('rate history reports missing service and shields internal query errors', async (t) => {
  const missing = await startHandler(t);
  assert.equal((await fetch(`${missing}/api/group-rate-changes`)).status, 501);
  const failing = await startHandler(t, { groupRateChangeRepository: {
    async listChanges() { throw new Error('private database connection detail'); },
  } });
  const response = await fetch(`${failing}/api/group-rate-changes`);
  assert.equal(response.status, 500);
  const payload = await response.json();
  assert.equal(payload.error, '读取倍率变更记录失败，请稍后重试');
  assert.doesNotMatch(JSON.stringify(payload), /private database/);
});
