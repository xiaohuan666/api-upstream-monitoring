import { randomUUID } from 'node:crypto';

import { normalizeProviderPlatform } from './domain.mjs';
import { unwrapSub2ApiPayload } from './upstreams/sub2api.mjs';

// sub2api 管理端平台口径与监控侧一致：anthropic/grok/gemini 独立，其余归并 openai
export function normalizeAdminPlatform(value) {
  return normalizeProviderPlatform(value);
}

export class MySiteAdminApiError extends Error {
  constructor(message, { httpStatus = null, errorCode = null } = {}) {
    super(message);
    this.name = 'MySiteAdminApiError';
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
  }
}

// 自己的 sub2api 站点的管理端客户端：x-api-key 头认证（管理后台设置的 Admin API Key）
export function createSub2ApiAdminClient({
  baseUrl,
  adminKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  createIdempotencyKey = () => randomUUID(),
}) {
  const normalizedBaseUrl = String(baseUrl ?? '').trim();
  if (!normalizedBaseUrl) throw new Error('My site base URL is required');
  const normalizedAdminKey = String(adminKey ?? '').trim();
  if (!normalizedAdminKey) throw new Error('My site admin API key is required');

  async function request(method, path, body = null, extraHeaders = {}) {
    let response;
    try {
      response = await fetchImpl(new URL(path, normalizedBaseUrl).toString(), {
        method,
        headers: {
          accept: 'application/json',
          'x-api-key': normalizedAdminKey,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new MySiteAdminApiError(`${method} ${path} failed: ${error.message}`, {});
    }
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new MySiteAdminApiError(
        `${method} ${path} HTTP ${response.status}: non-JSON response`,
        { httpStatus: response.status },
      );
    }
    if (!response.ok) {
      throw new MySiteAdminApiError(
        payload?.message ?? `${method} ${path} HTTP ${response.status}`,
        {
          httpStatus: response.status,
          errorCode: payload?.error_code ?? payload?.errorCode ?? payload?.code ?? null,
        },
      );
    }
    try {
      return unwrapSub2ApiPayload(payload);
    } catch (error) {
      throw new MySiteAdminApiError(error.message, { httpStatus: response.status });
    }
  }

  return {
    // GET /api/v1/admin/groups/all → 全量不分页，供下拉框选择
    async listGroups() {
      const data = await request('GET', '/api/v1/admin/groups/all');
      const items = Array.isArray(data)
        ? data
        : (data?.items ?? data?.groups ?? data?.list ?? []);
      return items.map((group) => ({
        id: String(group.id ?? group.group_id ?? ''),
        name: String(group.name ?? group.id ?? ''),
        platform: normalizeAdminPlatform(group.platform),
        rateMultiplier: toFiniteNumber(group.rate_multiplier ?? group.rateMultiplier, 1),
        status: String(group.status ?? 'active'),
      })).filter((group) => group.id);
    },

    // POST /api/v1/admin/accounts：生产模式必须携带 Idempotency-Key
    async createAccount({
      name,
      platform,
      apiKey,
      baseUrl: upstreamBaseUrl,
      groupId,
      rateMultiplier = null,
      priority = 1,
      concurrency = 1000,
      poolMode = true,
      poolModeRetryCount = 3,
      responsesMode = null,
      modelMapping = null,
    }) {
      const numericGroupId = Number(groupId);
      if (!Number.isInteger(numericGroupId) || numericGroupId <= 0) {
        throw new MySiteAdminApiError(`Invalid group id for account creation: ${groupId}`, {});
      }
      const credentials = { api_key: String(apiKey ?? '') };
      if (String(upstreamBaseUrl ?? '').trim()) {
        credentials.base_url = String(upstreamBaseUrl).trim();
      }
      // 池模式：上游为账号池时启用，错误不标记本地账号状态（credentials 级开关）
      credentials.pool_mode = Boolean(poolMode);
      if (poolMode) {
        credentials.pool_mode_retry_count = normalizePoolModeRetryCount(poolModeRetryCount);
      }
      // 模型白名单：model_mapping 恒等映射（key=value），账号仅支持列出的模型
      if (modelMapping && typeof modelMapping === 'object' && Object.keys(modelMapping).length > 0) {
        credentials.model_mapping = modelMapping;
      }
      const body = {
        name: String(name ?? '').trim(),
        platform: normalizeAdminPlatform(platform),
        type: 'apikey',
        credentials,
        group_ids: [numericGroupId],
        priority: Number(priority),
        concurrency: Number(concurrency),
      };
      if (rateMultiplier !== null && Number.isFinite(Number(rateMultiplier))) {
        body.rate_multiplier = Number(rateMultiplier);
      }
      // Responses API 支持模式：仅 openai 分组有意义（auto / force_responses / force_chat_completions）
      if (responsesMode !== null) {
        if (!RESPONSES_MODES.includes(responsesMode)) {
          throw new MySiteAdminApiError(`Invalid responses mode: ${responsesMode}`, {});
        }
        body.extra = { openai_responses_mode: responsesMode };
      }
      const data = await request('POST', '/api/v1/admin/accounts', body, {
        'idempotency-key': createIdempotencyKey(),
      });
      return {
        id: String(data?.id ?? data?.account_id ?? ''),
        name: String(data?.name ?? body.name),
      };
    },

    // GET /api/v1/admin/accounts/:id：刷新时核对账号是否还在、名字/倍率是否漂移、是否还挂在映射时的分组里
    async getAccount(accountId) {
      const data = await request(
        'GET',
        `/api/v1/admin/accounts/${encodeURIComponent(String(accountId))}`,
      );
      return {
        id: String(data?.id ?? data?.account_id ?? accountId),
        name: String(data?.name ?? ''),
        rateMultiplier: toFiniteNumber(data?.rate_multiplier ?? data?.rateMultiplier, 1),
        schedulable: Boolean(data?.schedulable),
        priority: toFiniteNumber(data?.priority, 0),
        // sub2api 账号状态：active / inactive / error；老版本没有该字段时为空串
        status: String(data?.status ?? ''),
        // 账号当前绑定的分组 id 列表；老版本没有 account_groups 字段时返回 null（调用方跳过成员校验）
        groupIds: Array.isArray(data?.account_groups)
          ? data.account_groups.map((item) => String(item?.group_id ?? item?.groupId ?? item?.group?.id ?? '')).filter(Boolean)
          : null,
      };
    },

    // PUT /api/v1/admin/accounts/:id：只传要改的字段（name / rateMultiplier / priority）
    async updateAccount(accountId, { name = null, rateMultiplier = null, priority = null } = {}) {
      const body = {};
      if (name !== null) {
        const trimmed = String(name).trim();
        if (!trimmed) throw new MySiteAdminApiError('Account name must not be empty', {});
        body.name = trimmed;
      }
      if (rateMultiplier !== null) {
        const numericRate = Number(rateMultiplier);
        if (!Number.isFinite(numericRate) || numericRate < 0) {
          throw new MySiteAdminApiError(`Invalid rate multiplier: ${rateMultiplier}`, {});
        }
        body.rate_multiplier = numericRate;
      }
      if (priority !== null) {
        const numericPriority = Number(priority);
        if (!Number.isInteger(numericPriority) || numericPriority < 0) {
          throw new MySiteAdminApiError(`Invalid priority: ${priority}`, {});
        }
        body.priority = numericPriority;
      }
      if (Object.keys(body).length === 0) {
        throw new MySiteAdminApiError('Nothing to update on account', {});
      }
      return await request(
        'PUT',
        `/api/v1/admin/accounts/${encodeURIComponent(String(accountId))}`,
        body,
      );
    },

    // POST /api/v1/admin/accounts/:id/schedulable：可调度开关走独立端点（不在 PUT 更新里）
    async setSchedulable(accountId, schedulable) {
      return await request(
        'POST',
        `/api/v1/admin/accounts/${encodeURIComponent(String(accountId))}/schedulable`,
        { schedulable: Boolean(schedulable) },
      );
    },

    // GET /api/v1/admin/proxies?page=1&page_size=1000：全量代理（含密码，用于按连接信息匹配既有代理）
    async listProxies() {
      const data = await request('GET', '/api/v1/admin/proxies?page=1&page_size=1000');
      const items = Array.isArray(data)
        ? data
        : (data?.items ?? data?.proxies ?? data?.list ?? []);
      return items.map((proxy) => ({
        id: String(proxy.id ?? proxy.proxy_id ?? ''),
        name: String(proxy.name ?? ''),
        protocol: String(proxy.protocol ?? 'http'),
        host: String(proxy.host ?? ''),
        port: Number(proxy.port),
        username: String(proxy.username ?? ''),
        password: String(proxy.password ?? ''),
        status: String(proxy.status ?? 'active'),
        expiresAt: proxy.expires_at ? new Date(proxy.expires_at).toISOString() : null,
      })).filter((proxy) => proxy.id);
    },

    // POST /api/v1/admin/proxies：生产模式必须携带 Idempotency-Key
    async createProxy({ name, protocol, host, port, username = '', password = '', expiresAt = null }) {
      const body = {
        name: String(name ?? '').trim(),
        protocol: String(protocol ?? 'http'),
        host: String(host ?? '').trim(),
        port: Number(port),
        username: String(username ?? '').trim(),
        password: String(password ?? '').trim(),
      };
      // sub2api 口径：unix 秒；空值不传表示长期有效
      if (expiresAt) {
        body.expires_at = Math.floor(new Date(expiresAt).getTime() / 1000);
      }
      const data = await request('POST', '/api/v1/admin/proxies', body, {
        'idempotency-key': createIdempotencyKey(),
      });
      return {
        id: String(data?.id ?? data?.proxy_id ?? ''),
        name: String(data?.name ?? body.name),
      };
    },

    // PUT 保留未提供字段；显式 null 到期时间会清除远端已有到期时间。
    async updateProxy(proxyId, input = {}) {
      const body = {};
      if (Object.hasOwn(input, 'name')) {
        const trimmed = String(input.name ?? '').trim();
        if (!trimmed) throw new MySiteAdminApiError('Proxy name must not be empty', {});
        body.name = trimmed;
      }
      for (const field of ['protocol', 'host', 'status']) {
        if (Object.hasOwn(input, field)) body[field] = String(input[field]);
      }
      if (Object.hasOwn(input, 'port')) body.port = Number(input.port);
      for (const field of ['username', 'password']) {
        if (Object.hasOwn(input, field)) body[field] = String(input[field] ?? '');
      }
      if (Object.hasOwn(input, 'expiresAt')) {
        body.expires_at = input.expiresAt ? Math.floor(new Date(input.expiresAt).getTime() / 1000) : null;
      }
      if (Object.keys(body).length === 0) throw new MySiteAdminApiError('Nothing to update on proxy', {});
      return await request('PUT', `/api/v1/admin/proxies/${encodeURIComponent(String(proxyId))}`, body);
    },

  };
}

function toFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export const RESPONSES_MODES = ['auto', 'force_responses', 'force_chat_completions'];

// 与服务端口径一致：非法回退 3，下限 0，上限 10
function normalizePoolModeRetryCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 3;
  return Math.min(10, Math.max(0, Math.trunc(number)));
}
