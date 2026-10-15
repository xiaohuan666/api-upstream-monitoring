import test from 'node:test';
import assert from 'node:assert/strict';

import { createCaptchaOcr, resolveDefaultOcrPython } from '../src/upstreams/captcha-ocr.mjs';

test('captcha ocr returns trimmed alphanumeric result', async () => {
  const calls = [];
  const ocr = createCaptchaOcr({
    pythonPath: '/venv/python',
    execFileImpl: (path, args, options, callback) => {
      calls.push({ path, args, options });
      callback(null, '  AB12C \n');
    },
  });

  const text = await ocr('QUJD');
  assert.equal(text, 'AB12C');
  assert.equal(calls[0].path, '/venv/python');
  assert.equal(calls[0].args[2], 'QUJD');
});

test('captcha ocr rejects non-base64 input and unexpected results', async () => {
  const ocr = createCaptchaOcr({
    execFileImpl: (path, args, options, callback) => callback(null, 'ok'),
  });
  await assert.rejects(() => ocr('not base64!!'), /must be base64/);

  const weird = createCaptchaOcr({
    execFileImpl: (path, args, options, callback) => callback(null, '???'),
  });
  await assert.rejects(() => weird('QUJD'), /unexpected result/);
});

test('captcha ocr wraps subprocess failures', async () => {
  const ocr = createCaptchaOcr({
    execFileImpl: (path, args, options, callback) => callback(new Error('boom')),
  });
  await assert.rejects(() => ocr('QUJD'), /Captcha OCR failed: boom/);
});

test('resolveDefaultOcrPython prefers env override', () => {
  assert.equal(resolveDefaultOcrPython({ OCR_PYTHON: '/custom/python' }), '/custom/python');
  const fallback = resolveDefaultOcrPython({});
  assert.ok(fallback.endsWith('/python'));
});
