import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createSnapshotService } from '../src/snapshots.mjs';
import { fetchSub2ApiSnapshot } from '../src/upstreams/sub2api.mjs';
import { fetchSub2ApiFlowSnapshot } from '../src/upstreams/sub2api-flow.mjs';

const logger = { info() {} };
const challenge = async () => new Response('<html>Just a moment</html>', {
  status: 403, headers: { 'cf-mitigated': 'challenge' },
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const [variant, adapter] of [['default', fetchSub2ApiSnapshot], ['credential-flow', fetchSub2ApiFlowSnapshot]]) {
  test(`${variant}: successful rotation then browser timeout persists credentials but rejects the snapshot`, { timeout: 15_000 }, async (t) => {
    let hang = true;
    let rotations = 0;
    const server = createServer(async (req, res) => {
      const path = new URL(req.url, 'http://local').pathname;
      if (path === '/login') { res.end('<!doctype html><title>local rotation fixture</title>'); return; }
      res.setHeader('content-type', 'application/json');
      if (path === '/api/v1/auth/refresh') {
        let body = '';
        for await (const chunk of req) body += chunk;
        if (JSON.parse(body).refresh_token !== 'old-refresh' || rotations !== 0) {
          res.writeHead(401); res.end(JSON.stringify({ message: 'invalidated refresh token' })); return;
        }
        rotations++;
        res.end(JSON.stringify({ data: { access_token: 'new-access', refresh_token: 'new-refresh' } }));
        return;
      }
      if (req.headers.authorization !== 'Bearer new-access') {
        res.writeHead(401); res.end(JSON.stringify({ message: 'expired' })); return;
      }
      if (path === '/api/v1/user/profile' && hang) return;
      const data = path === '/api/v1/user/profile' ? { id: 1, balance: 7 }
        : path === '/api/v1/groups/available' ? []
          : path === '/api/v1/groups/rates' ? {} : { items: [] };
      res.end(JSON.stringify({ code: 0, data }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
    const site = {
      id: `local-rotation-${variant}`, type: 'sub2api', syncVariant: variant,
      url: `http://127.0.0.1:${server.address().port}`, authToken: 'old-access', refreshToken: 'old-refresh',
      refreshTokenRotatedAt: '2000-01-01T00:00:00.000Z', username: 'fixture@example.invalid', password: 'fixture-password',
    };
    let stored = { ...site };
    const writes = [];
    const snapshots = [];
    const collect = (input, options) => adapter(input, {
      ...options, fetch: challenge, logger, timeoutMs: hang ? 3_000 : 8_000, browserCleanupTimeoutMs: 1_000,
    });
    const service = createSnapshotService({
      adapters: { sub2api: collect, sub2apiFlow: collect },
      siteRepository: {
        async getSiteById() { return { ...stored }; },
        async updateSiteAuthTokens(id, update) {
          writes.push({ id, update });
          stored = { ...stored, authToken: update.authToken, refreshToken: update.refreshToken, refreshTokenRotatedAt: update.rotatedAt };
        },
      },
      snapshotRepository: { async saveSnapshot(snapshot) { snapshots.push(snapshot); } },
    });
    await assert.rejects(service.refreshSnapshot(site), /Playwright.*timeout/);
    assert.equal(rotations, 1, 'the upstream invalidated the old refresh token');
    assert.equal(writes.length, 1, 'rotation was committed despite later browser timeout');
    assert.equal(stored.refreshToken, 'new-refresh');
    assert.equal(snapshots.length, 0, 'failed collection cannot publish a partial snapshot');
    hang = false;
    const snapshot = await service.refreshSnapshot(site);
    assert.equal(snapshot.balanceAmount, 7);
    assert.equal(rotations, 1, 'the next collection uses persisted credentials without another rotation');
    assert.equal(snapshots.length, 1);
  });
}

test('site lock waits for an in-flight auth checkpoint after collection timeout and rejects late writes', async () => {
  const entered = deferred();
  const finishWrite = deferred();
  let runs = 0;
  let saved = 0;
  let lateWrite;
  let stored = { id: 'checkpoint-lock', type: 'sub2api', authToken: 'old' };
  const tokens = [];
  const service = createSnapshotService({
    adapters: { async sub2api(site, { onAuthUpdate }) {
      runs++;
      tokens.push(site.authToken);
      if (runs === 1) {
        lateWrite = onAuthUpdate;
        void onAuthUpdate({ authToken: 'new' });
        await entered.promise;
        throw new Error('collection timeout');
      }
      return { normalizedSnapshot: { balanceAmount: 7 } };
    } },
    siteRepository: {
      async getSiteById() { return { ...stored }; },
      async updateSiteAuthTokens(_id, update) {
        entered.resolve();
        await finishWrite.promise;
        stored = { ...stored, ...update };
      },
    },
    snapshotRepository: { async saveSnapshot() { saved++; } },
  });
  const first = assert.rejects(service.refreshSnapshot(stored), /collection timeout/);
  await entered.promise;
  const second = service.refreshSnapshot(stored);
  await delay(20);
  assert.equal(runs, 1, 'next refresh cannot acquire the site lock before persistence settles');
  finishWrite.resolve();
  await first;
  await second;
  assert.deepEqual(tokens, ['old', 'new']);
  assert.equal(saved, 1);
  await assert.rejects(lateWrite({ authToken: 'stale' }), /checkpoint is closed/);
  assert.equal(stored.authToken, 'new');
});

test('checkpoint write failure prevents snapshot publication and a successful checkpoint is not written twice', async () => {
  for (const fail of [true, false]) {
    let writes = 0;
    let snapshots = 0;
    const authUpdate = { authToken: 'new', refreshToken: 'rotated', rotatedAt: '2026-10-14T00:00:00Z' };
    const service = createSnapshotService({
      adapters: { async sub2api(_site, { onAuthUpdate }) {
        await onAuthUpdate(authUpdate);
        return { authUpdate, normalizedSnapshot: { balanceAmount: 7 } };
      } },
      siteRepository: { async updateSiteAuthTokens() { writes++; if (fail) throw new Error('fixture persistence failed'); } },
      snapshotRepository: { async saveSnapshot() { snapshots++; } },
    });
    const promise = service.refreshSnapshot({ id: `checkpoint-write-${fail}`, type: 'sub2api' });
    if (fail) await assert.rejects(promise, /persistence failed/);
    else await promise;
    assert.equal(writes, 1);
    assert.equal(snapshots, fail ? 0 : 1);
  }
});
