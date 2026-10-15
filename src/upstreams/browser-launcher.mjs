import { chromium } from 'playwright';

// Isolate startup: launchServer 1.61.1 does not apply its timeout to the outer
// launch operation. Exiting this owner also runs Playwright's process-tree kill hook.
let server;
let stopping = false;
let launchTimer;
const stop = async (force = false) => {
  if (stopping && !force) return;
  stopping = true;
  clearTimeout(launchTimer);
  try {
    if (server) await (force ? server.kill() : server.close());
    // Flush the acknowledgement before exit; process exit alone cannot prove
    // that this owner actually completed its browser cleanup.
    if (process.connected) process.send({ type: 'stopped' }, () => process.exit(0));
    else process.exit(0);
  } catch {
    process.exit(1);
  }
};
process.on('message', async (message) => {
  if (message.type === 'close' || message.type === 'kill') {
    await stop(message.type === 'kill');
    return;
  }
  if (message.type !== 'launch' || stopping) return;
  launchTimer = setTimeout(() => { void stop(true); }, message.timeoutMs);
  try {
    server = await chromium.launchServer({ ...message.options, host: '127.0.0.1' });
    clearTimeout(launchTimer);
    process.send({ type: 'ready', endpoint: server.wsEndpoint(), pid: server.process().pid });
  } catch (error) {
    clearTimeout(launchTimer);
    if (process.connected) process.send({ type: 'error', message: error.message });
    process.exit(1);
  }
});
process.on('disconnect', () => { void stop(true); });
process.on('SIGTERM', () => { void stop(true); });
