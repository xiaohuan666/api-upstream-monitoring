import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loginOpenAI } from '../src/oauth-login.mjs';

const redirectUri = 'http://localhost:1455/auth/callback';
const input = {
  authUrl: `https://auth.openai.com/oauth/authorize?${new URLSearchParams({ client_id: 'sub2-client', response_type: 'code', state: 'sub2-state', redirect_uri: redirectUri, code_challenge: 'original-pkce', code_challenge_method: 'S256', prompt: 'login' })}`,
  email: 'fixture@example.test', password: 'offline-password', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  spawnWorker(command, args, options) {
    return spawn(command, [args[0], fileURLToPath(new URL('./fixtures/oauth-http-flow.py', import.meta.url))], options);
  },
};

test('Node→real Python worker→HTTP state machine→original Sub2 callback, each stage ACKed', async () => {
  const stages = [];
  const result = await loginOpenAI({ ...input, onStage: async (stage) => { stages.push(stage); } });
  assert.deepEqual(result, { code: 'target-code', state: 'sub2-state', redirectUri });
  assert.deepEqual(stages, ['warmup', 'csrf', 'authorizing', 'email', 'password', 'totp', 'authorizing', 'consent']);
});

test('failed progress persistence stops the real worker before advancing the HTTP flow', async () => {
  const stages = [];
  await assert.rejects(loginOpenAI({ ...input, onStage: async (stage) => {
    stages.push(stage);
    throw new Error('raw-database-secret');
  } }), (error) => error.code === 'OAUTH_LOGIN_FAILED' && !error.message.includes('secret'));
  assert.deepEqual(stages, ['warmup']);
});

function workspaceFixtureLogin(mode) {
  return (options) => loginOpenAI({ ...options, spawnWorker(command, args, spawnOptions) {
    return input.spawnWorker(command, args, spawnOptions);
  }, authUrl: `${input.authUrl}&workspace_fixture=${mode}` });
}

test('structured workspace extraction and classified errors cross real Python IPC without leaking IDs', async () => {
  const result = await workspaceFixtureLogin('single')(input);
  assert.equal(result.code, 'target-code');
  for (const [mode, code] of Object.entries({ missing: 'OAUTH_WORKSPACE_NOT_FOUND', multiple: 'OAUTH_WORKSPACE_AMBIGUOUS',
    conflict: 'OAUTH_WORKSPACE_CONFLICT', 'pointer-conflict': 'OAUTH_WORKSPACE_CONFLICT',
    'type-conflict': 'OAUTH_WORKSPACE_CONFLICT', invalid: 'OAUTH_WORKSPACE_INVALID',
    'mixed-script': 'OAUTH_WORKSPACE_INVALID', 'http-duplicate': 'OAUTH_WORKSPACE_INVALID',
    'cookie-corrupt': 'OAUTH_WORKSPACE_INVALID', 'cookie-nonutf8': 'OAUTH_WORKSPACE_INVALID', 'cookie-null': 'OAUTH_WORKSPACE_INVALID' })) {
    const stages = [];
    await assert.rejects(workspaceFixtureLogin(mode)({ ...input, onStage(stage) { stages.push(stage); } }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.safe, true);
      assert.equal(error.needsAttention, true);
      assert.ok(!JSON.stringify(error).includes('workspace-one'));
      assert.ok(!JSON.stringify(error).includes('workspace-two'));
      return true;
    });
    assert.equal(stages.at(-1), mode === 'http-duplicate' ? 'authorizing' : 'consent');
  }
});


for (const mode of ['typed-team', 'typed-flags', 'label-team', 'label-team-en', 'label-team-short',
  'label-team-traditional', 'label-team-account']) {
  test(`Node→real Python excludes the personal workspace and POSTs the guarded team ID: ${mode}`, async () => {
    const stages = [];
    // The fixture has no session user.name; its guard checks the actual POST body, not just the callback.
    const result = await workspaceFixtureLogin(mode)({ ...input, onStage(stage) { stages.push(stage); } });
    assert.deepEqual(result, { code: 'target-code', state: 'sub2-state', redirectUri });
    assert.deepEqual(stages, ['warmup', 'csrf', 'authorizing', 'email', 'password', 'totp', 'authorizing', 'consent']);
  });
}

for (const mode of ['multiple-teams', 'multiple-nonpersonal', 'unclassified', 'missing-label']) {
  test(`Node→real Python stops ambiguous workspace selection with zero select requests: ${mode}`, async () => {
    const stages = [];
    await assert.rejects(workspaceFixtureLogin(mode)({ ...input, onStage(stage) { stages.push(stage); } }), (error) => {
      assert.equal(error.code, 'OAUTH_WORKSPACE_AMBIGUOUS');
      assert.equal(error.message, '检测到多个工作空间，未自动选择，未推送账号');
      assert.equal(error.statusCode, 422);
      assert.equal(error.safe, true);
      assert.equal(error.needsAttention, true);
      const exposed = JSON.stringify({ ...error, message: error.message });
      for (const secret of [input.password, input.totpSecret, 'workspace-personal', 'workspace-team',
        'workspace-team-other', 'fixture-personal-renamed', 'fixture-team-private', 'fixture-other-private']) {
        assert.ok(!exposed.includes(secret));
      }
      return true;
    });
    assert.deepEqual(stages, ['warmup', 'csrf', 'authorizing', 'email', 'password', 'totp', 'authorizing', 'consent']);
  });
}


for (const mode of ['kind-web-team', 'kind-type-web-team', 'kind-html-team', 'kind-cookie-team']) {
  test(`Node→real Python selects the kind-classified team and returns the original callback: ${mode}`, async () => {
    const stages = [];
    // Early-mode guards require the actual team POST immediately after the first Web MFA, before session.
    const result = await workspaceFixtureLogin(mode)({ ...input, onStage(stage) { stages.push(stage); } });
    assert.deepEqual(result, { code: 'target-code', state: 'sub2-state', redirectUri });
    assert.deepEqual(stages, ['warmup', 'csrf', 'authorizing', 'email', 'password', 'totp',
      ...(mode.includes('web') ? ['consent', 'authorizing'] : ['authorizing', 'consent'])]);
  });
}

for (const [mode, code] of Object.entries({
  'kind-raw-conflict-web': 'OAUTH_WORKSPACE_CONFLICT',
  'kind-raw-conflict-html': 'OAUTH_WORKSPACE_CONFLICT',
  'kind-type-conflict-web': 'OAUTH_WORKSPACE_CONFLICT',
  'kind-type-source-conflict-web': 'OAUTH_WORKSPACE_CONFLICT',
  'unknown-kind-web': 'OAUTH_WORKSPACE_INVALID',
  'nonstring-kind-web': 'OAUTH_WORKSPACE_INVALID',
    'null-kind-web': 'OAUTH_WORKSPACE_INVALID', 'null-kind-html': 'OAUTH_WORKSPACE_INVALID',
    'null-kind-cookie-web': 'OAUTH_WORKSPACE_INVALID',
})) {
  test(`Node→real Python preserves kind failure classification with zero selection and no leaks: ${mode}`, async () => {
    const stages = [];
    await assert.rejects(workspaceFixtureLogin(mode)({ ...input, onStage(stage) { stages.push(stage); } }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message, code === 'OAUTH_WORKSPACE_CONFLICT'
        ? '工作空间信息来源不一致，已停止授权，未推送账号' : '工作空间数据格式无法完整解析，已停止授权，未推送账号');
      assert.equal(error.statusCode, 422);
      assert.equal(error.safe, true);
      assert.equal(error.needsAttention, true);
      const exposed = JSON.stringify({ ...error, message: error.message });
      for (const secret of [input.password, input.totpSecret, 'workspace-personal', 'workspace-team',
        'fixture-kind-team-private', 'fixture-kind-personal-private', 'fixture-kind-unknown-private',
        'fixture-kind-invalid-private', 'web-code', 'target-code', 'web-only-token']) {
        assert.ok(!exposed.includes(secret));
      }
      return true;
    });
    assert.deepEqual(stages, ['warmup', 'csrf', 'authorizing', 'email', 'password', 'totp',
      ...(mode.endsWith('html') ? ['authorizing', 'consent'] : ['consent'])]);
  });
}
