// This module and Verify-Pin/src/rateLimit.js are two copies of the same decision logic writing
// to the same `rate_limits` collection (one CJS, one ESM, because the two functions talk to
// Appwrite by different means). Drift between them is how one endpoint ends up protected and the
// other not, so the parity block below is deliberate.

const cjs = require('./rateLimit.js');
const esm = require('../../Verify-Pin/src/rateLimit.js');

describe('quick-access-login rateLimit', () => {
	// P0-4a: `justLocked` is a control flag for the caller, not one of the collection's three
	// attributes. It used to be passed straight through as a document payload, Appwrite 400'd
	// every write, and the limiter persisted nothing for its entire life.
	describe('toPersistedState', () => {
		test('drops justLocked', () => {
			const now = Date.now();
			const next = cjs.recordFailedAttempt({ attempts: cjs.MAX_ATTEMPTS - 1, windowStart: new Date(now).toISOString() }, now);

			expect(next.justLocked).toBe(true);
			expect(cjs.toPersistedState(next)).not.toHaveProperty('justLocked');
		});

		test("emits exactly the collection's three attributes, for any input", () => {
			expect(cjs.PERSISTED_KEYS).toEqual(['attempts', 'windowStart', 'lockedUntil']);
			expect(Object.keys(cjs.toPersistedState({ attempts: 1, nonsense: true, $id: 'x' })).sort()).toEqual([
				'attempts',
				'lockedUntil',
				'windowStart',
			]);
		});

		test('preserves the values that matter', () => {
			const now = Date.now();
			const next = cjs.recordFailedAttempt({ attempts: 1, windowStart: new Date(now - 1000).toISOString() }, now);

			expect(cjs.toPersistedState(next).attempts).toBe(2);
			expect(cjs.toPersistedState(next).windowStart).toBe(next.windowStart);
		});
	});

	describe('parity with Verify-Pin/src/rateLimit.js', () => {
		test('the thresholds and window match', () => {
			expect(cjs.MAX_ATTEMPTS).toBe(esm.MAX_ATTEMPTS);
			expect(cjs.IP_MAX_ATTEMPTS).toBe(esm.IP_MAX_ATTEMPTS);
			expect(cjs.WINDOW_MS).toBe(esm.WINDOW_MS);
			expect(cjs.LOCKOUT_MS).toBe(esm.LOCKOUT_MS);
			expect(cjs.PERSISTED_KEYS).toEqual(esm.PERSISTED_KEYS);
		});

		test('the shared-IP backstop sits well above the per-caller budget in both copies', () => {
			expect(cjs.IP_MAX_ATTEMPTS).toBeGreaterThan(cjs.MAX_ATTEMPTS);
			expect(esm.IP_MAX_ATTEMPTS).toBeGreaterThan(esm.MAX_ATTEMPTS);
		});

		test('both compute the same next state, at both ceilings', () => {
			const now = 1_700_000_000_000;
			const state = { attempts: 4, windowStart: new Date(now - 1000).toISOString() };

			expect(cjs.recordFailedAttempt(state, now)).toEqual(esm.recordFailedAttempt(state, now));
			expect(cjs.recordFailedAttempt(state, now, cjs.IP_MAX_ATTEMPTS)).toEqual(
				esm.recordFailedAttempt(state, now, esm.IP_MAX_ATTEMPTS),
			);
			expect(cjs.toPersistedState(cjs.recordFailedAttempt(state, now))).toEqual(
				esm.toPersistedState(esm.recordFailedAttempt(state, now)),
			);
		});

		test('both agree on an active lockout', () => {
			const now = Date.now();
			const locked = { lockedUntil: new Date(now + 60000).toISOString() };
			const expired = { lockedUntil: new Date(now - 1000).toISOString() };

			expect(cjs.checkLockout(locked, now)).toEqual(esm.checkLockout(locked, now));
			expect(cjs.checkLockout(expired, now)).toEqual(esm.checkLockout(expired, now));
		});
	});
});
