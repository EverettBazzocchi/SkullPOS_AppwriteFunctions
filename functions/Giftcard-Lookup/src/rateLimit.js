// Pure decision logic for throttling repeated *misses* against the giftcard keyspace, keyed by
// caller IP. Kept free of any I/O so it can be unit tested directly -- main.js is responsible for
// loading/saving the returned state document against the shared `rate_limits` collection.
//
// Same collection and same shape Verify-Pin and quick-access-login already use for the identical
// problem (a short secret on an endpoint an anonymous session can reach). The numbers differ:
// every live giftcard UPC shares a fixed `75855` prefix, so the real search space is the five
// digits after it -- 100,000 candidates, walkable in under three hours at 10 req/s. A till scans
// codes that exist; a walker scans codes that don't, so the counter only advances on a miss.
// MAX_ATTEMPTS is higher than Verify-Pin's 5 because a mistyped/misread barcode at the bar is a
// normal, recoverable event rather than a signal on its own.

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * @param {{attempts?: number, windowStart?: string, lockedUntil?: string}|null} state - persisted
 *   counter document, or null/undefined if this key has no prior misses on record.
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
 * Computes the next counter state after a lookup that matched no card. Resets the window if the
 * previous one has expired, otherwise increments -- locking out once MAX_ATTEMPTS is reached
 * within WINDOW_MS.
 * @returns {{attempts: number, windowStart: string, lockedUntil: string|null, justLocked: boolean}}
 */
export function recordMiss(state, now) {
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

/** State to persist after a card is found, clearing any accumulated misses. */
export function resetState(now = Date.now()) {
	return { attempts: 0, windowStart: new Date(now).toISOString(), lockedUntil: null };
}

// `rate_limits` has exactly three attributes (attempts, windowStart, lockedUntil) -- `justLocked`
// is a return-value-only flag for the caller and would be rejected as an unknown attribute if it
// reached createDocument/updateDocument.
export function toPersistable(state) {
	return { attempts: state.attempts, windowStart: state.windowStart, lockedUntil: state.lockedUntil };
}

export { MAX_ATTEMPTS, WINDOW_MS, LOCKOUT_MS };
