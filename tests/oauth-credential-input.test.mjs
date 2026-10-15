import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOAuthCredentialInput } from '../src/oauth-credential-input.mjs';

const email = 'demo-name@example.test';
const password = ' test-password ';
const totpSecret = 'JBSWY3DPEHPK3PXP';
for (const delimiter of ['--', '---', '----', '--------', '|', '｜']) {
  test(`credential parser supports ${delimiter} without changing password`, () => {
    assert.deepEqual(parseOAuthCredentialInput(` ${email} ${delimiter}${password}${delimiter} ${totpSecret} `), { email, password, totpSecret });
  });
}
test('credential parser accepts one terminal newline', () => {
  for (const ending of ['', '\n', '\r\n']) {
    assert.deepEqual(parseOAuthCredentialInput(`${email}----${password}----${totpSecret}${ending}`), { email, password, totpSecret });
  }
});
test('credential parser rejects invalid inputs without exposing credentials', () => {
  for (const input of [null, {}, '', `${email}|${password}`, `${email}||${totpSecret}`,
    `|${password}|${totpSecret}`, `${email}|${password}|`, `${email}|  |${totpSecret}`,
    `${email}|${password}|${totpSecret}|extra`, `${email}----ambiguous--password----${totpSecret}`,
    `${email}|${password}|${totpSecret}\n\n`, `${email}|${password}\nnext|${totpSecret}`,
    `${email}|${password}\t|${totpSecret}`, `${email}|${password}\u0000|${totpSecret}`,
    `${email}|${password}\u2028|${totpSecret}`, `${email}|${password}\u0085|${totpSecret}`,
    'x'.repeat(4097)]) {
    assert.throws(() => parseOAuthCredentialInput(input), (error) => {
      assert.equal(error.message.includes(email), false);
      assert.equal(error.message.includes(password), false);
      assert.equal(error.message.includes(totpSecret), false);
      return true;
    });
  }
});
test('credential parser accepts limit and does not invent business validation', () => {
  const input = `a|${'x'.repeat(4092)}|b`;
  assert.equal(input.length, 4096);
  assert.equal(parseOAuthCredentialInput(input).password.length, 4092);
});

test('pipe format preserves password boundary hyphens and embedded hyphen delimiters', () => {
  for (const value of ['-abc', 'abc-', '-abc-', '--abc--', 'abc----xyz']) {
    for (const delimiter of ['|', '｜']) {
      assert.equal(parseOAuthCredentialInput(`${email}${delimiter}${value}${delimiter}${totpSecret}`).password, value);
    }
  }
});
test('hyphen format requires equal complete runs; mixed formats and unequal runs are rejected', () => {
  for (const value of [
    `${email}-----abc----${totpSecret}`, `${email}----abc-----${totpSecret}`,
    `${email}----abc|${totpSecret}`, `${email}|abc----${totpSecret}`,
  ]) assert.throws(() => parseOAuthCredentialInput(value));
  // 两处同样长的横线只能整体解释为分隔符；首尾含横线的密码必须用竖线格式。
  assert.equal(parseOAuthCredentialInput(`${email}-----abc-----${totpSecret}`).password, 'abc');
});

import { parseOAuthCredentialBatch } from '../src/oauth-credential-input.mjs';
test('batch parses CRLF, ignores empty lines, preserves passwords and counts invalid/duplicate lines', () => {
  const result = parseOAuthCredentialBatch(`\r\n${email}|${password}|${totpSecret}\r\nwrong\r\n${email.toUpperCase()}|another|${totpSecret}\r\nnext@example.test---p-a-s-s---${totpSecret}\n \n`);
  assert.deepEqual(result, { accounts: [{ email, password, totpSecret }, { email: 'next@example.test', password: 'p-a-s-s', totpSecret }], successCount: 2, failureCount: 2 });
});
test('batch retains strict single-line rules and errors never echo credentials or recommend removed fields', () => {
  const result = parseOAuthCredentialBatch(`${email}|${password}\n${email}----bad--password----${totpSecret}\n${email}|${password}\t|${totpSecret}`);
  assert.deepEqual(result, { accounts: [], successCount: 0, failureCount: 3 });
  for (const input of [null, `${email}|${password}`, `${email}---bad----${totpSecret}`]) {
    assert.throws(() => parseOAuthCredentialInput(input), (error) => !/分栏/.test(error.message) && !error.message.includes(password));
  }
});
test('batch rejects excess valid accounts instead of truncating and duplicate rows do not consume capacity', () => {
  const rows = Array.from({ length: 30 }, (_, index) => `u${index}@example.test|${password}|${totpSecret}`);
  assert.equal(parseOAuthCredentialBatch(rows.join('\n')).successCount, 30);
  assert.equal(parseOAuthCredentialBatch([...rows, rows[0]].join('\n')).failureCount, 1);
  assert.throws(() => parseOAuthCredentialBatch([...rows, `extra@example.test|${password}|${totpSecret}`].join('\n')), /最多 30/);
});
test('batch measures UTF-8 bytes, permits exact 128KiB and rejects oversize/nonstring', () => {
  assert.equal(parseOAuthCredentialBatch('x'.repeat(128 * 1024)).failureCount, 1);
  for (const input of ['x'.repeat(128 * 1024 + 1), '中'.repeat(44_000), null, {}]) {
    assert.throws(() => parseOAuthCredentialBatch(input), /128 KiB/);
  }
  assert.deepEqual(parseOAuthCredentialBatch('\n\r\n '), { accounts: [], successCount: 0, failureCount: 0 });
});
