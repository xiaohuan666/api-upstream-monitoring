import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { normalizeTotpSecret } from './oauth-totp.mjs';

const ORIGIN = 'https://auth.openai.com';
const REDIRECTS = new Set(['http://localhost:1455/auth/callback', 'http://127.0.0.1:1455/auth/callback']);
const STAGES = new Set(['warmup', 'csrf', 'authorizing', 'email', 'password', 'totp', 'consent']);
const CHALLENGE_ENDPOINTS = new Set([
  'warmup', 'csrf', 'web_signin', 'web_session', 'web_callback', 'authorize',
  'password', 'email', 'totp', 'workspace', 'session', 'sentinel_sdk', 'sentinel_request', 'unknown',
]);
const WORKER_PATH = fileURLToPath(new URL('../tools/oauth_login/worker.py', import.meta.url));
const MAX_LINE_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_EVENTS = 128;
const KILL_GRACE_MS = 100;
const ERROR_MESSAGES = Object.freeze({
  OAUTH_INVALID_AUTH_URL: '授权地址或回调参数无效',
  OAUTH_INVALID_INPUT: '登录参数无效',
  OAUTH_INVALID_PROXY: '代理配置无效',
  OAUTH_INVALID_TOTP_SECRET: '动态口令密钥格式无效，请核对后重新提交',
  OAUTH_ABORTED: '授权操作已取消',
  OAUTH_TIMEOUT: '授权操作超时，请人工确认后重试',
  OAUTH_LOGIN_FAILED: 'HTTP 授权失败，已停止操作',
  OAUTH_WORKER_UNAVAILABLE: 'HTTP 授权运行环境不可用',
  OAUTH_WORKER_PROTOCOL: 'HTTP 授权进程响应无效',
  OAUTH_HTTP_CHALLENGE: '上游返回 HTTP 访问挑战，授权未完成，未推送账号',
  OAUTH_VERIFICATION_REQUIRED: '登录页面需要额外验证，已停止操作，请人工处理',
  OAUTH_HTTP_REJECTED: '上游返回 HTTP 拒绝，授权未完成，未推送账号',
  OAUTH_NETWORK_ERROR: '登录网络请求失败，请检查代理',
  OAUTH_SENTINEL_FAILED: '登录校验未能完成，已停止操作',
  OAUTH_INVALID_CREDENTIALS: '登录凭据未获接受，请人工确认',
  OAUTH_TOTP_REJECTED: '动态口令未获接受，请人工确认',
  OAUTH_TOTP_REQUIRED: '登录需要动态口令密钥，请补充后重试',
  OAUTH_EMAIL_OTP_REQUIRED: '登录需要邮箱验证码，请人工处理',
  OAUTH_PHONE_REQUIRED: '登录需要手机验证，请人工处理',
  OAUTH_WORKSPACE_NOT_FOUND: '未发现可验证的工作空间，已停止授权，未推送账号',
  OAUTH_WORKSPACE_AMBIGUOUS: '检测到多个工作空间，未自动选择，未推送账号',
  OAUTH_WORKSPACE_CONFLICT: '工作空间信息来源不一致，已停止授权，未推送账号',
  OAUTH_WORKSPACE_INVALID: '工作空间数据格式无法完整解析，已停止授权，未推送账号',
  OAUTH_WORKSPACE_REQUIRED: '无法唯一确定工作空间，请人工处理',
  OAUTH_ACCOUNT_SELECTION_REQUIRED: '无法唯一确定授权账号，已停止操作',
  OAUTH_UNKNOWN_STEP: '登录步骤无法识别，需要人工处理',
  OAUTH_UNTRUSTED_ORIGIN: '登录页面来源不可信，已停止授权',
  OAUTH_INVALID_CALLBACK: '授权回调地址或授权码无效',
  OAUTH_STATE_MISMATCH: '授权回调状态不匹配，请重新授权',
  OAUTH_CALLBACK_ERROR: '授权被拒绝或未完成，请人工确认',
});

/**
 * 返回固定枚举与 HTTP 状态的安全副本；非法对象不会进入日志。
 * @param {unknown} value
 * @returns {{endpoint: string, status: number} | null}
 */
export function sanitizeOAuthChallenge(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('endpoint') || !keys.includes('status')) return null;
    // 注入对象可能带 getter：不执行访问器，也不保留源对象引用。
    const endpoint = Object.getOwnPropertyDescriptor(value, 'endpoint');
    const status = Object.getOwnPropertyDescriptor(value, 'status');
    if (!endpoint || !status || !Object.hasOwn(endpoint, 'value') || !Object.hasOwn(status, 'value')
      || !CHALLENGE_ENDPOINTS.has(endpoint.value) || !Number.isInteger(status.value)
      || status.value < 100 || status.value > 599) return null;
    return { endpoint: endpoint.value, status: status.value };
  } catch { return null; }
}

function failure(code, challenge = null) {
  const statusCode = code.startsWith('OAUTH_INVALID_') && code !== 'OAUTH_INVALID_CALLBACK' && code !== 'OAUTH_INVALID_CREDENTIALS' ? 400
    : code === 'OAUTH_ABORTED' ? 499 : code === 'OAUTH_TIMEOUT' ? 504
      : ['OAUTH_LOGIN_FAILED', 'OAUTH_WORKER_UNAVAILABLE', 'OAUTH_WORKER_PROTOCOL', 'OAUTH_NETWORK_ERROR'].includes(code) ? 502 : 422;
  return Object.assign(new Error(ERROR_MESSAGES[code]), { code, statusCode, needsAttention: true, safe: true,
    ...(challenge ? { challenge } : {}),
  });
}

function validateAuth(authUrl) {
  let url;
  try { if (typeof authUrl === 'string' && authUrl.length <= 16384) url = new URL(authUrl); } catch { /* 不暴露输入。 */ }
  if (!url || url.origin !== ORIGIN || !['/oauth/authorize', '/authorize'].includes(url.pathname) || url.username || url.password || url.hash
    || new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length
    || !REDIRECTS.has(url.searchParams.get('redirect_uri'))
    || !url.searchParams.get('state') || url.searchParams.get('state').length > 1024
    || /[\s\x00-\x1f\x7f]/.test(url.searchParams.get('state'))
    || url.searchParams.get('response_type') !== 'code') {
    throw failure('OAUTH_INVALID_AUTH_URL');
  }
  return { state: url.searchParams.get('state'), redirectUri: url.searchParams.get('redirect_uri') };
}

/** 提交前代理预校验；保留 SOCKS5H 的远程 DNS 和认证语义，不静默直连或降级。 */
export function oauthLoginProxyOptions(proxy) {
  if (proxy == null) return {};
  if (typeof proxy !== 'object' || Array.isArray(proxy)) throw failure('OAUTH_INVALID_PROXY');
  const { protocol, host, port, username, password } = proxy;
  const rawHost = typeof host === 'string' ? host.trim() : '';
  const address = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const validHost = isIP(address) || (/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(address)
    && address.split('.').every((label) => label.length && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-')));
  if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol) || !validHost
    || !(typeof port === 'number' || (typeof port === 'string' && /^\d+$/.test(port)))
    || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535
    || (username != null && (typeof username !== 'string' || username.length > 4096 || /[\x00-\x1f\x7f]/.test(username)))
    || (password != null && (typeof password !== 'string' || password.length > 4096 || /[\x00-\x1f\x7f]/.test(password)))) {
    throw failure('OAUTH_INVALID_PROXY');
  }
  return { proxy: {
    server: `${protocol}://${isIP(address) === 6 ? `[${address}]` : address}:${Number(port)}`,
    ...(username ? { username } : {}), ...(password ? { password } : {}),
  } };
}

function exactKeys(event, keys) {
  return Object.keys(event).length === keys.length && keys.every((key) => Object.hasOwn(event, key));
}

function callbackResult(event, auth) {
  // 回调不通过网络访问；worker 仅交付解析后的标量，Node 再独立核对绑定关系。
  if (event.redirectUri !== auth.redirectUri) throw failure('OAUTH_INVALID_CALLBACK');
  if (event.state !== auth.state) throw failure('OAUTH_STATE_MISMATCH');
  if (typeof event.code !== 'string' || !event.code || event.code.length > 8192 || /[\x00-\x20\x7f]/.test(event.code)) {
    throw failure('OAUTH_INVALID_CALLBACK');
  }
  return { code: event.code, state: auth.state, redirectUri: auth.redirectUri };
}

function workerEnvironment() {
  // 使用允许列表，避免新增加的数据库/admin/token/proxy 环境变量被意外继承。
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1',
  };
}

async function terminateWorker(child) {
  if (!child?.pid) return;
  const kill = (signal) => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* 已退出；绝不把操作系统错误向外传播。 */ }
  };
  kill('SIGTERM');
  // 即使 Python 先退出也要清理继承同一进程组、忽略 SIGTERM 的子孙。
  await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
  kill('SIGKILL');
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => child.once('exit', resolve));
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

/**
 * 每次调用独占 Python worker。秘密仅经 stdin JSON；stderr 丢弃、stdout 有界且严格验协议。
 * spawnWorker 是可信代码的测试注入点，与 node:child_process.spawn 签名一致。
 * 首行输入后保持 stdin 打开；onStage 串行 await 后才 ACK 放行 worker 的下一步。
 * 失败/取消不 ACK 并回收进程组；成功必须等全部输出及正常退出。
 */
export async function loginOpenAI({ authUrl, email, password, totpSecret, proxy = null, onStage, signal,
  timeoutMs = 120_000, spawnWorker = spawn } = {}) {
  const auth = validateAuth(authUrl);
  oauthLoginProxyOptions(proxy);
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 320
    || typeof password !== 'string' || !password || password.length > 4096
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || typeof spawnWorker !== 'function' || (onStage != null && typeof onStage !== 'function')
    || (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) {
    throw failure('OAUTH_INVALID_INPUT');
  }
  let secret;
  try { secret = normalizeTotpSecret(totpSecret) || null; } catch { throw failure('OAUTH_INVALID_TOTP_SECRET'); }
  if (signal?.aborted) throw failure('OAUTH_ABORTED');
  const workerProxy = proxy == null ? null : Object.fromEntries(
    ['protocol', 'host', 'port', 'username', 'password'].filter((key) => proxy[key] != null).map((key) => [key, proxy[key]]),
  );
  const workerInput = `${JSON.stringify({ authUrl, email: email.trim(), password, totpSecret: secret, proxy: workerProxy, timeoutMs })}\n`;
  if (Buffer.byteLength(workerInput) > 64 * 1024) throw failure('OAUTH_INVALID_INPUT');
  let child;
  let stopError;
  let rejectStop;
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  const stop = (error) => { if (!stopError) { stopError = error; rejectStop(error); } };
  const abort = () => stop(failure('OAUTH_ABORTED'));
  const timer = setTimeout(() => stop(failure('OAUTH_TIMEOUT')), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });

  const work = () => new Promise((resolve) => {
    if (signal?.aborted) { abort(); return; }
    try {
      child = spawnWorker(process.env.OAUTH_LOGIN_PYTHON || 'python3', ['-u', WORKER_PATH], {
        shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: workerEnvironment(),
      });
    } catch { stop(failure('OAUTH_WORKER_UNAVAILABLE')); return; }
    let buffer = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let eventCount = 0;
    let terminal;
    let stages = Promise.resolve();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const protocolError = () => stop(failure('OAUTH_WORKER_PROTOCOL'));
    const readEvent = (line) => {
      if (++eventCount > MAX_EVENTS || line.length > MAX_LINE_BYTES || !line.length || terminal) { protocolError(); return; }
      let event;
      try { event = JSON.parse(decoder.decode(line)); } catch { protocolError(); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) { protocolError(); return; }
      if (event.type === 'stage' && exactKeys(event, ['type', 'stage']) && STAGES.has(event.stage)) {
        stages = stages.then(async () => {
          if (stopError) return;
          try { await onStage?.(event.stage); } catch { stop(failure('OAUTH_LOGIN_FAILED')); return; }
          // 持久化/租约检查完成前不给 worker 放行；跨 await 必须再次检查取消。
          if (stopError) return;
          await new Promise((acknowledged) => {
            try {
              child.stdin.write(`${JSON.stringify({ type: 'ack', stage: event.stage })}\n`, (error) => {
                if (error) protocolError();
                acknowledged();
              });
            } catch { protocolError(); acknowledged(); }
          });
        });
      } else if (event.type === 'result' && exactKeys(event, ['type', 'code', 'state', 'redirectUri'])) {
        try { terminal = { result: callbackResult(event, auth) }; } catch (error) { stop(error); }
      } else if (event.type === 'error' && (exactKeys(event, ['type', 'code']) || exactKeys(event, ['type', 'code', 'challenge']))
        && typeof event.code === 'string' && Object.hasOwn(ERROR_MESSAGES, event.code)) {
        const hasChallenge = Object.hasOwn(event, 'challenge');
        const challenge = hasChallenge ? sanitizeOAuthChallenge(event.challenge) : null;
        if (hasChallenge && (event.code !== 'OAUTH_HTTP_CHALLENGE' || !challenge)) { protocolError(); return; }
        terminal = { error: failure(event.code, challenge) };
        // 明确失败不等待卡住的阶段或 worker 退出；错误 exit1 不会掩盖受控分类。
        stop(terminal.error);
      } else { protocolError(); }
    };
    child.on('error', () => stop(failure('OAUTH_WORKER_UNAVAILABLE')));
    child.stdin.on('error', () => stop(failure('OAUTH_WORKER_PROTOCOL')));
    child.stdout.on('error', protocolError);
    child.stderr.on('error', protocolError);
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) protocolError();
    });
    child.stdout.on('data', (chunk) => {
      if (stopError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) { protocolError(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while (!stopError && (newline = buffer.indexOf(10)) !== -1) {
        readEvent(buffer.subarray(0, newline));
        buffer = buffer.subarray(newline + 1);
      }
      if (buffer.length > MAX_LINE_BYTES) protocolError();
    });
    child.on('exit', (code, exitSignal) => { if (code !== 0 || exitSignal) protocolError(); });
    child.on('close', (code, exitSignal) => {
      if (stopError) return;
      if (code !== 0 || exitSignal || buffer.length || !terminal) { protocolError(); return; }
      void stages.then(() => {
        if (stopError) return;
        if (terminal.error) stop(terminal.error);
        else resolve(terminal.result);
      }).catch(() => stop(failure('OAUTH_LOGIN_FAILED')));
    });
    try { child.stdin.write(workerInput); }
    catch { protocolError(); }
  });

  try { return await Promise.race([stopped, work()]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await terminateWorker(child);
  }
}
