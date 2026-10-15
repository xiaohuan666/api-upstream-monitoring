import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTotpSecret, generateTotp } from '../src/oauth-totp.mjs';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('RFC 6238 Appendix B SHA1 全部标准向量（Unix 秒、8 位）', () => {
  for (const [at, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(generateTotp(SECRET, { at, digits: 8 }), expected);
  }
});

test('默认 6 位、前导零和 30 秒窗口边界', () => {
  assert.equal(generateTotp(SECRET, { at: 1111111111 }), '050471');
  assert.equal(generateTotp(SECRET, { at: 59.999 }), generateTotp(SECRET, { at: 59 }));
  assert.notEqual(generateTotp(SECRET, { at: 60 }), generateTotp(SECRET, { at: 59 }));
});

test('提交预校验支持展示空白、大小写、合法 padding', () => {
  assert.equal(normalizeTotpSecret(' gezd gnbv\nGY3TQOJQ gezdgnbvgy3tqojq\t'), SECRET);
  assert.equal(normalizeTotpSecret('my======'), 'MY');
  assert.equal(generateTotp('my======', { at: 59 }), generateTotp('MY', { at: 59 }));
});

test('拒绝非 Base32、非法长度/padding/未使用位；异常不包含密钥', () => {
  for (const secret of ['A', 'ABC', 'ABCDEF', 'MY=', 'MY=======', 'MY======X',
    'MZ', 'M0', 'MY!SECRET', 'otpauth://totp/test?secret=MY', 'A'.repeat(4097)]) {
    assert.throws(() => normalizeTotpSecret(secret), (error) => {
      assert.equal(error.code, 'OAUTH_INVALID_TOTP_SECRET');
      assert.equal(error.statusCode, 400);
      assert.equal(error.needsAttention, true);
      assert.equal(error.safe, true);
      assert.equal(error.message, '动态口令密钥格式无效，请核对后重新提交');
      return true;
    });
  }
});

test('拒绝无效时间与算法参数，不输出 NaN 或错误位数', () => {
  for (const options of [{ at: -1 }, { at: NaN }, { at: Infinity }, { at: 1e30 }, { digits: 5 },
    { digits: 9 }, { digits: 6.5 }, { period: 0 }, { period: 1.5 }]) {
    assert.throws(() => generateTotp(SECRET, options), (error) => error.code === 'OAUTH_INVALID_TOTP_OPTIONS' && error.safe === true);
  }
});


test('预校验允许未启用 TOTP，但生成器绝不使用空密钥计算', () => {
  for (const secret of [null, undefined, '', ' \n ']) {
    assert.equal(normalizeTotpSecret(secret), '');
    assert.throws(() => generateTotp(secret), (error) => error.code === 'OAUTH_INVALID_TOTP_SECRET' && error.safe === true);
  }
});
