const {
	checkLockout,
	recordFailedAttempt,
	resetState,
	toPersistedState,
	MAX_ATTEMPTS,
	IP_MAX_ATTEMPTS,
	WINDOW_MS,
	LOCKOUT_MS,
	PERSISTED_KEYS,
} = require("./rateLimit.js");

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

	describe("recordFailedAttempt with a custom ceiling", () => {
		test(`the shared-IP backstop does not lock at MAX_ATTEMPTS (${MAX_ATTEMPTS})`, () => {
			const now = Date.now();
			const state = { attempts: MAX_ATTEMPTS - 1, windowStart: new Date(now - 1000).toISOString() };

			const result = recordFailedAttempt(state, now, IP_MAX_ATTEMPTS);

			expect(result.attempts).toBe(MAX_ATTEMPTS);
			expect(result.justLocked).toBe(false);
			expect(result.lockedUntil).toBeNull();
		});

		test(`it locks at its own ceiling (${IP_MAX_ATTEMPTS})`, () => {
			const now = Date.now();
			const state = { attempts: IP_MAX_ATTEMPTS - 1, windowStart: new Date(now - 1000).toISOString() };

			const result = recordFailedAttempt(state, now, IP_MAX_ATTEMPTS);

			expect(result.justLocked).toBe(true);
		});

		// P1-14: every till, the kiosk and staff phones egress from one public IP and share the IP
		// bucket, so a device burning its own per-caller allowance must leave the building able to
		// log in. Driven through the real state machine rather than compared as constants.
		test("one device exhausting its own allowance does not lock the shared IP bucket", () => {
			const now = Date.now();
			let ipState = null;

			for (let i = 0; i < MAX_ATTEMPTS; i++) {
				ipState = recordFailedAttempt(ipState, now, IP_MAX_ATTEMPTS);
			}

			expect(ipState.attempts).toBe(MAX_ATTEMPTS);
			expect(ipState.justLocked).toBe(false);
			expect(checkLockout(ipState, now)).toEqual({ locked: false });
		});
	});

	// The live `rate_limits` collection has exactly three attributes. `justLocked` is a control
	// flag for the caller and must never reach a document payload -- it did, and Appwrite 400'd
	// every write for the limiter's entire life (P0-4a).
	describe("toPersistedState", () => {
		test("drops justLocked", () => {
			const now = Date.now();
			const next = recordFailedAttempt({ attempts: MAX_ATTEMPTS - 1, windowStart: new Date(now).toISOString() }, now);

			expect(next.justLocked).toBe(true);
			expect(toPersistedState(next)).not.toHaveProperty("justLocked");
		});

		test("emits exactly the collection's three attributes, for any input", () => {
			expect(PERSISTED_KEYS).toEqual(["attempts", "windowStart", "lockedUntil"]);
			expect(Object.keys(toPersistedState(recordFailedAttempt(null, Date.now()))).sort()).toEqual([
				"attempts",
				"lockedUntil",
				"windowStart",
			]);
			expect(Object.keys(toPersistedState({ attempts: 1, nonsense: true, $id: "x" })).sort()).toEqual([
				"attempts",
				"lockedUntil",
				"windowStart",
			]);
		});

		test("preserves the values that matter", () => {
			const now = Date.now();
			const next = recordFailedAttempt({ attempts: 1, windowStart: new Date(now - 1000).toISOString() }, now);

			expect(toPersistedState(next).attempts).toBe(2);
			expect(toPersistedState(next).windowStart).toBe(next.windowStart);
		});
	});

	describe("resetState", () => {
		test("clears attempts and any lockout", () => {
			const result = resetState();

			expect(result.attempts).toBe(0);
			expect(result.lockedUntil).toBeNull();
		});

		test("is already schema-shaped", () => {
			expect(Object.keys(resetState()).sort()).toEqual(["attempts", "lockedUntil", "windowStart"]);
		});
	});
});
