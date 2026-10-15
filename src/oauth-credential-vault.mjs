import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_KEYS = ['ciphertext', 'nonce', 'tag', 'version'];

function vaultError(code, statusCode, message) {
  // Fixed local messages only: crypto errors can contain caller-controlled data.
  return Object.assign(new Error(message), { code, statusCode, safe: true });
}

function unavailable() {
  return vaultError('CREDENTIALS_UNAVAILABLE', 409, '任务凭据不可用，已停止操作');
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** JSON metadata is canonical by object key, not by array order or string normalization. */
function canonical(value, depth = 0) {
  if (depth > 64) throw new Error('Invalid JSON metadata');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || Object.getOwnPropertySymbols(value).length) throw new Error('Invalid JSON metadata');
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('Invalid JSON metadata');
    return `[${Array.from(value, (item) => canonical(item, depth + 1)).join(',')}]`;
  }
  if (!record(value)) throw new Error('Invalid JSON metadata');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
}

function additionalData(job) {
  if (!record(job) || ['id', 'mySiteId', 'targetUrl', 'email'].some((key) => typeof job[key] !== 'string' || !job[key])
      || !Array.isArray(job.groupIds) || !job.groupIds.length
      || job.groupIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || (job.proxyId != null && typeof job.proxyId !== 'string')
      || (job.importOptions != null && !record(job.importOptions))
      || (job.accountName != null && typeof job.accountName !== 'string')) throw new Error('Invalid job metadata');
  // Optional metadata uses its persisted defaults; status/timestamps are intentionally unbound.
  return Buffer.from(canonical({ id: job.id, mySiteId: job.mySiteId, targetUrl: job.targetUrl, email: job.email,
    proxyId: job.proxyId ?? null, groupIds: job.groupIds, importOptions: job.importOptions ?? null,
    accountName: job.accountName ?? '' }), 'utf8');
}

function credentialPayload(input) {
  if (!record(input)) throw new Error('Invalid credentials');
  const { password, totpSecret = '', proxySnapshot = null } = input;
  if (typeof password !== 'string' || !password.length || password.length > 1024
      || typeof totpSecret !== 'string' || (proxySnapshot !== null && !record(proxySnapshot))) throw new Error('Invalid credentials');
  return { password, totpSecret, proxySnapshot };
}

function decodeBase64(value, length) {
  if (typeof value !== 'string' || !value.length
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) throw new Error('Invalid base64');
  return bytes;
}

/**
 * Isolated synchronous AES-256-GCM vault; construction does not require a key.
 * Call assertReady before accepting new work. open returns only password, totpSecret and proxySnapshot.
 */
export function createOAuthCredentialVault({ key = process.env.OAUTH_ONBOARDING_CREDENTIAL_KEY } = {}) {
  let keyBytes;
  function assertReady() {
    if (keyBytes) return;
    try {
      // Check the exact encoded size before decoding; no whitespace, URL-safe alphabet or missing padding.
      if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error('Invalid key');
      keyBytes = decodeBase64(key, 32);
    } catch {
      throw vaultError('CREDENTIAL_KEY_UNAVAILABLE', 503, '任务凭据加密密钥未配置或格式无效');
    }
  }

  function seal(job, input) {
    assertReady();
    let plaintext;
    try {
      const aad = additionalData(job);
      plaintext = Buffer.from(canonical(credentialPayload(input)), 'utf8');
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', keyBytes, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return JSON.stringify({ version: VERSION, nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    } catch {
      throw vaultError('INVALID_CREDENTIALS', 400, '任务凭据或绑定参数无效');
    } finally {
      plaintext?.fill(0);
    }
  }

  function open(job, envelope) {
    assertReady();
    let plaintext;
    let pending;
    try {
      if (typeof envelope !== 'string') throw new Error('Invalid envelope');
      const parsed = JSON.parse(envelope);
      if (!record(parsed) || parsed.version !== VERSION
          || Object.keys(parsed).sort().join(',') !== ENVELOPE_KEYS.join(',')) throw new Error('Invalid envelope');
      const nonce = decodeBase64(parsed.nonce, NONCE_BYTES);
      const tag = decodeBase64(parsed.tag, TAG_BYTES);
      const ciphertext = decodeBase64(parsed.ciphertext);
      const decipher = createDecipheriv('aes-256-gcm', keyBytes, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(additionalData(job));
      decipher.setAuthTag(tag);
      // No plaintext is parsed or returned until GCM authentication has succeeded.
      pending = decipher.update(ciphertext);
      plaintext = Buffer.concat([pending, decipher.final()]);
      const payload = JSON.parse(plaintext.toString('utf8'));
      if (!record(payload) || Object.keys(payload).sort().join(',') !== 'password,proxySnapshot,totpSecret') throw new Error('Invalid payload');
      return credentialPayload(payload);
    } catch {
      throw unavailable();
    } finally {
      pending?.fill(0);
      plaintext?.fill(0);
    }
  }

  return { assertReady, seal, open };
}
