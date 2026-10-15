import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

function timeoutError(stage, timeoutMs) {
  const error = new Error(`Browser ${stage} timeout after ${timeoutMs}ms`);
  error.code = 'BROWSER_TASK_TIMEOUT';
  error.stage = stage;
  return error;
}

async function within(operation, timeoutMs, stage) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError(stage, timeoutMs)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function positiveTimeout(value, name) {
  if (!Number.isFinite(value) || value <= 0 || value > 2 ** 31 - 1) {
    throw new RangeError(`${name} must be a positive finite timeout`);
  }
  return value;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function ownedChromium(launchOptions, launchTimeoutMs, cleanupTimeoutMs) {
  const owner = fork(new URL('./browser-launcher.mjs', import.meta.url), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let browserPid;
  let ownerExited = false;
  let ownerStopped = false;
  let ownerFailure;
  let browser;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  owner.once('exit', () => { ownerExited = true; });
  const exited = new Promise((resolve) => {
    // Drain IPC before judging whether the owner acknowledged cleanup.
    owner.once('close', (code, signal) => {
      if (!ownerStopped || code !== 0 || signal) {
        ownerFailure = new Error('Browser launch owner exited without confirming browser cleanup');
        ownerFailure.code = 'BROWSER_OWNER_EXITED';
      }
      rejectReady(ownerFailure ?? new Error('Browser launch owner exited before startup completed'));
      resolve();
    });
  });
  owner.on('error', rejectReady);
  owner.on('message', (message) => {
    if (message.type === 'ready') {
      browserPid = message.pid;
      resolveReady(message.endpoint);
    } else if (message.type === 'stopped') {
      ownerStopped = true;
    } else if (message.type === 'error') {
      rejectReady(new Error(message.message));
    }
  });
  const send = (type) => {
    if (owner.connected) owner.send({ type }, () => {});
  };
  // The PID comes only from this fork's BrowserServer.process() child handle.
  // Playwright launches that child in its own process group on POSIX. Retain
  // this ownership independently of the owner's lifetime or a root exit event.
  const browserRunning = () => browserPid && (
    processExists(browserPid) || (process.platform !== 'win32' && processExists(-browserPid))
  );
  const waitForBrowserExit = async (stage) => {
    const deadline = Date.now() + cleanupTimeoutMs;
    while (browserRunning()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError(stage, cleanupTimeoutMs);
      await delay(Math.min(20, remaining));
    }
  };
  owner.send({ type: 'launch', options: launchOptions, timeoutMs: launchTimeoutMs }, () => {});
  return {
    async launch() {
      const endpoint = await ready;
      browser = await chromium.connect(endpoint, { timeout: launchTimeoutMs });
      return browser;
    },
    async close() {
      send('close');
      await exited;
      if (ownerFailure) throw ownerFailure;
      await waitForBrowserExit('cleanup');
    },
    async kill() {
      // An owner exit does not release its browser's group. Even a root exit
      // leaves this group owned until all remaining browser children are gone.
      if (browserRunning()) {
        try { process.kill(process.platform === 'win32' ? browserPid : -browserPid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      send('kill');
      await Promise.all([exited, waitForBrowserExit('reap')]);
    },
    abandon() {
      // Last resort for an unresponsive launcher after its browser was killed.
      if (!ownerExited) owner.kill('SIGKILL');
    },
    disconnect() {
      // The owner closed the real browser; disconnect the client's transport too.
      void browser?.close().catch(() => {});
    },
  };
}

function injectedBrowser(browserType, launchOptions) {
  let browser;
  let stopped = false;
  const launched = Promise.resolve().then(() => browserType.launch(launchOptions)).then(async (value) => {
    browser = value;
    // A late fake launch must still observe cancellation. Real Chromium always
    // uses the process owner above, including when explicitly injected.
    if (stopped) await browser.close();
    return browser;
  });
  return {
    launch: () => launched,
    async close() { stopped = true; if (browser) await browser.close(); },
    async kill() { stopped = true; if (browser) await browser.close(); },
    abandon() {},
    disconnect() {},
  };
}

/** Run one complete collection (launch/connect/context/navigation/evaluate) with
 * an absolute deadline, then reclaim its browser before publishing any result.
 * Cleanup has separate graceful and forced budgets, even after a task timeout.
 */
export async function runBrowserTask(options, task) {
  const timeoutMs = positiveTimeout(options.timeoutMs ?? 20_000, 'timeoutMs');
  const launchTimeoutMs = positiveTimeout(options.launchTimeoutMs ?? Math.min(timeoutMs, 10_000), 'launchTimeoutMs');
  const cleanupTimeoutMs = positiveTimeout(options.cleanupTimeoutMs ?? 2_000, 'cleanupTimeoutMs');
  const report = (stage, result) => {
    try {
      options.logger?.info?.('[browser-task]', JSON.stringify({ siteId: options.siteId, stage, result }));
    } catch { /* Diagnostics must not prevent browser reclamation. */ }
  };
  const browserType = options.browserType ?? chromium;
  const launchOptions = { ...options.launchOptions, timeout: Math.min(timeoutMs, launchTimeoutMs) };
  const resource = browserType === chromium
    ? ownedChromium(launchOptions, launchTimeoutMs, cleanupTimeoutMs)
    : injectedBrowser(browserType, launchOptions);
  let result;
  let failure;
  let stopped = false;
  try {
    result = await within(async () => {
      const browser = await within(() => resource.launch(), launchTimeoutMs, 'launch');
      if (stopped) throw timeoutError('task', timeoutMs);
      return await task(browser);
    }, timeoutMs, 'task');
  } catch (error) {
    failure = error;
    if (error.code === 'BROWSER_TASK_TIMEOUT') {
      report(error.stage, 'timeout');
    }
  }
  stopped = true;
  try {
    await within(() => resource.close(), cleanupTimeoutMs, 'cleanup');
  } catch {
    report('cleanup', 'force-kill');
    try {
      await within(() => resource.kill(), cleanupTimeoutMs, 'reap');
    } catch (error) {
      resource.abandon();
      failure = failure
        ? new AggregateError([failure, error], `${failure.message}; browser cleanup failed`)
        : error;
    }
  } finally {
    resource.disconnect();
  }
  if (failure) throw failure;
  return result;
}
