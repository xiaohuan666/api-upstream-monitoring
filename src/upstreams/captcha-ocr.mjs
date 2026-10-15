import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const OCR_SCRIPT = `
import sys, base64, ddddocr
engine = ddddocr.DdddOcr(show_ad=False)
print(engine.classification(base64.b64decode(sys.argv[1])))
`;

export function createCaptchaOcr({
  pythonPath = resolveDefaultOcrPython(),
  timeoutMs = 20_000,
  execFileImpl = execFile,
} = {}) {
  return async function recognizeCaptcha(imageBase64) {
    const payload = String(imageBase64 ?? '').trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(payload)) {
      throw new Error('Captcha image payload must be base64');
    }
    const stdout = await new Promise((resolve, reject) => {
      execFileImpl(
        pythonPath,
        ['-c', OCR_SCRIPT, payload],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (error, out) => {
          if (error) reject(new Error(`Captcha OCR failed: ${error.message}`));
          else resolve(out);
        },
      );
    });
    const text = String(stdout).trim();
    if (!/^[A-Za-z0-9]{3,8}$/.test(text)) {
      throw new Error(`Captcha OCR returned unexpected result: ${text.slice(0, 32)}`);
    }
    return text;
  };
}

export function resolveDefaultOcrPython(env = process.env) {
  if (env.OCR_PYTHON) return env.OCR_PYTHON;
  if (existsSync('/opt/ocr-venv/bin/python')) return '/opt/ocr-venv/bin/python';
  return new URL('../../.venv-ocr/bin/python', import.meta.url).pathname;
}
