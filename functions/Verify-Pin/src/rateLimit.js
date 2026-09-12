// Pure decision logic for throttling repeated failed PIN attempts, keyed by caller IP. Kept free
// of any I/O so it can be unit tested directly -- main.js is responsible for loading/saving the
// returned state document against the shared `rate_limits` collection. Ported from
// quick-access-login/_shared/rateLimit.js (same collection, same shape), adapted to ESM since
// this function (unlike quick-access-login) already talks to Appwrite via the node-appwrite SDK
// instead of raw HTTP.

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * @param {{attempts?: number, windowStart?: string, lockedUntil?: string}|null} state - persisted
 *   counter document, or null/undefined if this key has no prior attempts on record.
 * @param {number} now - Date.now()
 * @returns {{locked: boolean, retryAfterMs?: number}}
 */
export function checkLockout(state, now) {
	if (state && state.lockedUntil) {
		const lockedUntilMs = Date.parse(state.lockedUntil);
		if (!isNaN(lockedUntilMs) && now < lockedUntilMs) {
			return { locked: true, retryAfterMs: lockedUntilMs - now };
		}
	}
	return { locked: false };
}

/**
 * Computes the next counter state after a failed PIN attempt. Resets the window if the previous
 * one has expired, otherwise increments -- locking out once MAX_ATTEMPTS is reached within
 * WINDOW_MS.
 * @returns {{attempts: number, windowStart: string, lockedUntil: string|null, justLocked: boolean}}
 */
export function recordFailedAttempt(state, now) {
	const windowStartMs = state && state.windowStart ? Date.parse(state.windowStart) : NaN;
	const withinWindow = !isNaN(windowStartMs) && now - windowStartMs <= WINDOW_MS;

	const attempts = withinWindow ? (state.attempts || 0) + 1 : 1;
	const windowStart = withinWindow ? state.windowStart : new Date(now).toISOString();
	const justLocked = attempts >= MAX_ATTEMPTS;

	return {
		attempts,
		windowStart,
		lockedUntil: justLocked ? new Date(now + LOCKOUT_MS).toISOString() : null,
		justLocked,
	};
}

/** State to persist after a successful match, clearing any accumulated failed attempts. */
export function resetState() {
	return { attempts: 0, windowStart: new Date().toISOString(), lockedUntil: null };
}

export { MAX_ATTEMPTS, WINDOW_MS, LOCKOUT_MS };
