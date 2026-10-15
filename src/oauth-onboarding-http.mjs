import { onboardingError } from './oauth-onboarding-store.mjs';

const PREFIX = '/api/oauth-onboarding';
const MAX_BODY_BYTES = 256 * 1024;

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

function assertSameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw onboardingError('CROSS_ORIGIN', '不允许跨站提交账号凭据', 403);
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { throw onboardingError('CROSS_ORIGIN', '无效的请求来源', 403); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) throw onboardingError('CROSS_ORIGIN', '不允许跨站提交账号凭据', 403);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw onboardingError('CONTENT_TYPE', '请使用 JSON 请求', 415);
}

async function readBody(req, maxBytes = MAX_BODY_BYTES, singleConcurrencyField = false) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw onboardingError('BODY_TOO_LARGE', '请求体过大', 413);
    chunks.push(chunk);
  }
  try {
    const text = Buffer.concat(chunks).toString('utf8');
    // The settings resource has exactly one numeric member: reject duplicate
    // keys before JSON.parse can silently overwrite the operator's input.
    if (singleConcurrencyField && !/^\s*\{\s*"concurrency"\s*:\s*-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?\s*\}\s*$/.test(text)) throw new Error();
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw onboardingError('INVALID_JSON', '请求必须是有效 JSON 对象'); }
}

/** Returns false only for paths outside this isolated credential-bearing API boundary. */
export async function handleOAuthOnboarding(req, res, url, service) {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
  try {
    if (!service) throw onboardingError('NOT_CONFIGURED', 'OAuth 入池服务未配置', 503);
    if (url.pathname === `${PREFIX}/settings`) {
      if (url.search) throw onboardingError('INVALID_OAUTH_SETTINGS', '并发配置接口不接受查询参数');
      if (req.method === 'GET') json(res, 200, await service.getExecutionSettings());
      else if (req.method === 'PUT') {
        assertSameOrigin(req);
        json(res, 200, await service.saveExecutionSettings(await readBody(req, 1024, true)));
      } else throw onboardingError('METHOD_NOT_ALLOWED', '不支持的请求方法', 405);
      return true;
    }
    const rerunMatch = url.pathname.match(/^\/api\/oauth-onboarding\/(batches|jobs)\/([^/]+)\/rerun$/);
    const batchMatch = url.pathname.match(/^\/api\/oauth-onboarding\/batches\/([^/]+)$/);
    const jobMatch = url.pathname.match(/^\/api\/oauth-onboarding\/jobs\/([^/]+)(\/reconcile)?$/);
    if (req.method === 'GET') {
      if (url.pathname === `${PREFIX}/options`) json(res, 200, await service.options());
      else if (url.pathname === `${PREFIX}/preferences`) json(res, 200, await service.preferences(url.searchParams.get('mySiteId')));
      else if (url.pathname === `${PREFIX}/batches`) {
        const allowed = new Set(['email', 'before', 'status', 'mySiteId', 'createdFrom', 'createdBefore']);
        const params = { email: '', before: null };
        for (const [key, value] of url.searchParams) {
          if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw onboardingError('INVALID_PAGE', '无效的任务搜索或分页参数');
          params[key] = value;
        }
        json(res, 200, await service.listBatches(params));
      }
      else if (batchMatch) json(res, 200, { batch: await service.getBatch(batchMatch[1], { email: url.searchParams.get('email') ?? '' }) });
      else if (url.pathname === `${PREFIX}/groups`) json(res, 200, { groups: await service.groups(url.searchParams.get('mySiteId')) });
      else if (url.pathname === `${PREFIX}/jobs`) json(res, 200, url.searchParams.has('scope')
        ? await service.listPage({ scope: url.searchParams.get('scope'), before: url.searchParams.get('before') }) : { jobs: await service.list() });
      else if (jobMatch && !jobMatch[2]) json(res, 200, { job: await service.get(jobMatch[1]) });
      else throw onboardingError('NOT_FOUND', '接口不存在', 404);
    } else if (req.method === 'POST') {
      assertSameOrigin(req);
      const body = await readBody(req, url.pathname === `${PREFIX}/batches` ? MAX_BODY_BYTES : 16 * 1024);
      if (rerunMatch) json(res, 202, { batch: await (rerunMatch[1] === 'batches' ? service.rerunBatch(rerunMatch[2], body) : service.rerunJob(rerunMatch[2], body)) });
      else if (url.pathname === `${PREFIX}/batches`) {
        try { json(res, 202, { batch: await service.submitBatch(body) }); }
        finally { for (const account of Array.isArray(body.accounts) ? body.accounts : []) {
          if (account && typeof account === 'object') { delete account.password; delete account.totpSecret; }
        } delete body.accounts; }
      } else if (url.pathname === `${PREFIX}/jobs`) {
        try { json(res, 202, { job: await service.submit(body) }); }
        finally { delete body.password; delete body.totpSecret; }
      } else if (jobMatch?.[2]) json(res, 200, { job: await service.reconcile(jobMatch[1]) });
      else throw onboardingError('NOT_FOUND', '接口不存在', 404);
    } else throw onboardingError('METHOD_NOT_ALLOWED', '不支持的请求方法', 405);
  } catch (error) {
    // Never leak a JSON parser exception, upstream body, credential, or proxy connection string.
    const safe = error?.safe === true;
    json(res, safe ? error.statusCode ?? 400 : 500, {
      error: safe ? error.message : 'OAuth 入池服务暂时不可用', code: safe ? error.code : 'INTERNAL_ERROR',
    });
  }
  return true;
}
