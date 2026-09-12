const { checkLockout, recordFailedAttempt, resetState, MAX_ATTEMPTS, WINDOW_MS, LOCKOUT_MS } = require("./rateLimit.js");

describe("Verify-Pin rateLimit", () => {
	describe("checkLockout", () => {
		test("null state is never locked", () => {
			expect(checkLockout(null, Date.now())).toEqual({ locked: false });
		});

		test("a state with no lockedUntil is never locked", () => {
			expect(checkLockout({ attempts: 2, windowStart: new Date().toISOString() }, Date.now())).toEqual({ locked: false });
		});

		test("locked while now is before lockedUntil", () => {
			const now = Date.now();
			const state = { lockedUntil: new Date(now + 60000).toISOString() };

			const result = checkLockout(state, now);

			expect(result.locked).toBe(true);
			expect(result.retryAfterMs).toBeGreaterThan(0);
		});

		test("no longer locked once lockedUntil has passed", () => {
			const now = Date.now();
			const state = { lockedUntil: new Date(now - 1000).toISOString() };

			expect(checkLockout(state, now)).toEqual({ locked: false });
		});
	});

	describe("recordFailedAttempt", () => {
		test("first failure starts a fresh window with attempts:1", () => {
			const now = Date.now();
			const result = recordFailedAttempt(null, now);

			expect(result.attempts).toBe(1);
			expect(result.justLocked).toBe(false);
			expect(result.lockedUntil).toBeNull();
		});

		test("increments attempts within the same window", () => {
			const now = Date.now();
			const state = { attempts: 2, windowStart: new Date(now - 1000).toISOString() };

			const result = recordFailedAttempt(state, now);

			expect(result.attempts).toBe(3);
		});

		test(`locks out once attempts reaches MAX_ATTEMPTS (${MAX_ATTEMPTS})`, () => {
			const now = Date.now();
			const state = { attempts: MAX_ATTEMPTS - 1, windowStart: new Date(now - 1000).toISOString() };

			const result = recordFailedAttempt(state, now);

			expect(result.attempts).toBe(MAX_ATTEMPTS);
			expect(result.justLocked).toBe(true);
			expect(Date.parse(result.lockedUntil)).toBeCloseTo(now + LOCKOUT_MS, -2);
		});

		test("resets the window (attempts:1) once the previous window has expired", () => {
			const now = Date.now();
			const state = { attempts: MAX_ATTEMPTS, windowStart: new Date(now - WINDOW_MS - 1000).toISOString() };

			const result = recordFailedAttempt(state, now);

			expect(result.attempts).toBe(1);
			expect(result.justLocked).toBe(false);
		});
	});

	describe("resetState", () => {
		test("clears attempts and any lockout", () => {
			const result = resetState();

			expect(result.attempts).toBe(0);
			expect(result.lockedUntil).toBeNull();
		});
	});
});
