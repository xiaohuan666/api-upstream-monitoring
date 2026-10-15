import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('app container uses an init reaper and starts Node without npm wrappers', async () => {
  const compose = await readFile(new URL('../compose.yml', import.meta.url), 'utf8');
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const appService = compose.match(/^  app:\n[\s\S]*?(?=^  postgres:)/m)?.[0] ?? '';

  assert.match(appService, /^    init: true$/m);
  assert.match(dockerfile, /^CMD \["node", "server\.mjs"\]$/m);
  assert.doesNotMatch(dockerfile, /^CMD .*npm/m);
});
