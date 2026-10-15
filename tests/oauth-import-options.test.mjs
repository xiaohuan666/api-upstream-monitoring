import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  IMPORT_PLAN_TYPES, defaultImportOptions, normalizeImportOptions, importModelMapping, accountMatchesImportOptions,
} from '../src/oauth-import-options.mjs';

const SECRET = 'password-token-totp-do-not-leak';
function invalid(input) {
  assert.throws(() => normalizeImportOptions(input), (error) => {
    assert.equal(error.safe, true);
    assert.equal(error.code, 'INVALID_IMPORT_OPTIONS');
    assert.equal(error.statusCode, 400);
    assert.equal(error.cause, undefined);
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(SECRET));
    return true;
  });
}
function persisted(input = {}) {
  const options = normalizeImportOptions(input);
  return {
    name: 'display is not identity', concurrency: options.concurrency, load_factor: options.loadFactor,
    priority: options.priority, rate_multiplier: options.rateMultiplier, auto_pause_on_expired: options.autoPauseOnExpired,
    schedulable: options.schedulable, credentials: { model_mapping: importModelMapping(options), plan_type: options.planType || 'plus' },
    extra: { anti_degradation: options.accountProtection, codex_fingerprint_mode: options.fingerprintMode,
      openai_oauth_responses_websockets_v2_mode: options.wsMode,
      openai_oauth_responses_websockets_v2_enabled: options.wsMode !== 'off' },
  };
}

test('default schema has exactly the agreed fields, six models and independent containers', () => {
  const defaults = defaultImportOptions();
  assert.deepEqual(defaults, {
    modelMode: 'whitelist', models: ['codex-auto-review', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6.1-sol'],
    modelMapping: {}, concurrency: 50, loadFactor: 50, priority: 1, rateMultiplier: 1,
    accountProtection: false, fingerprintMode: 'device', wsMode: 'off', planType: '', autoPauseOnExpired: true, schedulable: true,
  });
  assert.deepEqual(normalizeImportOptions(), defaults);
  assert.deepEqual(normalizeImportOptions({}), defaults);
  defaults.models.push('custom'); defaults.modelMapping.custom = 'custom';
  assert.equal(defaultImportOptions().models.length, 6);
  assert.deepEqual(defaultImportOptions().modelMapping, {});
});

test('schema accepts explicit endpoints and zero rate, strictly clones model containers and does not mutate', () => {
  const input = { modelMode: 'mapping', models: ['custom', 'custom'], modelMapping: { 'custom-*': 'upstream' },
    concurrency: 10_000, loadFactor: null, priority: 10_000, rateMultiplier: 0,
    fingerprintMode: 'full', wsMode: 'http_bridge', planType: 'self_serve_business_prolite',
    autoPauseOnExpired: false, schedulable: false };
  const before = structuredClone(input);
  const result = normalizeImportOptions(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.models, ['custom']);
  assert.notEqual(result.models, input.models);
  assert.notEqual(result.modelMapping, input.modelMapping);
  result.models.push('other'); result.modelMapping.other = 'different';
  assert.deepEqual(input, before);
  assert.equal(normalizeImportOptions({ concurrency: 1, loadFactor: 1, priority: 1, rateMultiplier: 0.25 }).rateMultiplier, 0.25);
});

test('all actual Sub2 plan enums and fingerprint/WS enums are accepted without aliases', () => {
  assert.deepEqual(IMPORT_PLAN_TYPES, ['', 'free', 'go', 'plus', 'prolite', 'pro', 'promax', 'team',
    'self_serve_business_usage_based', 'self_serve_business_prolite', 'business', 'enterprise', 'ent26',
    'enterprise_cbp_usage_based', 'enterprise_cbp_automation', 'edu', 'edu_plus', 'edu_pro', 'unknown']);
  for (const planType of IMPORT_PLAN_TYPES) assert.equal(normalizeImportOptions({ planType }).planType, planType);
  for (const fingerprintMode of ['off', 'device', 'session', 'full']) assert.equal(normalizeImportOptions({ fingerprintMode }).fingerprintMode, fingerprintMode);
  for (const wsMode of ['off', 'ctx_pool', 'passthrough', 'http_bridge']) assert.equal(normalizeImportOptions({ wsMode }).wsMode, wsMode);
});

test('effective mapping is nested, whitelist is exact, mapping accepts terminal wildcard only, unrestricted is explicit', () => {
  assert.deepEqual(importModelMapping(normalizeImportOptions({ models: ['custom-model'] })), { 'custom-model': 'custom-model' });
  assert.deepEqual(importModelMapping(normalizeImportOptions({ modelMode: 'mapping', modelMapping: { '*': 'custom', 'gpt-*': 'upstream' } })), { '*': 'custom', 'gpt-*': 'upstream' });
  assert.deepEqual(importModelMapping(normalizeImportOptions({ modelMode: 'unrestricted', models: [], modelMapping: {} })), {});
  invalid({ models: [] });
  invalid({ modelMode: 'mapping', modelMapping: {} });
  invalid({ modelMode: 'unrestricted', modelMapping: { custom: 'custom' } });
});

for (const field of ['concurrency', 'loadFactor', 'priority']) {
  for (const value of [0, -1, 10_001, 1.5, true, false, '50', '', NaN, Infinity, undefined, {}, []]) {
    test(`rejects strict integer ${field}: ${String(value)}`, () => invalid({ [field]: value }));
  }
  if (field !== 'loadFactor') test(`rejects null ${field}`, () => invalid({ [field]: null }));
}
for (const value of [-1, true, false, '1', '', NaN, Infinity, -Infinity, null, undefined, {}, []]) {
  test(`rejects strict rate: ${String(value)}`, () => invalid({ rateMultiplier: value }));
}
for (const field of ['autoPauseOnExpired', 'schedulable']) {
  for (const value of [1, 0, 'true', 'false', '', null, undefined, {}, []]) {
    test(`rejects strict bool ${field}: ${String(value)}`, () => invalid({ [field]: value }));
  }
}
for (const [field, values] of Object.entries({
  modelMode: ['all', 'Whitelist', null, 1], fingerprintMode: ['seed', 'Device', '', null, false],
  wsMode: ['shared', 'dedicated', 'ON', '', null, false], planType: ['Business Premium', 'chatgptpro', 'PLUS', null, false],
})) {
  for (const value of values) test(`rejects enum ${field}: ${String(value)}`, () => invalid({ [field]: value }));
}
for (const key of ['email', 'password', 'totp', 'totpSecret', 'credentials', 'access_token', 'refresh_token', 'id_token',
  'chatgpt_account_id', 'chatgpt_user_id', 'proxyId', 'groupIds', 'extra', 'codex_fingerprint_seed', 'fingerprintSeed', 'unknown']) {
  test(`rejects unknown/secret field ${key} without echo`, () => invalid({ [key]: SECRET }));
}

test('rejects malformed JSON data, accessors, sparse arrays, symbols and prototype pollution without invoking getters', () => {
  for (const input of [null, true, 50, 'text', [], new Date(), Object.create({ password: SECRET }),
    JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: SECRET }, { prototype: SECRET },
    { [Symbol('secret')]: SECRET }, Object.defineProperty({}, 'models', { get() { throw new Error(SECRET); }, enumerable: true }),
    Object.defineProperty({}, 'password', { value: SECRET }),
  ]) invalid(input);
  let calls = 0;
  invalid({ models: Object.defineProperty([], '0', { get() { calls += 1; return SECRET; }, enumerable: true }) });
  invalid({ modelMapping: Object.defineProperty({}, 'model', { get() { calls += 1; return SECRET; }, enumerable: true }) });
  assert.equal(calls, 0);
  for (const models of [new Array(2), [null], [1], [''], [' whitespace'], ['gpt *'], ['gpt-*'], ['__proto__'], ['constructor'], ['bad\0model'], 'model']) invalid({ models });
  for (const modelMapping of [null, [], 1, { 'g*pt': 'gpt' }, { 'gpt**': 'gpt' }, { gpt: 'gpt*' }, { '': 'gpt' },
    { gpt: '' }, { gpt: null }, { gpt: true }, { gpt: {} }, { constructor: 'gpt' }, { gpt: '__proto__' },
    JSON.parse('{"__proto__":"gpt"}'), Object.create({ model: 'model' }), { 'bad\nmodel': 'gpt' },
  ]) invalid({ modelMode: 'mapping', modelMapping });
  assert.equal({}.polluted, undefined);
});

test('pure module executes in a browser-like realm with no Node globals or imports', async () => {
  const source = await readFile(new URL('../src/oauth-import-options.mjs', import.meta.url), 'utf8');
  assert.ok(!/^import\s/mu.test(source));
  const browser = vm.createContext({});
  vm.runInContext(source.replace(/^export /gmu, '') + '\nglobalThis.result = accountMatchesImportOptions({ credentials: {} }, defaultImportOptions());', browser);
  assert.equal(browser.result, false);
});

test('reconciliation verifies every root option and does not confuse account identity with display name', () => {
  const options = normalizeImportOptions({ concurrency: 80, priority: 2, rateMultiplier: 0, autoPauseOnExpired: false, schedulable: false });
  const account = persisted(options);
  assert.equal(accountMatchesImportOptions(account, options), true);
  for (const [field, value] of Object.entries({ concurrency: 79, load_factor: 51, priority: 1, rate_multiplier: 1,
    auto_pause_on_expired: true, schedulable: true })) {
    assert.equal(accountMatchesImportOptions({ ...account, [field]: value }, options), false, field);
    assert.equal(accountMatchesImportOptions({ ...account, [field]: String(account[field]) }, options), false, `${field} string`);
    const missing = { ...account }; delete missing[field];
    assert.equal(accountMatchesImportOptions(missing, options), false, `${field} missing`);
  }
  assert.equal(accountMatchesImportOptions({ name: 'looks-correct' }, options), false);
});

test('reconciliation reads credentials.model_mapping exact contents, not similarly named root/extra fields', () => {
  const options = { modelMode: 'mapping', modelMapping: { 'gpt-*': 'target', exact: 'exact' } };
  const account = persisted(options);
  assert.equal(accountMatchesImportOptions(account, options), true);
  for (const wrong of [{}, null, [], { 'gpt-*': 'other', exact: 'exact' }, { 'gpt-*': 'target', exact: 'exact', extra: 'extra' }, { 'gpt-*': 1, exact: 'exact' }]) {
    assert.equal(accountMatchesImportOptions({ ...account, credentials: { model_mapping: wrong }, model_mapping: options.modelMapping }, options), false);
  }
  const reversed = { exact: 'exact', 'gpt-*': 'target' };
  assert.equal(accountMatchesImportOptions({ ...account, credentials: { model_mapping: reversed } }, options), true);
  const missing = { ...account, credentials: {} };
  assert.equal(accountMatchesImportOptions(missing, options), false);
});

test('reconciliation handles only proven Sub2 omitted defaults; no optimistic WS default', () => {
  const options = { modelMode: 'unrestricted', models: [], loadFactor: null, fingerprintMode: 'off' };
  const account = persisted(options);
  delete account.load_factor;
  delete account.credentials.model_mapping;
  delete account.extra.codex_fingerprint_mode;
  assert.equal(accountMatchesImportOptions(account, options), true);
  account.credentials.model_mapping = null;
  assert.equal(accountMatchesImportOptions(account, options), true);
  account.credentials.model_mapping = { unexpected: 'restriction' };
  assert.equal(accountMatchesImportOptions(account, options), false);
  delete account.credentials.model_mapping;
  delete account.extra.openai_oauth_responses_websockets_v2_mode;
  assert.equal(accountMatchesImportOptions(account, options), false);
  account.extra.openai_oauth_responses_websockets_v2_mode = 'off';
  delete account.extra.openai_oauth_responses_websockets_v2_enabled;
  assert.equal(accountMatchesImportOptions(account, options), false);
});

test('reconciliation checks explicit plan overrides only and both exact WS wire fields', () => {
  for (const wsMode of ['off', 'ctx_pool', 'passthrough', 'http_bridge']) {
    const options = { planType: 'self_serve_business_prolite', fingerprintMode: 'session', wsMode };
    const account = persisted(options);
    assert.equal(accountMatchesImportOptions(account, options), true);
    account.credentials.plan_type = 'plus';
    assert.equal(accountMatchesImportOptions(account, options), false);
    assert.equal(accountMatchesImportOptions(account, { ...options, planType: '' }), true);
    account.extra.openai_oauth_responses_websockets_v2_enabled = wsMode === 'off';
    assert.equal(accountMatchesImportOptions(account, { ...options, planType: '' }), false);
    account.extra.openai_oauth_responses_websockets_v2_enabled = wsMode !== 'off';
    account.extra.openai_oauth_responses_websockets_v2_mode = 'unrecognized';
    assert.equal(accountMatchesImportOptions(account, { ...options, planType: '' }), false);
    account.extra.openai_oauth_responses_websockets_v2_mode = wsMode;
    account.extra.codex_fingerprint_mode = 'device';
    assert.equal(accountMatchesImportOptions(account, { ...options, planType: '' }), false);
  }
  assert.equal(accountMatchesImportOptions(null, {}), false);
  assert.throws(() => accountMatchesImportOptions(persisted(), { password: SECRET }), { code: 'INVALID_IMPORT_OPTIONS' });
});

test('canonical model sorting/dedup and key sorting produce identical snapshots for reordered requests', () => {
  const left = normalizeImportOptions({ models: ['z', 'a', 'z'], modelMapping: { z: 'target-z', a: 'target-a' } });
  const right = normalizeImportOptions({ models: ['a', 'z'], modelMapping: { a: 'target-a', z: 'target-z' } });
  assert.deepEqual(left.models, ['a', 'z']);
  assert.deepEqual(Object.keys(left.modelMapping), ['a', 'z']);
  assert.equal(JSON.stringify(left), JSON.stringify(right));
});

test('schema bounds model lengths and rule counts before persistence, including inactive fields', () => {
  const models = Array.from({ length: 200 }, (_, index) => `model-${index}`);
  const modelMapping = Object.fromEntries(models.map((model) => [model, 'x'.repeat(200)]));
  assert.equal(normalizeImportOptions({ models }).models.length, 200);
  assert.equal(Object.keys(normalizeImportOptions({ modelMode: 'mapping', modelMapping }).modelMapping).length, 200);
  assert.equal(normalizeImportOptions({ models: ['x'.repeat(200)] }).models[0].length, 200);
  invalid({ models: [...models, 'extra'] });
  invalid({ models: Array(201).fill('duplicate') });
  invalid({ modelMapping: { ...modelMapping, extra: 'extra' } });
  invalid({ models: ['x'.repeat(201)] });
  invalid({ modelMapping: { ['x'.repeat(201)]: 'target' } });
  invalid({ modelMapping: { source: 'x'.repeat(201) } });
});


test('billing multiplier matches numeric(10,4) exactly before any side effects', () => {
  for (const value of [1.23456, 0.00001, 1000000, 999999.99999, 1e-8]) invalid({ rateMultiplier: value });
  for (const value of [0, 0.0001, 1.2345, 999999.9999]) assert.equal(normalizeImportOptions({ rateMultiplier: value }).rateMultiplier, value);
});

test('new protection intent must be persisted, while historical snapshots retain their reconciliation contract', () => {
  const options = defaultImportOptions();
  assert.equal(options.accountProtection, false);
  assert.equal(options.fingerprintMode, 'device');
  const remote = persisted(options);
  assert.equal(accountMatchesImportOptions(remote, options), true);
  remote.extra.anti_degradation = true;
  assert.equal(accountMatchesImportOptions(remote, options), false);
  delete remote.extra.anti_degradation;
  assert.equal(accountMatchesImportOptions(remote, options), false);
  const legacy = { ...options }; delete legacy.accountProtection;
  assert.equal(accountMatchesImportOptions(remote, legacy), true);
  invalid({ accountProtection: 'false' });
  invalid({ accountProtection: true });
});
