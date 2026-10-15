import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { createOAuthCredentialVault } from '../src/oauth-credential-vault.mjs';

const key = Buffer.alloc(32, 251).toString('base64');
const wrongKey = Buffer.alloc(32, 252).toString('base64');
const job = {
  id: 'job-one', mySiteId: 'site-one', targetUrl: 'https://target.example.test/', email: 'vault@example.test',
  proxyId: 'proxy-one', groupIds: [11, 22], importOptions: { priority: 9, nested: { z: 'last', a: 'first' } },
  accountName: 'Vault account',
};
const secrets = {
  password: ' secret-password-勿归一化 ', totpSecret: 'JBSWY3DPEHPK3PXP',
  proxySnapshot: { protocol: 'socks5', host: 'proxy.example.test', port: 1080,
    username: 'secret-proxy-user', password: 'secret-proxy-password' },
};
const sensitiveValues = [key, wrongKey, secrets.password, secrets.totpSecret,
  secrets.proxySnapshot.username, secrets.proxySnapshot.password, 'raw-error-secret'];

function safeFailure(run, code = 'CREDENTIALS_UNAVAILABLE', statusCode = 409) {
  assert.throws(run, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.safe, true);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    const output = `${String(error)}\n${error.stack}\n${JSON.stringify(error)}\n${inspect(error, { depth: null })}`;
    for (const secret of sensitiveValues) assert.equal(output.includes(secret), false);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'safe', 'statusCode']);
    return true;
  });
}

function mutate(envelope, field) {
  const parsed = JSON.parse(envelope);
  const bytes = Buffer.from(parsed[field], 'base64');
  bytes[0] ^= 1;
  parsed[field] = bytes.toString('base64');
  return JSON.stringify(parsed);
}

// Independent explicit wire AAD verifies all eight names and recursively sorted object keys.
const aad = Buffer.from('{"accountName":"Vault account","email":"vault@example.test","groupIds":[11,22],'
  + '"id":"job-one","importOptions":{"nested":{"a":"first","z":"last"},"priority":9},'
  + '"mySiteId":"site-one","proxyId":"proxy-one","targetUrl":"https://target.example.test/"}');

function authenticatedEnvelope(plaintext) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({ version: 1, nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}

test('vault round trip preserves credentials and encrypted proxy snapshot without mutating inputs', () => {
  const vault = createOAuthCredentialVault({ key });
  const beforeJob = structuredClone(job);
  const beforeSecrets = structuredClone(secrets);
  assert.doesNotThrow(() => vault.assertReady());
  const envelope = vault.seal(job, secrets);
  assert.equal(typeof envelope, 'string');
  assert.deepEqual(vault.open(job, envelope), secrets);
  assert.deepEqual(job, beforeJob);
  assert.deepEqual(secrets, beforeSecrets);
  for (const value of sensitiveValues) assert.equal(envelope.includes(value), false);
  for (const field of ['password', 'totpSecret', 'proxySnapshot', 'host', 'username', 'email', 'targetUrl']) {
    assert.equal(envelope.includes(field), false);
  }
  const parsed = JSON.parse(envelope);
  assert.deepEqual(Object.keys(parsed).sort(), ['ciphertext', 'nonce', 'tag', 'version']);
  assert.equal(parsed.version, 1);
  assert.equal(Buffer.from(parsed.nonce, 'base64').length, 12);
  assert.equal(Buffer.from(parsed.tag, 'base64').length, 16);
  const opened = vault.open(job, envelope);
  opened.proxySnapshot.password = 'changed';
  assert.deepEqual(vault.open(job, envelope), secrets);
});

test('version 1 uses AES-256-GCM and the exact canonical metadata contract', () => {
  const vault = createOAuthCredentialVault({ key });
  const parsed = JSON.parse(vault.seal(job, { ...secrets, adminKey: 'not-persisted' }));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(parsed.nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  assert.deepEqual(payload, secrets);
  assert.deepEqual(vault.open(job, authenticatedEnvelope(JSON.stringify(secrets))), secrets);
});

test('fresh random nonce and ciphertext on repeated seals of the same credentials', () => {
  const vault = createOAuthCredentialVault({ key });
  const envelopes = Array.from({ length: 128 }, () => vault.seal(job, secrets));
  assert.equal(new Set(envelopes).size, envelopes.length);
  assert.equal(new Set(envelopes.map((value) => JSON.parse(value).nonce)).size, envelopes.length);
  assert.equal(new Set(envelopes.map((value) => JSON.parse(value).ciphertext)).size, envelopes.length);
  for (const envelope of envelopes) assert.deepEqual(vault.open(job, envelope), secrets);
});

test('construction never throws for missing or malformed keys; readiness/seal/open fail safely with 503', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const noncanonical = `${key.slice(0, -2)}${alphabet[alphabet.indexOf(key.at(-2)) + 1]}=`;
  assert.deepEqual(Buffer.from(noncanonical, 'base64'), Buffer.from(key, 'base64'));
  const malformedKeys = [null, '', 'raw-error-secret', 32, {}, Buffer.alloc(32),
    Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'),
    key.trimEnd() + '\n', ` ${key}`, key.slice(0, -1), key + '=', key.replaceAll('+', '-').replaceAll('/', '_'), noncanonical];
  for (const invalid of malformedKeys) {
    let vault;
    assert.doesNotThrow(() => { vault = createOAuthCredentialVault({ key: invalid }); });
    safeFailure(() => vault.assertReady(), 'CREDENTIAL_KEY_UNAVAILABLE', 503);
    safeFailure(() => vault.seal(job, secrets), 'CREDENTIAL_KEY_UNAVAILABLE', 503);
    safeFailure(() => vault.open(job, 'raw-error-secret'), 'CREDENTIAL_KEY_UNAVAILABLE', 503);
  }
});

test('default environment key is read at construction without making history initialization depend on it', () => {
  const previous = process.env.OAUTH_ONBOARDING_CREDENTIAL_KEY;
  try {
    delete process.env.OAUTH_ONBOARDING_CREDENTIAL_KEY;
    let historyVault;
    assert.doesNotThrow(() => { historyVault = createOAuthCredentialVault(); });
    safeFailure(() => historyVault.assertReady(), 'CREDENTIAL_KEY_UNAVAILABLE', 503);
    process.env.OAUTH_ONBOARDING_CREDENTIAL_KEY = key;
    const configured = createOAuthCredentialVault();
    assert.deepEqual(configured.open(job, configured.seal(job, secrets)), secrets);
    process.env.OAUTH_ONBOARDING_CREDENTIAL_KEY = wrongKey;
    assert.deepEqual(configured.open(job, configured.seal(job, secrets)), secrets);
    safeFailure(() => historyVault.assertReady(), 'CREDENTIAL_KEY_UNAVAILABLE', 503);
  } finally {
    if (previous === undefined) delete process.env.OAUTH_ONBOARDING_CREDENTIAL_KEY;
    else process.env.OAUTH_ONBOARDING_CREDENTIAL_KEY = previous;
  }
});

test('valid but wrong key never returns credentials and reports only the fixed 409 error', () => {
  const envelope = createOAuthCredentialVault({ key }).seal(job, secrets);
  safeFailure(() => createOAuthCredentialVault({ key: wrongKey }).open(job, envelope));
});

for (const field of ['nonce', 'tag', 'ciphertext']) {
  test(`tampering ${field} fails authentication without any secret in the error`, () => {
    const vault = createOAuthCredentialVault({ key });
    safeFailure(() => vault.open(job, mutate(vault.seal(job, secrets), field)));
  });
}

for (const [field, value] of Object.entries({
  id: 'job-two', mySiteId: 'site-two', targetUrl: 'https://different.example.test/',
  email: 'different@example.test', proxyId: 'proxy-two', groupIds: [11, 33],
  importOptions: { priority: 9, nested: { z: 'changed', a: 'first' } }, accountName: 'Different account',
})) {
  test(`AAD binds ${field} and rejects cross-task/changed metadata`, () => {
    const vault = createOAuthCredentialVault({ key });
    safeFailure(() => vault.open({ ...job, [field]: value }, vault.seal(job, secrets)));
  });
}

test('canonical object key ordering includes nested objects, arrays, numeric keys and __proto__', () => {
  const vault = createOAuthCredentialVault({ key });
  const left = { ...job, importOptions: JSON.parse('{"nested":{"10":"ten","2":"two","__proto__":{"z":2,"a":1}},"list":[{"z":2,"a":1}]}') };
  const right = { accountName: job.accountName, importOptions: JSON.parse('{"list":[{"a":1,"z":2}],"nested":{"__proto__":{"a":1,"z":2},"2":"two","10":"ten"}}'),
    groupIds: job.groupIds, proxyId: job.proxyId, email: job.email, targetUrl: job.targetUrl, mySiteId: job.mySiteId, id: job.id };
  assert.deepEqual(vault.open(right, vault.seal(left, secrets)), secrets);
  right.importOptions.nested.__proto__.a = 9;
  safeFailure(() => vault.open(right, vault.seal(left, secrets)));
});

test('array ordering and JSON value types are not silently normalized in AAD', () => {
  const vault = createOAuthCredentialVault({ key });
  const envelope = vault.seal(job, secrets);
  safeFailure(() => vault.open({ ...job, groupIds: [22, 11] }, envelope));
  safeFailure(() => vault.open({ ...job, importOptions: { priority: '9', nested: job.importOptions.nested } }, envelope));
  safeFailure(() => vault.open({ ...job, email: job.email.toUpperCase() }, envelope));
});

test('unbound lifecycle fields may change, while omitted optional metadata uses persisted defaults', () => {
  const vault = createOAuthCredentialVault({ key });
  const minimalJob = { id: job.id, mySiteId: job.mySiteId, targetUrl: job.targetUrl, email: job.email, groupIds: job.groupIds };
  const envelope = vault.seal(minimalJob, { password: secrets.password });
  assert.deepEqual(vault.open({ ...minimalJob, proxyId: null, importOptions: null, accountName: '',
    status: 'succeeded', startedAt: 'now', finishedAt: 'later' }, envelope),
  { password: secrets.password, totpSecret: '', proxySnapshot: null });
  assert.deepEqual(vault.open({ ...job, status: 'running', stage: 'password', remoteAccountId: 99 }, vault.seal(job, secrets)), secrets);
});

test('malformed envelopes, unsupported versions and noncanonical encodings all fail safely', () => {
  const vault = createOAuthCredentialVault({ key });
  const envelope = vault.seal(job, secrets);
  const parsed = JSON.parse(envelope);
  const cases = [null, undefined, {}, 1, '', 'raw-error-secret', '["raw-error-secret"]', 'null', '"raw-error-secret"',
    { ...parsed, version: 2 }, { ...parsed, version: '1' }, { ...parsed, password: secrets.password },
    { ...parsed, nonce: Buffer.alloc(11).toString('base64') }, { ...parsed, tag: Buffer.alloc(15).toString('base64') },
    { ...parsed, nonce: `${parsed.nonce}\n` }, { ...parsed, nonce: `${parsed.nonce}=` },
    { ...parsed, nonce: 12 }, { ...parsed, tag: parsed.tag.slice(0, -2) },
    { ...parsed, tag: Buffer.alloc(16, 255).toString('base64').replaceAll('/', '_') },
    { ...parsed, ciphertext: '' }, { ...parsed, ciphertext: '@raw-error-secret' },
    { ...parsed, ciphertext: parsed.ciphertext.slice(4) }];
  for (const field of Object.keys(parsed)) {
    const missing = { ...parsed }; delete missing[field]; cases.push(missing);
  }
  for (const candidate of cases) {
    safeFailure(() => vault.open(job, candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? JSON.stringify(candidate) : candidate));
  }
});

test('even authenticated malformed plaintext cannot escape as usable credentials', () => {
  const vault = createOAuthCredentialVault({ key });
  for (const payload of ['raw-error-secret', 'null', '[]', '{}',
    JSON.stringify({ ...secrets, password: 123 }), JSON.stringify({ ...secrets, totpSecret: {} }),
    JSON.stringify({ ...secrets, proxySnapshot: [] }), JSON.stringify({ ...secrets, adminKey: 'raw-error-secret' })]) {
    safeFailure(() => vault.open(job, authenticatedEnvelope(payload)));
  }
});

test('invalid credential and metadata inputs never leak original values or thrown causes', () => {
  const vault = createOAuthCredentialVault({ key });
  for (const input of [null, [], {}, { ...secrets, password: '' }, { ...secrets, password: 'x'.repeat(1025) },
    { ...secrets, password: {} }, { ...secrets, totpSecret: null }, { ...secrets, proxySnapshot: [] },
    { ...secrets, proxySnapshot: { host: undefined } },
    { get password() { throw new Error('raw-error-secret'); } }]) {
    safeFailure(() => vault.seal(job, input), 'INVALID_CREDENTIALS', 400);
  }
  const cyclic = {}; cyclic.self = cyclic;
  for (const metadata of [null, [], {}, { ...job, id: '' }, { ...job, groupIds: [] },
    { ...job, groupIds: ['11'] }, { ...job, importOptions: { value: NaN } },
    { ...job, importOptions: { value: Infinity } }, { ...job, importOptions: { value: undefined } },
    { ...job, importOptions: { value: () => secrets.password } }, { ...job, importOptions: { value: 1n } },
    { ...job, importOptions: { value: new Date() } }, { ...job, importOptions: { value: new Map() } },
    { ...job, importOptions: { value: new Array(1) } }, { ...job, importOptions: { [Symbol('secret')]: 1 } },
    { ...job, importOptions: cyclic }, { ...job, get email() { throw new Error('raw-error-secret'); } }]) {
    safeFailure(() => vault.seal(metadata, secrets), 'INVALID_CREDENTIALS', 400);
    safeFailure(() => vault.open(metadata, vault.seal(job, secrets)));
  }
});
