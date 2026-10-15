import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// All Python fixtures are offline. Missing Python is a failed build, not a skipped contract.
test('HTTP OAuth Python protocol, transport and SDK isolation contracts', { timeout: 120_000 }, () => {
  const result = spawnSync(process.env.OAUTH_LOGIN_PYTHON || 'python3',
    ['-B', '-m', 'unittest', 'discover', '-s', 'tests/oauth_python', '-p', 'test_*.py', '-v'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 110_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
