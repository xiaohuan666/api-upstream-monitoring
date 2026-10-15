import { setTimeout as delay } from 'node:timers/promises';

/**
 * Cross-process proxy mapping exclusion. Wait outside the pool, and lend the
 * lock-holding client to mapping I/O so even a full pool has no nested checkout.
 */
export async function withOAuthProxyLock(pool, mySiteId, proxyId, fn, { signal } = {}) {
  const key = `oauth-proxy:${mySiteId}:${proxyId}`;
  for (;;) {
    signal?.throwIfAborted();
    const client = await pool.connect();
    let locked = false;
    let releaseError;
    try {
      signal?.throwIfAborted();
      locked = (await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [key])).rows[0].locked;
      if (locked) {
        signal?.throwIfAborted();
        return await fn(client);
      }
    } catch (error) {
      // A failed lock query can leave ownership uncertain; do not reuse that session.
      if (!locked) releaseError = error;
      throw error;
    } finally {
      try { if (locked) await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [key]); }
      catch (error) { releaseError = error; throw error; }
      finally { client.release(releaseError); }
    }
    await delay(50, undefined, { signal });
  }
}
