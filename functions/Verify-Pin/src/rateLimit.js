// Pure decision logic for throttling repeated failed PIN attempts, keyed by caller IP. Kept free
// of any I/O so it can be unit tested directly -- main.js is responsible for loading/saving the
// returned state document against the shared `rate_limits` collection. Ported from
// quick-access-login/_shared/rateLimit.js (same collection, same shape), adapted to ESM since
// this function (unlike quick-access-login) already talks to Appwrite via the node-appwrite SDK
// instead of raw HTTP.

// Per-caller budget: the session (x-appwrite-user-id) a client creates before verifying, falling
// back to the caller IP when there is no session. Deliberately small -- this is the bucket a
// mistyped PIN lands in.
const MAX_ATTEMPTS = 5;
// Per-IP backstop, checked in addition to the per-caller bucket. An attacker can mint a fresh
// anonymous session (and therefore a fresh per-caller bucket) at will, so the IP bucket is the
// only ceiling they cannot walk away from. It has to be much higher than MAX_ATTEMPTS because a
// whole venue -- every till, the kiosk and staff phones -- egresses from one public IP and shares
// this bucket; five staff typos must not lock out the building (see P1-14).
const IP_MAX_ATTEMPTS = 30;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

// The `rate_limits` collection has exactly these three attributes, and Appwrite's structure
// validator rejects a document payload carrying anything else with a 400. `recordFailedAttempt`
// returns a fourth, `justLocked`, purely as a control flag for the caller -- it must never reach
// a createDocument/updateDocument payload. Route every write through `toPersistedState` rather
// than passing a computed state object straight through.
const PERSISTED_KEYS = ['attempts', 'windowStart', 'lockedUntil'];

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
 * one has expired, otherwise increments -- locking out once `maxAttempts` is reached within
 * WINDOW_MS.
 * @param {object|null} state
 * @param {number} now
 * @param {number} [maxAttempts] - lockout threshold for this bucket (MAX_ATTEMPTS for the
 *   per-caller bucket, IP_MAX_ATTEMPTS for the shared-egress backstop).
 * @returns {{attempts: number, windowStart: string, lockedUntil: string|null, justLocked: boolean}}
 *   `justLocked` is a control flag for the caller only -- see PERSISTED_KEYS.
 */
export function recordFailedAttempt(state, now, maxAttempts = MAX_ATTEMPTS) {
	const windowStartMs = state && state.windowStart ? Date.parse(state.windowStart) : NaN;
	const withinWindow = !isNaN(windowStartMs) && now - windowStartMs <= WINDOW_MS;

	const attempts = withinWindow ? (state.attempts || 0) + 1 : 1;
	const windowStart = withinWindow ? state.windowStart : new Date(now).toISOString();
	const justLocked = attempts >= maxAttempts;

	return {
		attempts,
		windowStart,
		lockedUntil: justLocked ? new Date(now + LOCKOUT_MS).toISOString() : null,
		justLocked,
	};
}

/**
 * Narrows a computed state to exactly the attributes `rate_limits` actually has. Anything else
 * (notably `justLocked`) is dropped rather than 400ing the whole write.
 */
export function toPersistedState(state) {
	const persisted = {};
	for (const key of PERSISTED_KEYS) {
		persisted[key] = state[key] === undefined ? null : state[key];
	}
	return persisted;
}

/** State to persist after a successful match, clearing any accumulated failed attempts. */
export function resetState() {
	return { attempts: 0, windowStart: new Date().toISOString(), lockedUntil: null };
}

export { MAX_ATTEMPTS, IP_MAX_ATTEMPTS, WINDOW_MS, LOCKOUT_MS, PERSISTED_KEYS };
