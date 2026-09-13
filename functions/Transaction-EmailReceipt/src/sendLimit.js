// Pure decision logic for capping how much mail one caller can make this function send, keyed by
// the caller's Appwrite user id. Kept free of any I/O so it can be unit tested directly --
// main.js loads/saves the returned state against the shared `rate_limits` collection, the same one
// Verify-Pin and quick-access-login already use.
//
// This is an amplification guard, not an auth control: a receipt carries the full itemized sale
// and CCs the venue owner on every send, so a till that has been left unlocked (or a PIN that has
// leaked) must not be able to turn this endpoint into a mailer. A real bar sends a handful of
// receipts an hour, so the cap sits far above normal use and only bites on a loop.

const MAX_SENDS = 20;
const WINDOW_MS = 15 * 60 * 1000;

function windowState(state, now) {
	const windowStartMs = state && state.windowStart ? Date.parse(state.windowStart) : NaN;
	const withinWindow = !isNaN(windowStartMs) && now - windowStartMs <= WINDOW_MS;
	return { withinWindow, windowStartMs };
}

/**
 * @param {{attempts?: number, windowStart?: string}|null} state - persisted counter, or null if
 *   this caller has sent nothing recently.
 * @param {number} now - Date.now()
 * @returns {{exceeded: boolean, retryAfterMs?: number}}
 */
export function checkSendQuota(state, now) {
	const { withinWindow, windowStartMs } = windowState(state, now);
	if (withinWindow && (state.attempts || 0) >= MAX_SENDS) {
		return { exceeded: true, retryAfterMs: Math.max(1, windowStartMs + WINDOW_MS - now) };
	}
	return { exceeded: false };
}

/**
 * Counter state to persist after a receipt actually goes out. A send outside the previous window
 * opens a fresh one.
 * @returns {{attempts: number, windowStart: string, lockedUntil: null}}
 */
export function recordSend(state, now) {
	const { withinWindow } = windowState(state, now);
	return {
		attempts: withinWindow ? (state.attempts || 0) + 1 : 1,
		windowStart: withinWindow ? state.windowStart : new Date(now).toISOString(),
		// `rate_limits` carries a lockedUntil column for Verify-Pin's lockout model; this counter
		// is a rolling quota rather than a lockout, so it is always cleared.
		lockedUntil: null,
	};
}

export { MAX_SENDS, WINDOW_MS };
