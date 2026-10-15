import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginOpenAI, oauthLoginProxyOptions, sanitizeOAuthChallenge } from '../src/oauth-login.mjs';

const ORIGIN = 'https://auth.openai.com';
const REDIRECT = 'http://localhost:1455/auth/callback';
const STATE = 'offline-oauth-state';
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const input = { email: 'offline@example.test', password: 'offline-only-password', totpSecret: SECRET };
const proxy = { protocol: 'socks5h', host: 'proxy.test', port: 1080, username: 'offline-proxy-user', password: 'offline-proxy-secret' };
const fixtureSource = fileURLToPath(new URL('./fixtures/oauth-worker-ipc.py', import.meta.url));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function authUrl(redirectUri = REDIRECT, params = {}) {
  const url = new URL(`${ORIGIN}/oauth/authorize`);
  url.search = new URLSearchParams({ response_type: 'code', state: STATE, redirect_uri: redirectUri, ...params }).toString();
  return url.href;
}
function assertSafe(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.safe, true);
    assert.equal(error.needsAttention, true);
    assert.ok(Number.isInteger(error.statusCode));
    const exposed = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
    for (const secret of [input.email, input.password, SECRET, proxy.username, proxy.password, STATE, 'RAW-UPSTREAM-SECRET']) {
      assert.ok(!exposed.includes(secret), '受控错误不能泄露账号、代理、上游或状态秘密');
    }
    assert.equal(error.cause, undefined);
    return true;
  };
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-worker-'));
  const path = join(dir, 'worker.py');
  await copyFile(fixtureSource, path);
  const calls = [];
  t.after(async () => {
    // 测试失败也清理进程组，避免留下测试子孙。
    for (const { child } of calls) {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  });
  const spawnWorker = (python, args, options) => {
    assert.equal(args.length, 2);
    assert.equal(args[0], '-u');
    assert.equal(args[1], fileURLToPath(new URL('../tools/oauth_login/worker.py', import.meta.url)));
    const child = spawn(python, ['-u', path], options);
    const call = { child, python, args, options, acks: [], writes: [] };
    calls.push(call);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (json, ...args) => {
      assert.ok(json.endsWith('\n'));
      assert.equal(json.split('\n').length, 2, '每次只写一行 JSON');
      const frame = JSON.parse(json);
      if (!call.payload) call.payload = frame;
      else call.acks.push(frame);
      call.writes.push(json);
      return write(json, ...args);
    };
    return child;
  };
  return { calls, path, run: (mode = 'success', options = {}, params = {}) => loginOpenAI({
    ...input, authUrl: authUrl(REDIRECT, { fixture: mode, ...params }), timeoutMs: 3000, spawnWorker, ...options,
  }) };
}
function assertExited(child) {
  assert.ok(child.exitCode !== null || child.signalCode !== null, '必须在返回前回收 Python');
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
}
const noSpawn = () => assert.fail('预校验或预先取消不得启动子进程');

test('授权 URL、state、redirect、重复参数严格预校验；不启动 Python', async () => {
  const base = authUrl();
  const invalid = [undefined, {}, base.replace('https:', 'http:'), base.replace('auth.openai.com', 'auth.openai.com.evil.test'),
    base.replace('auth.openai.com', 'user:secret@auth.openai.com'), base.replace('auth.openai.com', 'auth.openai.com:444'),
    base.replace('/oauth/authorize', '/steal'), `${base}#fragment`, `${base}&state=other`, `${base}&redirect_uri=${encodeURIComponent(REDIRECT)}`,
    `${base}&client_id=a&client_id=b`, base.replace(`state=${STATE}`, 'state='), base.replace(`state=${STATE}`, 'state=%00'),
    base.replace(`state=${STATE}`, 'state=has%20space'), authUrl(REDIRECT, { state: 'x'.repeat(1025) }),
    authUrl('http://localhost:1456/auth/callback'), authUrl('https://localhost:1455/auth/callback'),
    authUrl('http://localhost:1455/auth/callback/'), authUrl('http://localhost:1455/auth/callback?extra=1'),
    authUrl('http://localhost.evil.test:1455/auth/callback'), base.replace('response_type=code', 'response_type=token'),
    base.replace('response_type=code&', ''), base.replace('response_type=code', 'response_type=')];
  for (const url of invalid) await assert.rejects(loginOpenAI({ ...input, authUrl: url, spawnWorker: noSpawn }), assertSafe('OAUTH_INVALID_AUTH_URL'));
});

test('凭据、TOTP、有限超时与回调参数预校验', async () => {
  for (const [options, code] of [[{ email: '' }, 'OAUTH_INVALID_INPUT'], [{ email: 'bad' }, 'OAUTH_INVALID_INPUT'],
    [{ password: '' }, 'OAUTH_INVALID_INPUT'], [{ password: 'x'.repeat(4097) }, 'OAUTH_INVALID_INPUT'],
    [{ timeoutMs: Infinity }, 'OAUTH_INVALID_INPUT'], [{ timeoutMs: 0 }, 'OAUTH_INVALID_INPUT'],
    [{ timeoutMs: 300001 }, 'OAUTH_INVALID_INPUT'], [{ timeoutMs: 1.5 }, 'OAUTH_INVALID_INPUT'],
    [{ onStage: 'bad' }, 'OAUTH_INVALID_INPUT'], [{ signal: {} }, 'OAUTH_INVALID_INPUT'],
    [{ totpSecret: 'invalid0' }, 'OAUTH_INVALID_TOTP_SECRET'],
    [{ proxy: { ...proxy, host: 'user@proxy.test' } }, 'OAUTH_INVALID_PROXY'],
    [{ authUrl: authUrl(REDIRECT, { padding: 'x'.repeat(15000) }), password: '\0'.repeat(4096),
      totpSecret: 'A'.repeat(4096), proxy: { ...proxy, username: '界'.repeat(4096), password: '界'.repeat(4096) } }, 'OAUTH_INVALID_INPUT']]) {
    await assert.rejects(loginOpenAI({ authUrl: authUrl(), ...input, ...options, spawnWorker: noSpawn }), assertSafe(code));
  }
});

test('HTTP/HTTPS/认证 SOCKS5/SOCKS5H/IPv6 代理预校验且不降级 DNS', () => {
  for (const [value, expected] of [[null, {}],
    [{ protocol: 'http', host: 'proxy.test', port: '3128', username: 'user', password: 'secret' }, { proxy: { server: 'http://proxy.test:3128', username: 'user', password: 'secret' } }],
    [{ protocol: 'https', host: 'proxy.test', port: 443 }, { proxy: { server: 'https://proxy.test:443' } }],
    [{ ...proxy, protocol: 'socks5' }, { proxy: { server: 'socks5://proxy.test:1080', username: proxy.username, password: proxy.password } }],
    [proxy, { proxy: { server: 'socks5h://proxy.test:1080', username: proxy.username, password: proxy.password } }],
    [{ protocol: 'socks5h', host: '::1', port: 1080 }, { proxy: { server: 'socks5h://[::1]:1080' } }]]) {
    assert.deepEqual(oauthLoginProxyOptions(value), expected);
  }
  for (const value of ['bad', [], { protocol: 'ftp', host: 'proxy.test', port: 80 },
    { ...proxy, host: 'user@proxy.test' }, { ...proxy, host: 'proxy.test/path' }, { ...proxy, host: 'proxy..test' },
    { ...proxy, port: 0 }, { ...proxy, port: 65536 }, { ...proxy, port: '80junk' }, { ...proxy, username: 42 },
    { ...proxy, password: 'bad\npassword' }]) assert.throws(() => oauthLoginProxyOptions(value), assertSafe('OAUTH_INVALID_PROXY'));
});

test('真实临时 Python stdin JSON→分段 NDJSON；阶段串行且最终结果精确绑定', async (t) => {
  const f = await fixture(t);
  const stages = [];
  let active = 0;
  const result = await f.run('success', { proxy: { ...proxy, id: 'must-not-forward' }, onStage: async (stage) => {
    assert.equal(active++, 0);
    await new Promise((resolve) => setTimeout(resolve, 4));
    stages.push(stage);
    active -= 1;
  } });
  assert.deepEqual(result, { code: 'offline-code', state: STATE, redirectUri: REDIRECT });
  assert.deepEqual(stages, ['warmup', 'csrf', 'authorizing', 'email', 'password', 'totp', 'consent']);
  assert.deepEqual(f.calls[0].acks, stages.map((stage) => ({ type: 'ack', stage })));
  assert.deepEqual((await readFile(f.path.replace('.py', '.acks'), 'utf8')).trim().split('\n'),
    stages.map((stage) => JSON.stringify({ type: 'ack', stage })));
  assert.deepEqual((await readFile(f.path.replace('.py', '.effects'), 'utf8')).trim().split('\n'), stages);
  assert.deepEqual(f.calls[0].payload, { ...input, authUrl: authUrl(REDIRECT, { fixture: 'success' }), proxy, timeoutMs: 3000 });
  assert.equal(f.calls[0].options.detached, process.platform !== 'win32');
  assert.equal(f.calls[0].options.shell, false);
  assert.deepEqual(f.calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  assertExited(f.calls[0].child);
  assert.deepEqual(await f.run('split'), { ...result, code: 'offline-授权码' });
  assert.deepEqual(f.calls.at(-1).acks, [], '没有 stage 的 worker 不需要 ACK 也不依赖 stdin EOF');
});

test('无 TOTP 账号与两个固定回调均可用；原始 authUrl/PKCE 不重写', async (t) => {
  const f = await fixture(t);
  const url = authUrl('http://127.0.0.1:1455/auth/callback', { code_challenge: 'offline+challenge', fixture: 'success' });
  assert.deepEqual(await f.run('success', { authUrl: url, email: ` ${input.email} `, totpSecret: '' }),
    { code: 'offline-code', state: STATE, redirectUri: 'http://127.0.0.1:1455/auth/callback' });
  assert.equal(f.calls[0].payload.authUrl, url);
  assert.equal(f.calls[0].payload.email, input.email);
  assert.equal(f.calls[0].payload.totpSecret, null);
  await f.run('success', { authUrl: authUrl().replace('/oauth/authorize', '/authorize') });
});

test('进程环境允许列表剔除 DB/admin/proxy/Python 注入；秘密不进 argv/env', async (t) => {
  const f = await fixture(t);
  const poison = { DATABASE_URL: 'RAW-UPSTREAM-SECRET', ADMIN_PASSWORD: input.password, HTTP_PROXY: proxy.password,
    HTTPS_PROXY: proxy.password, ALL_PROXY: proxy.password, PYTHONPATH: 'RAW-UPSTREAM-SECRET',
    PYTHONSTARTUP: 'RAW-UPSTREAM-SECRET', NODE_OPTIONS: 'RAW-UPSTREAM-SECRET', OAUTH_LOGIN_PYTHON: process.env.OAUTH_LOGIN_PYTHON || 'python3' };
  const original = Object.fromEntries(Object.keys(poison).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, poison);
    await f.run();
    const call = f.calls[0];
    assert.equal(call.python, poison.OAUTH_LOGIN_PYTHON);
    assert.deepEqual(Object.keys(call.options.env).sort(), ['PATH', 'LANG', 'PYTHONIOENCODING', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE'].sort());
    for (const secret of [input.email, input.password, SECRET, proxy.password, 'RAW-UPSTREAM-SECRET']) {
      assert.ok(!JSON.stringify([call.args, call.options.env]).includes(secret));
    }
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('回调拒绝错 state、错 URI、额外字段与无效 code；原始秘密不穿透', async (t) => {
  const f = await fixture(t);
  for (const [override, code] of [[{ state: 'wrong' }, 'OAUTH_STATE_MISMATCH'], [{ state: null }, 'OAUTH_STATE_MISMATCH'],
    [{ state: [STATE, STATE] }, 'OAUTH_STATE_MISMATCH'], [{ code: '' }, 'OAUTH_INVALID_CALLBACK'],
    [{ code: null }, 'OAUTH_INVALID_CALLBACK'], [{ code: 'x x' }, 'OAUTH_INVALID_CALLBACK'],
    [{ code: 'x\0' }, 'OAUTH_INVALID_CALLBACK'], [{ code: 'x'.repeat(8193) }, 'OAUTH_INVALID_CALLBACK'],
    ...['http://localhost:1456/auth/callback', 'http://127.0.0.1:1455/auth/callback', 'http://localhost:1455/other',
      `${REDIRECT}?code=x&state=${STATE}`, `${REDIRECT}#fragment`, 'http://user:secret@localhost:1455/auth/callback',
      'https://untrusted.example.test/steal'].map((redirectUri) => [{ redirectUri }, 'OAUTH_INVALID_CALLBACK']),
    [{ error: 'RAW-UPSTREAM-SECRET' }, 'OAUTH_WORKER_PROTOCOL']]) {
    await assert.rejects(f.run('callback', {}, { override: JSON.stringify(override) }), assertSafe(code));
    assertExited(f.calls.at(-1).child);
  }
});

test('重复结果、结果后阶段、异常退出、缺失结果及不完整 NDJSON 必须拒绝', async (t) => {
  const f = await fixture(t);
  for (const mode of ['duplicate', 'trailing-stage', 'exit-failure', 'signal-exit', 'missing', 'partial',
    'invalid-json', 'invalid-utf8', 'unknown-stage', 'extra-field', 'unknown-event', 'bad-envelope', 'empty-line']) {
    await assert.rejects(f.run(mode), assertSafe('OAUTH_WORKER_PROTOCOL'));
    assertExited(f.calls.at(-1).child);
  }
});

test('stdout 行/累计/事件数和 stderr 输出均有界，超限杀进程', async (t) => {
  const f = await fixture(t);
  for (const mode of ['line-limit', 'unfinished-line-limit', 'total-limit', 'event-limit', 'stderr-limit']) {
    await assert.rejects(f.run(mode), assertSafe('OAUTH_WORKER_PROTOCOL'));
    assertExited(f.calls.at(-1).child);
  }
});

test('stderr 绝不外泄；未知错误码或 worker message 不能成为受信错误', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run('stderr-secret', { proxy }), assertSafe('OAUTH_NETWORK_ERROR'));
  await assert.rejects(f.run('error-hold', { timeoutMs: 500 }), assertSafe('OAUTH_NETWORK_ERROR'));
  assertExited(f.calls.at(-1).child);
  for (const mode of ['unknown-error', 'error-message']) await assert.rejects(f.run(mode), assertSafe('OAUTH_WORKER_PROTOCOL'));
});

test('worker 白名单错误映射本地安全文案，保留人工处理安全合同', async (t) => {
  const f = await fixture(t);
  for (const code of ['OAUTH_INVALID_AUTH_URL', 'OAUTH_INVALID_INPUT', 'OAUTH_INVALID_PROXY', 'OAUTH_INVALID_TOTP_SECRET',
    'OAUTH_ABORTED', 'OAUTH_TIMEOUT', 'OAUTH_LOGIN_FAILED', 'OAUTH_WORKER_UNAVAILABLE', 'OAUTH_WORKER_PROTOCOL',
    'OAUTH_HTTP_CHALLENGE', 'OAUTH_VERIFICATION_REQUIRED', 'OAUTH_HTTP_REJECTED', 'OAUTH_NETWORK_ERROR', 'OAUTH_SENTINEL_FAILED',
    'OAUTH_INVALID_CREDENTIALS', 'OAUTH_TOTP_REJECTED', 'OAUTH_TOTP_REQUIRED', 'OAUTH_EMAIL_OTP_REQUIRED',
    'OAUTH_PHONE_REQUIRED', 'OAUTH_WORKSPACE_NOT_FOUND', 'OAUTH_WORKSPACE_AMBIGUOUS', 'OAUTH_WORKSPACE_CONFLICT', 'OAUTH_WORKSPACE_INVALID', 'OAUTH_WORKSPACE_REQUIRED', 'OAUTH_ACCOUNT_SELECTION_REQUIRED', 'OAUTH_UNKNOWN_STEP', 'OAUTH_UNTRUSTED_ORIGIN',
    'OAUTH_INVALID_CALLBACK', 'OAUTH_STATE_MISMATCH', 'OAUTH_CALLBACK_ERROR']) {
    await assert.rejects(f.run('known-error', {}, { error: code }), (error) => {
      assertSafe(code)(error);
      if (code === 'OAUTH_HTTP_CHALLENGE') assert.equal(error.message, '上游返回 HTTP 访问挑战，授权未完成，未推送账号');
      if (code === 'OAUTH_HTTP_REJECTED') assert.equal(error.message, '上游返回 HTTP 拒绝，授权未完成，未推送账号');
      if (code === 'OAUTH_ACCOUNT_SELECTION_REQUIRED') assert.equal(error.message, '无法唯一确定授权账号，已停止操作');
      return true;
    });
  }
});

test('spawn 同步/异步失败只返回受控运行环境错误', async (t) => {
  await assert.rejects(loginOpenAI({ authUrl: authUrl(), ...input, spawnWorker: () => { throw new Error('RAW-UPSTREAM-SECRET'); } }), assertSafe('OAUTH_WORKER_UNAVAILABLE'));
  const f = await fixture(t);
  const original = process.env.OAUTH_LOGIN_PYTHON;
  try {
    process.env.OAUTH_LOGIN_PYTHON = '/definitely-missing/RAW-UPSTREAM-SECRET';
    await assert.rejects(f.run(), assertSafe('OAUTH_WORKER_UNAVAILABLE'));
  } finally {
    if (original === undefined) delete process.env.OAUTH_LOGIN_PYTHON; else process.env.OAUTH_LOGIN_PYTHON = original;
  }
});

test('预先取消不启动；onStage abort 原因绝不外泄且回收 worker', async (t) => {
  const controller = new AbortController();
  controller.abort(new Error('RAW-UPSTREAM-SECRET'));
  await assert.rejects(loginOpenAI({ ...input, authUrl: authUrl(), signal: controller.signal, spawnWorker: noSpawn }), assertSafe('OAUTH_ABORTED'));
  const f = await fixture(t);
  const other = new AbortController();
  const stages = [];
  await assert.rejects(f.run('hold', { signal: other.signal, onStage: (stage) => { stages.push(stage); other.abort(new Error('RAW-UPSTREAM-SECRET')); } }), assertSafe('OAUTH_ABORTED'));
  assert.deepEqual(stages, ['password']);
  assertExited(f.calls[0].child);
});

test('异步阶段故障取消 worker；挂起阶段也受全局超时和 abort 控制', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(f.run('success', { onStage: async () => { calls += 1; throw new Error('RAW-UPSTREAM-SECRET'); } }), assertSafe('OAUTH_LOGIN_FAILED'));
  assert.equal(calls, 1);
  const reached = deferred();
  const release = deferred();
  const controller = new AbortController();
  const result = f.run('success', { signal: controller.signal, onStage: async () => { reached.resolve(); await release.promise; } });
  await reached.promise;
  controller.abort();
  await assert.rejects(result, assertSafe('OAUTH_ABORTED'));
  release.resolve();
  await assert.rejects(f.run('success', { timeoutMs: 300, onStage: async () => new Promise(() => {}) }), assertSafe('OAUTH_TIMEOUT'));
  assertExited(f.calls.at(-1).child);
});

test('成功也必须等待异步阶段完成；慢回调不并发、不提前返回', async (t) => {
  const f = await fixture(t);
  const reached = deferred();
  const release = deferred();
  let finished = false;
  const stages = [];
  const result = f.run('success', { onStage: async (stage) => {
    if (stage === 'password') { reached.resolve(); await release.promise; }
    stages.push(stage);
  } }).then((value) => { finished = true; return value; });
  await reached.promise;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(finished, false);
  assert.ok(!stages.includes('totp'));
  assert.deepEqual(f.calls[0].acks.map(({ stage }) => stage), ['warmup', 'csrf', 'authorizing', 'email']);
  assert.equal(await readFile(f.path.replace('.py', '.effects'), 'utf8'), 'warmup\ncsrf\nauthorizing\nemail\n',
    'password 的模拟 HTTP 副作用必须等 onStage 完成并收到 ACK');
  assert.equal(f.calls[0].child.stdin.writableEnded, false, '阶段门控期间 stdin 必须保持打开');
  release.resolve();
  await result;
  assert.equal(stages.at(-1), 'consent');
});

test('阶段回调失败/取消/超时均不 ACK，不触发后续模拟 HTTP 副作用', async (t) => {
  for (const reason of ['throw', 'reject', 'abort', 'late-abort', 'timeout']) {
    const f = await fixture(t);
    const reached = deferred();
    const release = deferred();
    const controller = new AbortController();
    const expected = ['throw', 'reject'].includes(reason) ? 'OAUTH_LOGIN_FAILED'
      : reason === 'timeout' ? 'OAUTH_TIMEOUT' : 'OAUTH_ABORTED';
    const onStage = reason === 'throw' ? () => { reached.resolve(); throw new Error('RAW-UPSTREAM-SECRET'); }
      : async () => {
        reached.resolve();
        if (reason === 'reject') throw new Error('RAW-UPSTREAM-SECRET');
        if (reason === 'abort') controller.abort(new Error('RAW-UPSTREAM-SECRET'));
        if (reason === 'late-abort' || reason === 'timeout') await release.promise;
      };
    const rejected = assert.rejects(f.run('gated-side-effect', {
      signal: controller.signal, timeoutMs: reason === 'timeout' ? 500 : 3000, onStage,
    }), assertSafe(expected));
    await reached.promise;
    if (reason === 'late-abort') controller.abort(new Error('RAW-UPSTREAM-SECRET'));
    await rejected;
    // 已取消的回调即使晚到成功，也不能补发 ACK。
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.calls[0].acks, []);
    assert.equal(f.calls[0].writes.length, 1, '只能写首行凭据 JSON，失败后不能写 ACK');
    assert.equal(await readFile(f.path.replace('.py', '.acks'), 'utf8'), '');
    assert.equal(await readFile(f.path.replace('.py', '.effects'), 'utf8'), '');
    assertExited(f.calls[0].child);
  }
});

test('ACK 写入已关闭的 worker stdin 安全失败并回收进程', async (t) => {
  const f = await fixture(t);
  const stages = [];
  await assert.rejects(f.run('ack-pipe-closed', { onStage: (stage) => { stages.push(stage); } }), assertSafe('OAUTH_WORKER_PROTOCOL'));
  assert.deepEqual(stages, ['password']);
  assertExited(f.calls[0].child);
  assert.equal(await readFile(f.path.replace('.py', '.effects'), 'utf8'), '');
});

async function isRunning(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (process.platform === 'linux') {
    try { if (/\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'))) return false; } catch {}
  }
  return true;
}
test('POSIX 取消/timeout 回收 Python 及忽略 SIGTERM 的子孙进程', { skip: process.platform === 'win32' }, async (t) => {
  for (const reason of ['abort', 'timeout']) {
    const f = await fixture(t);
    const controller = new AbortController();
    let ready = false;
    await assert.rejects(f.run('descendants', { timeoutMs: 650, signal: controller.signal,
      onStage: () => { ready = true; if (reason === 'abort') controller.abort(); } }), assertSafe(reason === 'abort' ? 'OAUTH_ABORTED' : 'OAUTH_TIMEOUT'));
    assert.equal(ready, true, '真实子孙已建立才测试回收');
    assertExited(f.calls[0].child);
    const descendants = (await readFile(f.path.replace('.py', '.pids'), 'utf8')).split(',').map(Number);
    assert.equal(descendants.length, 2);
    for (const pid of [f.calls[0].child.pid, ...descendants]) {
      for (let i = 0; i < 100 && await isRunning(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(await isRunning(pid), false, '取消/超时返回后不能遗留运行中的子孙');
    }
  }
});


const challengeEndpoints = [
  'warmup', 'csrf', 'web_signin', 'web_session', 'web_callback', 'authorize',
  'password', 'email', 'totp', 'workspace', 'session', 'sentinel_sdk', 'sentinel_request', 'unknown',
];

function challengeProcess(t, script, argument, options = {}) {
  const calls = [];
  const stdout = [];
  const stderr = [];
  t.after(() => {
    for (const child of calls) {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {}
    }
  });
  const result = loginOpenAI({ ...input, proxy, authUrl: authUrl(), timeoutMs: 3000, ...options,
    spawnWorker: (python, args, spawnOptions) => {
      const child = spawn(python, ['-u', '-c', script, argument ?? args[1]], spawnOptions);
      calls.push(child);
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      return child;
    },
  });
  return { result, calls, stdout, stderr };
}

function challengeFrame(t, event) {
  return challengeProcess(t, `import json, sys
json.loads(sys.stdin.readline())
print(sys.argv[1], flush=True)
sys.exit(1)
`, JSON.stringify(event));
}

const invalidChallenges = [null, [], 'RAW-UPSTREAM-SECRET', {}, { endpoint: 'csrf' }, { status: 403 },
  { endpoint: 'authorizing', status: 403 }, { endpoint: 'https://auth.openai.com/log-in?token=RAW-UPSTREAM-SECRET', status: 403 },
  { endpoint: 'csrf', status: '403' }, { endpoint: 'csrf', status: true }, { endpoint: 'csrf', status: 403.5 },
  { endpoint: 'csrf', status: 99 }, { endpoint: 'csrf', status: 600 },
  ...['url', 'query', 'body', 'header', 'headers', 'cookie', 'ray', 'password', 'token', '__proto__'].map((key) => (
    { endpoint: 'csrf', status: 403, [key]: 'RAW-UPSTREAM-SECRET' }
  )),
];

test('sanitizeOAuthChallenge 严格白名单、数值边界、安全副本及恶意注入对象', () => {
  let getterReads = 0;
  for (const endpoint of challengeEndpoints) {
    for (const status of [100, 200, 302, 403, 429, 599]) {
      const value = { endpoint, status };
      const sanitized = sanitizeOAuthChallenge(value);
      assert.deepEqual(sanitized, value);
      assert.notEqual(sanitized, value);
      value.endpoint = 'RAW-UPSTREAM-SECRET';
      assert.equal(sanitized.endpoint, endpoint);
    }
  }
  for (const value of [...invalidChallenges, undefined, { endpoint: 'csrf', status: Infinity },
    { endpoint: 'csrf', status: NaN }, { endpoint: 'csrf', status: new Number(403) },
    Object.assign(Object.create({ endpoint: 'csrf' }), { status: 403 }),
    { endpoint: 'csrf', status: 403, [Symbol('secret')]: 'RAW-UPSTREAM-SECRET' },
    Object.defineProperty({ endpoint: 'csrf', status: 403 }, 'token', { value: 'RAW-UPSTREAM-SECRET' }),
    { get endpoint() { getterReads += 1; return 'RAW-UPSTREAM-SECRET'; }, status: 403 },
    new Proxy({}, { ownKeys() { throw new Error('RAW-UPSTREAM-SECRET'); } }),
  ]) assert.equal(sanitizeOAuthChallenge(value), null);
  assert.equal(getterReads, 0, '不能执行秘密 getter');
});

test('受限 worker challenge 协议保留所有端点标签和 HTTP 状态，旧无 challenge 协议兼容', async (t) => {
  for (const endpoint of challengeEndpoints) {
    const f = challengeFrame(t, { type: 'error', code: 'OAUTH_HTTP_CHALLENGE', challenge: { endpoint, status: 403 } });
    await assert.rejects(f.result, (error) => {
      assertSafe('OAUTH_HTTP_CHALLENGE')(error);
      assert.deepEqual(error.challenge, { endpoint, status: 403 });
      return true;
    });
    assert.equal(f.calls.length, 1, '诊断层不得自动重试');
    assertExited(f.calls[0]);
  }
  for (const code of ['OAUTH_HTTP_CHALLENGE', 'OAUTH_INVALID_CREDENTIALS', 'OAUTH_HTTP_REJECTED']) {
    const f = challengeFrame(t, { type: 'error', code });
    await assert.rejects(f.result, (error) => {
      assertSafe(code)(error);
      assert.equal(Object.hasOwn(error, 'challenge'), false);
      return true;
    });
  }
});

test('非法 challenge、额外字段或其他 error code 带 challenge 均协议错误且不泄密', async (t) => {
  const events = invalidChallenges.map((challenge) => ({ type: 'error', code: 'OAUTH_HTTP_CHALLENGE', challenge }));
  for (const code of ['OAUTH_HTTP_REJECTED', 'OAUTH_INVALID_CREDENTIALS', 'OAUTH_NETWORK_ERROR', 'OAUTH_WORKER_PROTOCOL', 'RAW-UPSTREAM-SECRET']) {
    events.push({ type: 'error', code, challenge: { endpoint: 'password', status: 403 } });
  }
  events.push({ type: 'error', code: 'OAUTH_HTTP_CHALLENGE', challenge: { endpoint: 'csrf', status: 403 }, url: 'RAW-UPSTREAM-SECRET' });
  for (const event of events) {
    const f = challengeFrame(t, event);
    await assert.rejects(f.result, (error) => {
      assertSafe('OAUTH_WORKER_PROTOCOL')(error);
      assert.equal(Object.hasOwn(error, 'challenge'), false);
      return true;
    });
    assertExited(f.calls[0]);
  }
});

test('真实 Python worker → NDJSON → Node 挑战安全诊断闭环，无秘密和 HTTP 重试', async (t) => {
  const f = challengeProcess(t, `import sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(sys.argv[1]).resolve().parents[1]))
from oauth_login import worker
from oauth_login.transport import Transport
class Session:
    cookies = SimpleNamespace(jar=[])
    def __init__(self, **kwargs):
        self.calls = 0
    def request(self, *args, **kwargs):
        self.calls += 1
        assert self.calls == 1
        kwargs['content_callback'](b'<html>cf-chl- RAW-UPSTREAM-SECRET</html>')
        return SimpleNamespace(status_code=403, headers={'Content-Type': 'text/html', 'CF-Mitigated': 'challenge',
            'CF-Ray': 'RAW-UPSTREAM-SECRET', 'Set-Cookie': 'RAW-UPSTREAM-SECRET'})
    def close(self):
        pass
worker.Transport = lambda *args: Transport(*args, session_factory=Session)
sys.exit(worker.main())
`, undefined, { onStage: (stage) => { assert.equal(stage, 'warmup'); } });
  await assert.rejects(f.result, (error) => {
    assertSafe('OAUTH_HTTP_CHALLENGE')(error);
    assert.deepEqual(error.challenge, { endpoint: 'warmup', status: 403 });
    return true;
  });
  assert.equal(f.calls.length, 1);
  assertExited(f.calls[0]);
  assert.equal(Buffer.concat(f.stderr).toString(), '');
  const output = Buffer.concat(f.stdout).toString();
  assert.deepEqual(output.trim().split('\n').map((line) => JSON.parse(line)), [
    { type: 'stage', stage: 'warmup' },
    { type: 'error', code: 'OAUTH_HTTP_CHALLENGE', challenge: { endpoint: 'warmup', status: 403 } },
  ]);
  for (const secret of [input.email, input.password, SECRET, proxy.username, proxy.password, STATE, 'RAW-UPSTREAM-SECRET']) {
    assert.ok(!output.includes(secret));
  }
});
