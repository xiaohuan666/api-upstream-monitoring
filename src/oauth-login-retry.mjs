import { setTimeout as delay } from 'node:timers/promises';
import { onboardingError } from './oauth-onboarding-store.mjs';

export const OAUTH_CHALLENGE_RETRY_DELAY_MS = 15_000;
const waitForRetry = (ms, signal) => delay(ms, undefined, { signal });

function assertActive(signal) {
  if (signal.aborted) throw onboardingError('TASK_INTERRUPTED', '任务已中断，可在入池任务中显式重跑', 409);
}

/**
 * Retry only a positively identified login challenge, never preparation, exchange or writes.
 * prepare creates a fresh authorization transaction after revalidating the original job.
 * The caller retains one lease, job identity and credential lifetime for both attempts.
 */
export async function loginWithChallengeRetry({ prepare, login, signal, onChallenge, onRetry, wait = waitForRetry }) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    assertActive(signal);
    const context = await prepare(attempt);
    assertActive(signal);
    try {
      const callback = await login(context.loginInput);
      assertActive(signal);
      return { ...context, callback, attempt };
    } catch (error) {
      assertActive(signal);
      if (error?.safe !== true || error.code !== 'OAUTH_HTTP_CHALLENGE') throw error;
      await onChallenge(error, attempt);
      if (attempt === 2) throw error;
      await onRetry();
      assertActive(signal);
      try { await wait(OAUTH_CHALLENGE_RETRY_DELAY_MS, signal); }
      catch (waitError) { assertActive(signal); throw waitError; }
    }
  }
}
