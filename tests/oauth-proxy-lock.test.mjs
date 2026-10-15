import test from 'node:test';
import assert from 'node:assert/strict';
import { withOAuthProxyLock } from '../src/oauth-proxy-lock.mjs';

function fixture(queries) {
  const releases = [];
  const client = { async query(sql) { return queries(sql); }, release(error) { releases.push(error); } };
  return { client, releases, pool: { async connect() { return client; } } };
}

test('proxy lock passes the held connection and unlocks after a callback failure', async () => {
  const sqls = [];
  const f = fixture(sql => { sqls.push(sql); return { rows: [{ locked: true }] }; });
  await assert.rejects(withOAuthProxyLock(f.pool, 'site', 'proxy', async client => {
    assert.equal(client, f.client); throw new Error('callback failed');
  }), /callback failed/);
  assert.match(sqls[1], /pg_advisory_unlock/);
  assert.deepEqual(f.releases, [undefined]);
});

test('contended proxy lock releases its connection before waiting and can be aborted', async () => {
  const controller = new AbortController();
  const f = fixture(() => ({ rows: [{ locked: false }] }));
  f.client.release = error => { f.releases.push(error); controller.abort(); };
  await assert.rejects(withOAuthProxyLock(f.pool, 'site', 'proxy', () => assert.fail('must not enter'), { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(f.releases, [undefined]);
});

test('uncertain acquisition and unlock errors destroy rather than recycle the session', async () => {
  for (const failure of ['acquire', 'unlock']) {
    const error = new Error(failure);
    const f = fixture(sql => { if (failure === 'acquire' || sql.includes('pg_advisory_unlock')) throw error; return { rows: [{ locked: true }] }; });
    await assert.rejects(withOAuthProxyLock(f.pool, 'site', 'proxy', () => 42), error);
    assert.deepEqual(f.releases, [error]);
  }
});

test('already cancelled proxy lock never checks out a connection', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(withOAuthProxyLock({ connect() { assert.fail('no connection'); } }, 'site', 'proxy', () => {}, { signal: controller.signal }), { name: 'AbortError' });
});
