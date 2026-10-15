import { createHmac } from 'node:crypto';

// 已有账号语义来源：zc-zhangchen/any-auto-register @44c27a8a2ae5e08d37bb68ab007a335782b43467
// platforms/chatgpt/protocol/totp.py；仅移植本地 RFC 6238 算法，不包含注册或风控绕过。
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function invalidSecret() {
  return Object.assign(new Error('动态口令密钥格式无效，请核对后重新提交'), {
    code: 'OAUTH_INVALID_TOTP_SECRET', statusCode: 400, needsAttention: true, safe: true,
  });
}

/** 提交预校验：接受展示用空白、大小写及规范 Base32 padding；返回无 padding 的大写密钥；未提供密钥返回空串（未启用 TOTP）。 */
export function normalizeTotpSecret(secret) {
  if (secret == null) return '';
  if (typeof secret !== 'string' || secret.length > 4096) throw invalidSecret();
  const value = secret.replace(/\s/g, '').toUpperCase();
  if (!value) return '';
  const match = /^([A-Z2-7]+)(=*)$/.exec(value);
  if (!match) throw invalidSecret();
  const [, body, padding] = match;
  const remainder = body.length % 8;
  if (![0, 2, 4, 5, 7].includes(remainder)
    || (padding && (padding.length !== (8 - remainder) % 8 || value.length % 8 !== 0))) {
    throw invalidSecret();
  }
  // Base32 最后一个字符的未使用位必须为零，避免不同输入代表同一密钥。
  const unusedBits = (body.length * 5) % 8;
  if (unusedBits && (ALPHABET.indexOf(body.at(-1)) & ((1 << unusedBits) - 1))) throw invalidSecret();
  return body;
}

function decodeSecret(secret) {
  const normalized = normalizeTotpSecret(secret);
  if (!normalized) throw invalidSecret();
  const bytes = [];
  let bits = 0;
  let buffer = 0;
  for (const char of normalized) {
    buffer = (buffer << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 SHA1；at 是 Unix 秒（不是毫秒），默认 30 秒窗口、6 位码。 */
export function generateTotp(secret, { at = Date.now() / 1000, digits = 6, period = 30 } = {}) {
  if (!Number.isFinite(at) || at < 0 || !Number.isSafeInteger(Math.floor(at))
    || !Number.isInteger(digits) || digits < 6 || digits > 8
    || !Number.isSafeInteger(period) || period <= 0) {
    throw Object.assign(new Error('动态口令参数无效'), {
      code: 'OAUTH_INVALID_TOTP_OPTIONS', statusCode: 400, needsAttention: true, safe: true,
    });
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / period)));
  const digest = createHmac('sha1', decodeSecret(secret)).update(counter).digest();
  const offset = digest.at(-1) & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits);
  return String(value).padStart(digits, '0');
}
