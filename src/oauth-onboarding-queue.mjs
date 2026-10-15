/** Bounded admission lives in PostgreSQL; this owner holds only the accepted jobs' ephemeral secrets. */
export function createOAuthOnboardingQueue({ store, ownerId, execute, heartbeatMs = 30_000, pollMs = 500 }) {
  const pending = new Map();
  const running = new Map();
  let closed = false;
  let pumping = null;
  let renewing = null;
  let timer;
  let heartbeat;
  const clearSecrets = (task) => { task.secrets.password = ''; task.secrets.totpSecret = ''; };
  async function abandon(task) {
    clearSecrets(task);
    try { await store.update(task.job.id, ownerId, { status: 'needs_attention', errorCode: 'TASK_INTERRUPTED', message: task.job.credentialStored ? '任务已中断，可在入池任务中显式重跑' : '任务已中断，请重新输入凭据发起任务' }); }
    catch { /* Stale leases are recovered by the repository, never reassigned to a secret-less worker. */ }
    task.resolve();
  }
  function schedule() {
    clearTimeout(timer);
    if (!closed && pending.size) {
      timer = setTimeout(() => { void pump(); }, pollMs);
      timer.unref?.();
    }
    if (!pending.size && !running.size) { clearInterval(heartbeat); heartbeat = null; }
  }
  async function runPump() {
    for (const [id, task] of pending) {
      if (closed) break;
      let job;
      try { job = await store.claimQueued(id, ownerId); }
      catch { pending.delete(id); await abandon(task); continue; }
      if (!job) break;
      pending.delete(id);
      if (closed) { await abandon(task); break; }
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => execute(job, task.secrets, controller))
        .catch(() => abandon(task)).finally(() => {
          clearSecrets(task); running.delete(id); task.resolve(); schedule();
        });
      running.set(id, { controller, promise });
    }
  }
  function pump() {
    if (!pumping) pumping = runPump().finally(() => { pumping = null; schedule(); });
    return pumping;
  }
  function renew() {
    if (renewing) return;
    renewing = (async () => {
      for (const [id, task] of pending) {
        try { if (await store.heartbeat(id, ownerId)) continue; } catch { /* Stop if ownership cannot be proved. */ }
        if (pending.delete(id)) await abandon(task);
      }
    })().finally(() => { renewing = null; });
  }
  return {
    enqueue(job, secrets) {
      if (closed) throw new Error('Queue closed');
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      pending.set(job.id, { job, secrets, promise, resolve });
      if (!heartbeat) { heartbeat = setInterval(renew, heartbeatMs); heartbeat.unref?.(); }
      void pump();
    },
    async waitForIdle() {
      while (pending.size || running.size || pumping) {
        await pump();
        const promises = [...pending.values(), ...running.values()].map((task) => task.promise);
        if (promises.length) await Promise.all(promises);
      }
    },
    async close() {
      closed = true;
      clearTimeout(timer); clearInterval(heartbeat);
      if (pumping) await pumping;
      if (renewing) await renewing;
      const abandoned = [...pending.values()]; pending.clear();
      await Promise.all(abandoned.map(abandon));
      for (const task of running.values()) task.controller.abort();
      await Promise.allSettled([...running.values()].map((task) => task.promise));
    },
  };
}
