import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { runBrowserTask } from '../src/upstreams/browser-task.mjs';
import { fetchNewApiSnapshot } from '../src/upstreams/newapi.mjs';
import { fetchSub2ApiSnapshot } from '../src/upstreams/sub2api.mjs';
import { fetchSub2ApiFlowSnapshot } from '../src/upstreams/sub2api-flow.mjs';

const logger = { info() {} };
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
}
async function assertReaped(pids) {
  const end = Date.now() + 2_000;
  while (pids.some(alive) && Date.now() < end) await delay(20);
  assert.deepEqual(pids.filter(alive), [], 'all owned browser processes must exit');
}
async function chromePids(browser) {
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  await session.detach();
  return processInfo.map((p) => p.id);
}
const budgets = { timeoutMs: 8_000, launchTimeoutMs: 6_000, cleanupTimeoutMs: 1_000 };

test('local Chromium succeeds, preserves exceptions, times out a busy renderer, and runs the next task', { timeout: 25_000 }, async (t) => {
  for (const mode of ['success', 'exception', 'busy-renderer', 'next']) {
    let pids = [];
    const started = Date.now();
    const promise = runBrowserTask({ ...budgets, timeoutMs: mode === 'busy-renderer' ? 3_000 : 8_000 }, async (browser) => {
      const page = await browser.newPage();
      await page.goto('data:text/html,<title>local fixture</title>');
      pids = await chromePids(browser);
      if (mode === 'exception') throw new Error('local fixture exception');
      if (mode === 'busy-renderer') return await page.evaluate(() => { while (true) { /* simulate CPU runaway */ } });
      return await page.title();
    });
    if (mode === 'exception') await assert.rejects(promise, /local fixture exception/);
    else if (mode === 'busy-renderer') await assert.rejects(promise, { code: 'BROWSER_TASK_TIMEOUT', stage: 'task' });
    else assert.equal(await promise, 'local fixture');
    assert.ok(pids.length > 0);
    await assertReaped(pids);
    t.diagnostic(`${mode}: ${Date.now() - started}ms, ${pids.length} Chromium processes reaped`);
  }
});

test('a stopped local Chrome requires force-kill and only its own processes are reaped', { timeout: 12_000, skip: process.platform === 'win32' }, async (t) => {
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(async () => { const exited = once(sentinel, 'exit'); sentinel.kill('SIGKILL'); await exited; });
  let pids;
  const events = [];
  assert.equal(await runBrowserTask({
    ...budgets, logger: { info: (_tag, entry) => events.push(JSON.parse(entry)) },
    launchOptions: { channel: process.platform === 'darwin' ? 'chrome' : undefined, headless: true },
  }, async (browser) => {
    const page = await browser.newPage();
    await page.goto('data:text/html,local Chrome cleanup fixture');
    const session = await browser.newBrowserCDPSession();
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    await session.detach();
    pids = processInfo.map((p) => p.id);
    process.kill(processInfo.find((p) => p.type === 'browser').id, 'SIGSTOP');
    return 'collected';
  }), 'collected');
  assert.ok(events.some((e) => e.result === 'force-kill'));
  await assertReaped(pids);
  assert.equal(alive(sentinel.pid), true, 'unrelated local processes are untouched');
  t.diagnostic(`SIGSTOP Chrome: ${pids.length} owned processes reaped, unrelated sentinel remains alive`);
});

for (const ownerLossStage of ['task', 'force-kill']) {
  test(`owner SIGKILL during ${ownerLossStage} reaps its stopped Chrome before returning a snapshot and preserves a sentinel`, { timeout: 12_000, skip: process.platform === 'win32' }, async (t) => {
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    let pids = [];
    let browserPid;
    let ownerPid;
    t.after(async () => {
      // Reclaim the fixture even when the regression fails against old code.
      if (browserPid) {
        try { process.kill(-browserPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
      if (alive(sentinel.pid)) {
        const exited = once(sentinel, 'exit');
        sentinel.kill('SIGKILL');
        await exited;
      }
    });
    const events = [];
    const started = Date.now();
    const snapshot = { normalizedSnapshot: { balanceAmount: 7 } };
    assert.equal(await runBrowserTask({
      ...budgets, logger: { info: (_tag, entry) => {
        const event = JSON.parse(entry);
        events.push(event);
        if (ownerLossStage === 'force-kill' && event.result === 'force-kill') process.kill(ownerPid, 'SIGKILL');
      } },
      launchOptions: { channel: process.platform === 'darwin' ? 'chrome' : undefined, headless: true },
    }, async (browser) => {
      const page = await browser.newPage();
      await page.goto('data:text/html,owner death cleanup fixture');
      const session = await browser.newBrowserCDPSession();
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      await session.detach();
      browserPid = processInfo.find((p) => p.type === 'browser').id;
      const { stdout } = await promisify(execFile)('ps', ['-o', 'ppid=', '-p', String(browserPid)]);
      ownerPid = Number(stdout.trim());
      assert.ok(Number.isInteger(ownerPid) && ownerPid > 1 && ownerPid !== process.pid);
      pids = [ownerPid, ...processInfo.map((p) => p.id)];
      process.kill(browserPid, 'SIGSTOP');
      if (ownerLossStage === 'task') {
        process.kill(ownerPid, 'SIGKILL');
        await assertReaped([ownerPid]);
        assert.equal(alive(browserPid), true, 'stopped Chrome survives owner death before cleanup');
      }
      return snapshot;
    }), snapshot);
    assert.ok(Date.now() - started < budgets.timeoutMs + 2 * budgets.cleanupTimeoutMs, 'owner death cleanup stays bounded');
    assert.ok(events.some((e) => e.result === 'force-kill'));
    assert.deepEqual(pids.filter(alive), [], 'all owned processes must exit before publishing a snapshot');
    assert.equal(alive(sentinel.pid), true, 'unrelated local processes are untouched');
    t.diagnostic(`owner SIGKILL during ${ownerLossStage} + Chrome SIGSTOP: ${pids.length} owned processes reaped; snapshot returned after reclamation; sentinel alive`);
  });
}

test('startup timeout reaps an executable and its child before launchServer can return a handle', { timeout: 8_000, skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-browser-launch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'pids.json');
  const executable = join(dir, 'hanging-browser');
  await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs'); const {spawn} = require('node:child_process');\nconst child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});\nfs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, process.ppid, child.pid]));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const started = Date.now();
  await assert.rejects(runBrowserTask({
    ...budgets, timeoutMs: 5_000, launchTimeoutMs: 2_000,
    launchOptions: { executablePath: executable, headless: true },
  }, async () => { assert.fail('startup must not finish'); }), /launch|timeout/i);
  const pids = JSON.parse(await readFile(pidFile, 'utf8'));
  await assertReaped(pids);
  t.diagnostic(`hung startup: ${Date.now() - started}ms, launcher/browser/child reaped (${pids.length} processes)`);
});

async function localUpstream(t) {
  const requests = [];
  let hang = true;
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://local').pathname;
    requests.push(path);
    if (path === '/login' || path === '/keys') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>local adapter fixture</title>');
      return;
    }
    if (path === '/api/user/self' || path === '/api/v1/user/profile') {
      if (hang) return; // Deliberately leave the browser fetch/body pending.
    }
    let payload;
    if (path === '/api/status') payload = { success: true, data: { quota_per_unit: 1 } };
    else if (path === '/api/user/self') payload = { success: true, data: { id: 1, quota: 7 } };
    else if (path === '/api/user/self/groups') payload = { success: true, data: {} };
    else if (path === '/api/token/') payload = { success: true, data: { items: [] } };
    else if (path === '/api/v1/user/profile') payload = { code: 0, data: { id: 1, balance: 7 } };
    else if (path === '/api/v1/groups/available') payload = { code: 0, data: [] };
    else if (path === '/api/v1/groups/rates') payload = { code: 0, data: {} };
    else if (path === '/api/v1/keys') payload = { code: 0, data: { items: [] } };
    else { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { requests, url: `http://127.0.0.1:${server.address().port}`, resume() { hang = false; } };
}

for (const [name, adapter, pendingEndpoint] of [
  ['newapi', fetchNewApiSnapshot, '/api/user/self'],
  ['sub2api', fetchSub2ApiSnapshot, '/api/v1/user/profile'],
  ['sub2api-flow', fetchSub2ApiFlowSnapshot, '/api/v1/user/profile'],
]) {
  test(`${name} real local browser fetch hangs, is closed, then a new collection succeeds`, { timeout: 15_000 }, async (t) => {
    const upstream = await localUpstream(t);
    const site = { id: 'local-only', url: upstream.url, authToken: 'fixture-token', username: 'fixture@example.invalid', password: 'fixture-password', userId: '1' };
    const options = {
      logger, timeoutMs: 3_000, browserCleanupTimeoutMs: 1_000,
      fetch: async () => new Response('<html>Just a moment</html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    };
    await assert.rejects(adapter(site, options), (e) => {
      assert.match(e.message, /Playwright.*timeout/);
      return true;
    });
    assert.ok(upstream.requests.includes(pendingEndpoint), 'real page.evaluate fetch reached the local hanging endpoint');
    upstream.resume();
    const result = await adapter(site, { ...options, timeoutMs: 8_000 });
    assert.equal(result.normalizedSnapshot.balanceAmount, 7);
    t.diagnostic(`${name}: pending localhost fetch cancelled; next browser snapshot balance=7`);
  });
}
