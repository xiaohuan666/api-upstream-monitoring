import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createProxyRepository, initializeDatabase } from '../src/db.mjs';
import { buildProxyExportContent, PROXY_EXPORT_FORMATS } from '../src/proxy-export.mjs';

const connectionString = process.env.PROXY_PROVIDER_TEST_DATABASE_URL;
test('PostgreSQL probe migration, save, stale-write rejection and edits preserve export contract', { skip: !connectionString }, async () => {
  const schema = `probe_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  try {
    await admin.query(`create schema ${schema}`);
    await initializeDatabase(pool);
    const repo = createProxyRepository(pool);
    const original = await repo.createProxy({ name: 'A-001', provider: 'A', protocol: 'socks5', host: '192.0.2.1', port: 1080, username: 'u', password: 'p' });
    await pool.query('alter table proxies drop column probe_result');
    await initializeDatabase(pool);
    await initializeDatabase(pool);
    assert.equal((await repo.getProxyById(original.id)).probeResult, null);
    const result = { ok: true, ip: '203.0.113.2', country: '美国', latencyMs: 150, checkedAt: new Date().toISOString() };
    assert.equal(await repo.saveProxyProbe(original, result), true);
    const saved = await repo.getProxyById(original.id);
    assert.deepEqual(saved.probeResult, result);
    // 两次导出比较业务内容，使用相同时间避免毫秒边界制造无关差异。
    const exportedAt = new Date('2026-10-02T00:00:00Z');
    for (const format of PROXY_EXPORT_FORMATS) assert.equal(buildProxyExportContent(saved ? [saved] : [], format.id, exportedAt), buildProxyExportContent([original], format.id, exportedAt));
    const renamed = await repo.updateProxy(original.id, { ...saved, name: 'new name' });
    assert.deepEqual(renamed.probeResult, result);
    const edited = await repo.updateProxy(original.id, { ...renamed, password: 'new-password' });
    assert.equal(edited.probeResult, null);
    assert.equal(await repo.saveProxyProbe(original, result), false);
    assert.equal(await repo.saveProxyProbe(edited, { ...result, ok: false, ip: '', country: '' }), true);
    assert.equal((await repo.getProxyById(original.id)).probeResult.ip, '');
    await repo.deleteProxy(original.id);
    assert.equal(await repo.saveProxyProbe(edited, result), false);
  } finally {
    await pool.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
});


test('PostgreSQL import canonicalizes legacy IPv6 identities before allocating provider numbers', { skip: !connectionString }, async () => {
  const schema = `probe_identity_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  try {
    await admin.query(`create schema ${schema}`);
    await initializeDatabase(pool);
    const repo = createProxyRepository(pool);
    const original = await repo.createProxy({ name: 'A-001', provider: 'A', protocol: 'socks5', host: '2001:db8::1', port: 1080, username: 'u', password: ' p ' });
    assert.match(original.url, /@\[2001:db8::1\]:1080/);
    await pool.query('update proxies set host = $1 where id = $2', ['[2001:0DB8:0000:0:0:0:0:1]', original.id]);
    const result = await repo.createProxiesBatch([
      { ...original, host: '2001:db8::1', protocol: 'http' },
      { ...original, host: '[2001:db8::2]' },
      { ...original, host: '2001:0DB8:0:0:0:0:0:2' },
      { ...original, host: '2001:db8::3' },
    ]);
    assert.equal(result.skipped, 2);
    assert.deepEqual(result.created.map((p) => [p.name, p.host, p.password]), [
      ['A-002', '2001:db8::2', ' p '], ['A-003', '2001:db8::3', ' p '],
    ]);
  } finally {
    await pool.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
});
