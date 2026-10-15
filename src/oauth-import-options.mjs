/** Browser-safe import contract. No account identity, credentials, proxy, or server fingerprint seed belongs here. */
export const IMPORT_PLAN_TYPES = Object.freeze([
  '', 'free', 'go', 'plus', 'prolite', 'pro', 'promax', 'team',
  'self_serve_business_usage_based', 'self_serve_business_prolite', 'business',
  'enterprise', 'ent26', 'enterprise_cbp_usage_based', 'enterprise_cbp_automation',
  'edu', 'edu_plus', 'edu_pro', 'unknown',
]);
// Wire enums verified against local Sub2 frontend/src/utils/planType.ts; labels are not wire values.
const DEFAULT_MODELS = Object.freeze([
  'codex-auto-review', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6.1-sol',
]);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_MODEL_LENGTH = 200;
const MAX_MODEL_RULES = 200;

function invalid() {
  const error = new Error('OAuth 导入选项无效');
  error.safe = true;
  error.code = 'INVALID_IMPORT_OPTIONS';
  error.statusCode = 400;
  throw error;
}

/** Every call returns independent mutable arrays/maps for UI edits and task snapshots. */
export function defaultImportOptions() {
  return {
    modelMode: 'whitelist', models: [...DEFAULT_MODELS], modelMapping: {},
    concurrency: 50, loadFactor: 50, priority: 1, rateMultiplier: 1,
    accountProtection: false, fingerprintMode: 'device', wsMode: 'off', planType: '',
    autoPauseOnExpired: true, schedulable: true,
  };
}

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// JSON-only data: accessors and non-enumerable/symbol properties must not disappear at serialization.
function entries(value) {
  if (!plainRecord(value)) invalid();
  return Reflect.ownKeys(value).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || UNSAFE_KEYS.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    return [key, descriptor.value];
  });
}

function modelName(value, wildcard = false) {
  if (typeof value !== 'string' || !value || value.length > MAX_MODEL_LENGTH
    || /[\s\p{Cc}]/u.test(value) || UNSAFE_KEYS.has(value)) invalid();
  const stars = value.split('*').length - 1;
  if (stars && (!wildcard || stars !== 1 || !value.endsWith('*'))) invalid();
  return value;
}

function modelsList(value) {
  if (!Array.isArray(value) || value.length > MAX_MODEL_RULES) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    result.push(modelName(descriptor.value));
  }
  return [...new Set(result)].sort();
}

function modelMap(value) {
  const rules = entries(value);
  if (rules.length > MAX_MODEL_RULES) invalid();
  return Object.fromEntries(rules.map(([source, target]) => [modelName(source, true), modelName(target)])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function integer(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) invalid();
  return value;
}
function enumValue(value, allowed) {
  if (!allowed.includes(value)) invalid();
  return value;
}
function boolean(value) {
  if (typeof value !== 'boolean') invalid();
  return value;
}

/** Accepts a partial plain JSON object, fills defaults, and never mutates or retains input references. */
export function normalizeImportOptions(input = {}) {
  try {
    const result = defaultImportOptions();
    const validators = {
      modelMode: (value) => enumValue(value, ['whitelist', 'mapping', 'unrestricted']),
      models: modelsList, modelMapping: modelMap, concurrency: integer,
      loadFactor: (value) => value === null ? null : integer(value), priority: integer,
      rateMultiplier: (value) => {
        // Sub2 persists numeric(10,4); reject lossy values before authorization, never relax reconciliation.
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 999999.9999
          || !/^\d+(?:\.\d{1,4})?$/.test(String(value))) invalid();
        return value;
      },
      fingerprintMode: (value) => enumValue(value, ['off', 'device', 'session', 'full']),
      wsMode: (value) => enumValue(value, ['off', 'ctx_pool', 'passthrough', 'http_bridge']),
      planType: (value) => enumValue(value, IMPORT_PLAN_TYPES),
      autoPauseOnExpired: boolean, schedulable: boolean,
      // This importer promises caller-selected fingerprints; managed protection can overwrite them.
      accountProtection: (value) => enumValue(value, [false]),
    };
    for (const [key, value] of entries(input)) {
      if (!Object.hasOwn(validators, key)) invalid();
      result[key] = validators[key](value);
    }
    if (result.modelMode === 'whitelist' && result.models.length === 0) invalid();
    if (result.modelMode === 'mapping' && Object.keys(result.modelMapping).length === 0) invalid();
    // Empty maps mean allow-all in Sub2; that intent must use the explicit unrestricted mode.
    if (result.modelMode === 'unrestricted' && Object.keys(result.modelMapping).length !== 0) invalid();
    return result;
  } catch {
    // Includes hostile accessors/proxies: never propagate input values or arbitrary exception messages.
    invalid();
  }
}

/** Converts only the model rule, never spreads option names into credentials. Options must be normalized. */
export function importModelMapping(options) {
  if (options.modelMode === 'whitelist') return Object.fromEntries(options.models.map((model) => [model, model]));
  if (options.modelMode === 'mapping') return { ...options.modelMapping };
  return {};
}

/** Verifies remote persisted settings, separately from email/seat/group/proxy identity reconciliation. */
export function accountMatchesImportOptions(account, options) {
  const expected = normalizeImportOptions(options);
  try {
    if (!plainRecord(account) || !plainRecord(account.credentials)
      || (account.extra != null && !plainRecord(account.extra))) return false;
    for (const [wire, key] of [
      ['concurrency', 'concurrency'], ['priority', 'priority'], ['rate_multiplier', 'rateMultiplier'],
      ['auto_pause_on_expired', 'autoPauseOnExpired'], ['schedulable', 'schedulable'],
    ]) {
      // Sub2 DTO always emits these; missing is unknown, not proof that server defaults took effect.
      if (!Object.hasOwn(account, wire) || account[wire] !== expected[key]) return false;
    }
    // Only load_factor is omitempty in the Sub2 admin DTO; absent and null both mean no override.
    const load = Object.hasOwn(account, 'load_factor') ? account.load_factor : null;
    if (load !== expected.loadFactor) return false;
    const credentials = account.credentials;
    const remoteMap = !Object.hasOwn(credentials, 'model_mapping') || credentials.model_mapping === null
      ? {} : modelMap(credentials.model_mapping);
    const wantedMap = importModelMapping(expected);
    if (Object.keys(remoteMap).length !== Object.keys(wantedMap).length
      || Object.entries(wantedMap).some(([key, value]) => !Object.hasOwn(remoteMap, key) || remoteMap[key] !== value)) return false;
    if (expected.planType && (!Object.hasOwn(credentials, 'plan_type') || credentials.plan_type !== expected.planType)) return false;
    const extra = account.extra ?? {};
    // Old persisted jobs predate this contract; their reconciliation must not acquire a new condition.
    if (Object.hasOwn(options, 'accountProtection') && extra.anti_degradation !== expected.accountProtection) return false;
    // Fingerprint is opt-in (missing = off); unlike fingerprint, WS inherits a target-configured default.
    const fingerprint = Object.hasOwn(extra, 'codex_fingerprint_mode') ? extra.codex_fingerprint_mode : 'off';
    return fingerprint === expected.fingerprintMode
      && Object.hasOwn(extra, 'openai_oauth_responses_websockets_v2_mode')
      && extra.openai_oauth_responses_websockets_v2_mode === expected.wsMode
      && Object.hasOwn(extra, 'openai_oauth_responses_websockets_v2_enabled')
      && extra.openai_oauth_responses_websockets_v2_enabled === (expected.wsMode !== 'off');
  } catch {
    return false;
  }
}
