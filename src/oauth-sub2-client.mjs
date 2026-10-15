import { readOAuthIdentity } from './oauth-account-identity.mjs';
import { normalizeImportOptions, importModelMapping } from './oauth-import-options.mjs';

// OAuth 字段映射来源：zc-zhangchen/any-auto-register
// @44c27a8a2ae5e08d37bb68ab007a335782b43467 platforms/chatgpt/sub2api_upload.py。
// 仅移植已授权的非商业已有账号映射；不沿用伪造有效期、固定 client/model mapping 或关闭 TLS。
// 接口核对：本地 sub2api admin/{account,proxy,openai_oauth}_handler.go、response.go。

const AUTH_CLAIM = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MESSAGES = Object.freeze({
  invalid_input: 'OAuth 管理请求参数无效',
  invalid_credentials: 'OAuth 换码结果缺少有效令牌或可信到期时间',
  invalid_identity: 'OAuth 换码结果缺少或包含冲突的账号身份，已停止入池',
  email_mismatch: 'OAuth 换码结果邮箱不匹配或无法核实',
  sub2_network_error: 'Sub2API 请求连接失败，请核实远端结果',
  sub2_timeout: 'Sub2API 请求超时，请核实远端结果',
  sub2_http_error: 'Sub2API 拒绝请求',
  sub2_invalid_response: 'Sub2API 响应无效，请核实远端结果',
  sub2_pagination_error: 'Sub2API 分页结果不完整或已变化，无法安全对账',
  sub2_scan_limit: 'Sub2API 列表超出安全扫描上限，无法安全对账',
  mixed_channel_warning: '所选分组存在混合渠道冲突，需要人工处理',
  sub2_idempotency_pending: 'Sub2API 幂等请求尚未确认完成，请核实远端结果',
});

export class OAuthSub2ClientError extends Error {
  constructor(code, { statusCode = 502, httpStatus = null, ambiguous = false, needsAttention = false } = {}) {
    // 只有本地固定文案可进入 safe 错误；不保留上游 body、异常、URL 或 cause。
    const controlledCode = Object.hasOwn(MESSAGES, code) ? code : 'sub2_invalid_response';
    super(MESSAGES[controlledCode]);
    this.name = 'OAuthSub2ClientError';
    this.safe = true;
    this.code = controlledCode;
    this.errorCode = controlledCode;
    this.statusCode = statusCode;
    this.httpStatus = httpStatus;
    this.ambiguous = ambiguous;
    this.needsAttention = needsAttention;
  }
}

function failInput(code = 'invalid_input') {
  throw new OAuthSub2ClientError(code, { statusCode: 400 });
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value, max = 1024) {
  return typeof value === 'string' && value.length <= max ? value.trim() : '';
}
function requiredText(value, max = 1024) {
  const result = text(value, max);
  if (!result || /[\r\n\0]/u.test(result)) failInput();
  return result;
}
function positiveId(value) {
  const id = typeof value === 'number' || (typeof value === 'string' && /^\d+$/u.test(value))
    ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) failInput();
  return id;
}
function optionalProxyId(value) {
  return value == null ? null : positiveId(value);
}
function normalizeEmail(value) {
  const email = text(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : '';
}
function decodeClaims(token) {
  if (typeof token !== 'string' || token.length > 128_000) return {};
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/u.test(parts[1])) return {};
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return record(claims) ? claims : {};
  } catch {
    return {};
  }
}
function emailClaims(info) {
  const access = decodeClaims(info.access_token);
  const id = decodeClaims(info.id_token);
  return [info.email, access.email, access[PROFILE_CLAIM]?.email, id.email, id[PROFILE_CLAIM]?.email];
}
function expirySeconds(value) {
  if (Number.isSafeInteger(value) && value > 0 && value <= 253_402_300_799) return value;
  // Sub2API TokenInfo 是 unix 秒，而持久 credentials 是 RFC3339；限制四位年份，拒绝把毫秒当秒。
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms > 0 && ms <= 253_402_300_799_000 ? Math.floor(ms / 1000) : null;
  }
  return null;
}

/**
 * 仅接受受信任 Sub2API 换码结果；JWT 解码用于字段核对，不进行签名验证，不能用于认证外部输入。
 * now 可为 Date、Unix 毫秒或返回以上值的函数，默认 Date.now()。返回值包含秘密，仅限后端内存。
 */
export function buildOAuthCredentials(tokenInfo, { email, now = Date.now() } = {}) {
  if (!record(tokenInfo)) failInput('invalid_credentials');
  const accessToken = text(tokenInfo.access_token, 128_000);
  const refreshToken = text(tokenInfo.refresh_token, 128_000);
  if (!accessToken || !refreshToken || /[\s\0]/u.test(accessToken + refreshToken)) {
    failInput('invalid_credentials');
  }
  const expectedEmail = normalizeEmail(email);
  const candidates = emailClaims(tokenInfo).filter((value) => value != null && value !== '');
  if (!expectedEmail || candidates.length === 0 || candidates.some((value) => normalizeEmail(value) !== expectedEmail)) {
    failInput('email_mismatch');
  }
  const access = decodeClaims(accessToken);
  const id = decodeClaims(tokenInfo.id_token);
  const accessAuth = record(access[AUTH_CLAIM]) ? access[AUTH_CLAIM] : {};
  const idAuth = record(id[AUTH_CLAIM]) ? id[AUTH_CLAIM] : {};
  let current;
  try {
    const value = typeof now === 'function' ? now() : now;
    current = value instanceof Date ? value.getTime() : value;
  } catch {
    failInput('invalid_credentials');
  }
  if (typeof current !== 'number' || !Number.isFinite(current)) failInput('invalid_credentials');
  const suppliedExpiry = tokenInfo.expires_at;
  let expiresAt = suppliedExpiry == null ? expirySeconds(access.exp) : expirySeconds(suppliedExpiry);
  // JWT 若携带 exp，也必须仍有效；使用更早的可信到期时间，不能用响应延长已过期 JWT。
  if (Object.hasOwn(access, 'exp')) {
    const jwtExpiry = expirySeconds(access.exp);
    if (jwtExpiry == null) failInput('invalid_credentials');
    expiresAt = expiresAt == null ? null : Math.min(expiresAt, jwtExpiry);
  }
  if (expiresAt == null || expiresAt * 1000 <= current || !Number.isFinite(new Date(expiresAt * 1000).getTime())) {
    failInput('invalid_credentials');
  }
  const credentials = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: new Date(expiresAt * 1000).toISOString(),
    email: expectedEmail,
  };
  const organizations = [idAuth.organizations, accessAuth.organizations]
    .flatMap((items) => Array.isArray(items) ? items : []);
  const fields = {
    chatgpt_account_id: [tokenInfo.chatgpt_account_id, tokenInfo.account_id, accessAuth.chatgpt_account_id, idAuth.chatgpt_account_id],
    chatgpt_user_id: [tokenInfo.chatgpt_user_id, tokenInfo.user_id, accessAuth.chatgpt_user_id, idAuth.chatgpt_user_id],
    organization_id: [tokenInfo.organization_id, idAuth.organization_id, accessAuth.organization_id, ...organizations.map((item) => item?.id)],
    client_id: [tokenInfo.client_id, access.client_id, id.client_id],
    plan_type: [tokenInfo.plan_type, accessAuth.chatgpt_plan_type, idAuth.chatgpt_plan_type],
  };
  for (const [key, values] of Object.entries(fields)) {
    const value = values.map((item) => text(item)).find((item) => item && !/[\r\n\0]/u.test(item));
    if (value) credentials[key] = value;
  }
  // Require a seat, not merely a workspace; reject disagreement rather than choosing a convenient source.
  for (const key of ['chatgpt_account_id', 'chatgpt_user_id']) {
    const supplied = fields[key].filter((value) => value != null && value !== '');
    if (!supplied.length || supplied.some((value) => typeof value !== 'string' || value !== credentials[key])) failInput('invalid_identity');
  }
  const identity = readOAuthIdentity(credentials);
  if (!identity.accountId || !identity.userId) failInput('invalid_identity');
  const idToken = text(tokenInfo.id_token, 128_000);
  if (idToken && !/[\s\0]/u.test(idToken)) credentials.id_token = idToken;
  if (Number.isSafeInteger(tokenInfo.expires_in) && tokenInfo.expires_in > 0) credentials.expires_in = tokenInfo.expires_in;
  return credentials;
}

function assertShape(condition) {
  if (!condition) throw new Error('Invalid shape');
}
function normalizeProxy(proxy) {
  assertShape(record(proxy) && typeof proxy.name === 'string' && typeof proxy.host === 'string'
    && ['http', 'https', 'socks5', 'socks5h'].includes(proxy.protocol)
    && Number.isInteger(proxy.port) && proxy.port >= 1 && proxy.port <= 65535
    && typeof proxy.status === 'string'
    && (proxy.username == null || typeof proxy.username === 'string')
    && (proxy.password == null || typeof proxy.password === 'string'));
  const expiresAt = proxy.expires_at == null ? null : new Date(proxy.expires_at);
  assertShape(expiresAt == null || Number.isFinite(expiresAt.getTime()));
  return {
    name: proxy.name, id: positiveId(proxy.id), protocol: proxy.protocol, host: proxy.host,
    port: proxy.port, username: proxy.username ?? '', password: proxy.password ?? '',
    status: proxy.status, expiresAt: expiresAt?.toISOString() ?? null,
  };
}
function idempotencyHeaders(value) {
  // 不生成、不替换稳定键；与 Sub2API 的可打印 ASCII 长度约束一致。
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,128}$/u.test(value)) failInput();
  return { 'idempotency-key': value };
}

// DTO completeness only, not success: caller must compare email/seat/proxy/groups and persisted settings.
function hasImportReconciliationFields(account, options, verifyProtection = false) {
  const credentials = account.credentials;
  const extra = account.extra;
  return typeof account.platform === 'string' && typeof account.type === 'string'
    && record(credentials) && ['email', 'chatgpt_account_id', 'chatgpt_user_id'].every((key) => Object.hasOwn(credentials, key))
    && (options.modelMode === 'unrestricted' || Object.hasOwn(credentials, 'model_mapping'))
    && (!options.planType || Object.hasOwn(credentials, 'plan_type'))
    && record(extra)
    && (!verifyProtection || typeof extra.anti_degradation === 'boolean')
    && (options.fingerprintMode === 'off' || Object.hasOwn(extra, 'codex_fingerprint_mode'))
    && ['openai_oauth_responses_websockets_v2_mode', 'openai_oauth_responses_websockets_v2_enabled'].every((key) => Object.hasOwn(extra, key))
    && Array.isArray(account.group_ids) && Object.hasOwn(account, 'proxy_id')
    && ['concurrency', 'priority', 'rate_multiplier', 'auto_pause_on_expired', 'schedulable'].every((key) => Object.hasOwn(account, key))
    && (options.loadFactor === null || Object.hasOwn(account, 'load_factor'));
}

/** 后端专用管理客户端；代理认证和完整账号候选不得传给前端。请求不自动重试。 */
export function createOAuthSub2Client({ baseUrl, adminKey, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    failInput();
  }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) failInput();
  const key = requiredText(adminKey, 8192);
  const prefix = base.toString().replace(/\/+$/u, '');

  async function request(method, path, { body, headers = {}, transform = (data) => data } = {}) {
    const writing = method !== 'GET';
    const controller = new AbortController();
    let httpStatus = null;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new OAuthSub2ClientError('sub2_timeout', { statusCode: 504, httpStatus, ambiguous: writing }));
        controller.abort();
      }, timeoutMs);
    });
    const operation = async () => {
      let response;
      let raw;
      try {
        response = await fetchImpl(`${prefix}${path}`, {
          method,
          headers: { accept: 'application/json', 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          redirect: 'error',
        });
        if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) {
          throw new Error('Invalid response');
        }
        httpStatus = response.status;
        raw = await response.text();
      } catch {
        throw new OAuthSub2ClientError('sub2_network_error', { httpStatus, ambiguous: writing && (httpStatus == null || httpStatus < 400 || httpStatus >= 500 || httpStatus === 408) });
      }
      let payload;
      try {
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error('Invalid body');
        payload = JSON.parse(raw);
      } catch {
        if (httpStatus >= 200 && httpStatus < 300) {
          throw new OAuthSub2ClientError('sub2_invalid_response', { httpStatus, ambiguous: writing });
        }
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        if (httpStatus === 409 && payload?.error === 'mixed_channel_warning') {
          throw new OAuthSub2ClientError('mixed_channel_warning', { statusCode: 409, httpStatus, needsAttention: true });
        }
        const pending = httpStatus === 409 && ['IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_RETRY_BACKOFF'].includes(payload?.reason);
        throw new OAuthSub2ClientError(pending ? 'sub2_idempotency_pending' : 'sub2_http_error', {
          statusCode: httpStatus === 409 ? 409 : 502, httpStatus,
          ambiguous: writing && (pending || httpStatus >= 500 || httpStatus === 408),
        });
      }
      try {
        // 支持标准 code/data envelope 及旧版直接 data，但拒绝成功 HTTP 内的错误 envelope。
        let data = payload;
        if (record(payload) && (Object.hasOwn(payload, 'code') || Object.hasOwn(payload, 'data'))) {
          assertShape((payload.code === undefined || payload.code === 0) && Object.hasOwn(payload, 'data'));
          data = payload.data;
        }
        assertShape(data != null);
        return transform(data);
      } catch {
        throw new OAuthSub2ClientError('sub2_invalid_response', { httpStatus, ambiguous: writing });
      }
    };
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function listAll(path, transform) {
    const results = [];
    const seen = new Set();
    let snapshot;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = await request('GET', `${path}?page=${page}&page_size=${PAGE_SIZE}&sort_by=id&sort_order=asc`, {
        transform: (value) => {
          assertShape(record(value) && Array.isArray(value.items));
          return value;
        },
      });
      const { total, page_size: pageSize, pages, items } = data;
      const errorOptions = { httpStatus: 200 };
      if ((Number.isSafeInteger(total) && total > MAX_ITEMS) || (Number.isSafeInteger(pages) && pages > MAX_PAGES)) {
        throw new OAuthSub2ClientError('sub2_scan_limit', errorOptions);
      }
      const valid = Number.isSafeInteger(total) && total >= 0 && Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 1000
        && data.page === page && pages === Math.max(1, Math.ceil(total / pageSize))
        && items.length === Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize));
      if (!valid || (snapshot && (snapshot.total !== total || snapshot.pageSize !== pageSize || snapshot.pages !== pages))) {
        throw new OAuthSub2ClientError('sub2_pagination_error', errorOptions);
      }
      snapshot ??= { total, pageSize, pages };
      for (const item of items) {
        let normalized;
        try {
          normalized = transform(item);
          const id = positiveId(normalized.id);
          if (seen.has(id)) throw new Error('Overlapping pages');
          seen.add(id);
        } catch {
          throw new OAuthSub2ClientError('sub2_pagination_error', errorOptions);
        }
        results.push(normalized);
      }
      if (page === pages) return results;
    }
    throw new OAuthSub2ClientError('sub2_scan_limit', { httpStatus: 200 });
  }

  return {
    async importCapabilities() {
      try {
        return await request('GET', '/api/v1/admin/accounts/import/capabilities', { transform: (data) => {
          assertShape(record(data) && ['atomic_schedulable', 'atomic_protection'].every((key) => data[key] === undefined || typeof data[key] === 'boolean'));
          return { atomicSchedulable: data.atomic_schedulable === true, atomicProtection: data.atomic_protection === true };
        } });
      } catch (error) {
        // Only an explicit missing/unsupported endpoint permits legacy compatibility, never auth/network/5xx.
        if (error instanceof OAuthSub2ClientError && error.code === 'sub2_http_error'
          && [404, 405].includes(error.httpStatus)) return { atomicSchedulable: false, atomicProtection: false };
        throw error;
      }
    },
    async listGroups() {
      return request('GET', '/api/v1/admin/groups/all', { transform: (items) => {
        assertShape(Array.isArray(items));
        return items.map((group) => {
          assertShape(record(group) && typeof group.name === 'string' && typeof group.platform === 'string' && typeof group.status === 'string');
          return { id: positiveId(group.id), name: group.name, platform: group.platform, status: group.status };
        });
      } });
    },
    async listProxies() {
      return listAll('/api/v1/admin/proxies', normalizeProxy);
    },
    async getProxy(id) {
      const proxyId = positiveId(id);
      return request('GET', `/api/v1/admin/proxies/${proxyId}`, { transform: (data) => {
        const proxy = normalizeProxy(data);
        assertShape(proxy.id === proxyId);
        return proxy;
      } });
    },
    async createProxy(proxy, { idempotencyKey } = {}) {
      const headers = idempotencyHeaders(idempotencyKey);
      if (!record(proxy)) failInput();
      const body = {
        name: requiredText(proxy.name), protocol: requiredText(proxy.protocol), host: requiredText(proxy.host),
        port: proxy.port, username: proxy.username ?? '', password: proxy.password ?? '',
      };
      if (!['http', 'https', 'socks5', 'socks5h'].includes(body.protocol)
        || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535
        || typeof body.username !== 'string' || typeof body.password !== 'string') failInput();
      // 不 trim 认证，避免把不同凭据错误地合并；不支持代理 fallback 隐式改变登录出口。
      if (proxy.expiresAt != null) {
        const date = new Date(proxy.expiresAt);
        if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) failInput();
        body.expires_at = Math.floor(date.getTime() / 1000);
      }
      return request('POST', '/api/v1/admin/proxies', { body, headers, transform: normalizeProxy });
    },
    async generateAuthUrl({ proxyId = null } = {}) {
      return request('POST', '/api/v1/admin/openai/generate-auth-url', {
        body: { proxy_id: optionalProxyId(proxyId) },
        transform: (data) => {
          assertShape(record(data) && text(data.auth_url, 16_384) && text(data.session_id));
          const url = new URL(data.auth_url);
          assertShape(url.protocol === 'https:' && url.hostname === 'auth.openai.com' && !url.username && !url.password && (!url.port || url.port === '443'));
          return { authUrl: data.auth_url, sessionId: data.session_id };
        },
      });
    },
    async exchangeCode({ sessionId, code, state, proxyId = null, redirectUri } = {}) {
      const body = { session_id: requiredText(sessionId), code: requiredText(code, 16_384), state: requiredText(state, 16_384), proxy_id: optionalProxyId(proxyId) };
      if (redirectUri != null) body.redirect_uri = requiredText(redirectUri, 4096);
      return request('POST', '/api/v1/admin/openai/exchange-code', { body, transform: (data) => {
        assertShape(record(data) && text(data.access_token, 128_000) && text(data.refresh_token, 128_000)
          && expirySeconds(data.expires_at) != null);
        return data;
      } });
    },
    async listAccounts({ email } = {}) {
      const expected = normalizeEmail(email);
      if (email !== undefined && !expected) failInput();
      // search 只查询 NameContainsFold；必须扫描所有完整 DTO，不能用邮箱 search 或 lite 列表。
      const accounts = await listAll('/api/v1/admin/accounts', (account) => {
        assertShape(record(account) && typeof account.platform === 'string' && typeof account.type === 'string'
          && record(account.credentials) && Object.hasOwn(account, 'extra') && (account.extra == null || record(account.extra))
          && Object.hasOwn(account, 'proxy_id') && (account.proxy_id == null || positiveId(account.proxy_id)));
        positiveId(account.id);
        return account;
      });
      if (!expected) return accounts;
      // 候选包含任一邮箱证据命中的账号，不提前按 platform/type/proxy/groups 排除重复或冲突。
      return accounts.filter((account) => [account.name, account.email, account.extra?.email, ...emailClaims(account.credentials)]
        .some((value) => normalizeEmail(value) === expected));
    },
    async createOAuthAccount({ name, credentials, proxyId = null, groupIds, importOptions, creationKey } = {}, { idempotencyKey } = {}) {
      const headers = idempotencyHeaders(idempotencyKey);
      if (!record(credentials) || !Array.isArray(groupIds) || groupIds.length === 0) failInput();
      const safeCredentials = buildOAuthCredentials(credentials, { email: credentials.email });
      const body = {
        name: requiredText(name), platform: 'openai', type: 'oauth', credentials: safeCredentials,
        extra: { email: safeCredentials.email }, proxy_id: optionalProxyId(proxyId),
        group_ids: [...new Set(groupIds.map(positiveId))],
        concurrency: 1, priority: 1, rate_multiplier: 1, auto_pause_on_expired: true,
      };
      if (creationKey !== undefined) {
        if (creationKey !== idempotencyKey || !/^oauth-account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(creationKey)) failInput();
        body.extra.oauth_onboarding_creation_key = creationKey;
      }
      const options = importOptions === undefined ? null : normalizeImportOptions(importOptions);
      if (options) {
        // Rebuild trusted identity/token fields first; never merge an arbitrary options or seed object.
        safeCredentials.model_mapping = importModelMapping(options);
        if (options.planType) safeCredentials.plan_type = options.planType;
        if (Object.hasOwn(importOptions, 'accountProtection')) body.anti_degradation = options.accountProtection;
        body.extra.codex_fingerprint_mode = options.fingerprintMode;
        body.extra.openai_oauth_responses_websockets_v2_mode = options.wsMode;
        body.extra.openai_oauth_responses_websockets_v2_enabled = options.wsMode !== 'off';
        Object.assign(body, {
          schedulable: options.schedulable, concurrency: options.concurrency, load_factor: options.loadFactor,
          priority: options.priority, rate_multiplier: options.rateMultiplier, auto_pause_on_expired: options.autoPauseOnExpired,
        });
      }
      const created = await request('POST', '/api/v1/admin/accounts', { body, headers, transform: (data) => {
        assertShape(record(data));
        return { ...data, id: positiveId(data.id) };
      } });
      if (!options || hasImportReconciliationFields(created, options, Object.hasOwn(importOptions, 'accountProtection'))) return created;
      // Sub2 Create -> BindGroups persists membership but does not populate the returned Account.GroupIDs.
      // Fetch only incomplete new-contract responses; never fabricate group/identity proof from our request.
      try {
        return await request('GET', `/api/v1/admin/accounts/${created.id}`, { transform: (data) => {
          assertShape(record(data) && positiveId(data.id) === created.id && hasImportReconciliationFields(data, options, Object.hasOwn(importOptions, 'accountProtection')));
          return { ...data, id: created.id };
        } });
      } catch (error) {
        // The write succeeded before the read failed: caller must reconcile, not recreate under a new key.
        throw new OAuthSub2ClientError(error.code, {
          statusCode: error.statusCode, httpStatus: error.httpStatus, ambiguous: true, needsAttention: error.needsAttention,
        });
      }
    },
  };
}
