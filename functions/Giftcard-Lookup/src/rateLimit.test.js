const { checkLockout, recordMiss, resetState, toPersistable, MAX_ATTEMPTS, WINDOW_MS, LOCKOUT_MS } = require("./rateLimit.js");

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

describe("Giftcard-Lookup rateLimit", () => {
	describe("checkLockout", () => {
		test("no prior state is not locked", () => {
			expect(checkLockout(null, NOW)).toEqual({ locked: false });
		});

		test("a future lockedUntil is locked, with the remaining time", () => {
			const state = { lockedUntil: new Date(NOW + 5 * 60 * 1000).toISOString() };
			expect(checkLockout(state, NOW)).toEqual({ locked: true, retryAfterMs: 5 * 60 * 1000 });
		});

		test("a past lockedUntil is not locked", () => {
			const state = { lockedUntil: new Date(NOW - 1).toISOString() };
			expect(checkLockout(state, NOW)).toEqual({ locked: false });
		});

		test("an unparseable lockedUntil never wedges a till shut", () => {
			expect(checkLockout({ lockedUntil: "not a date" }, NOW)).toEqual({ locked: false });
		});
	});

	describe("recordMiss", () => {
		test("the first miss opens a window at 1 attempt", () => {
			const next = recordMiss(null, NOW);
			expect(next.attempts).toBe(1);
			expect(next.justLocked).toBe(false);
			expect(next.windowStart).toBe(new Date(NOW).toISOString());
		});

		test("misses inside the window accumulate against the same windowStart", () => {
			const windowStart = new Date(NOW - 60 * 1000).toISOString();
			const next = recordMiss({ attempts: 4, windowStart }, NOW);
			expect(next.attempts).toBe(5);
			expect(next.windowStart).toBe(windowStart);
		});

		test("a miss after the window expires starts a fresh window", () => {
			const windowStart = new Date(NOW - WINDOW_MS - 1).toISOString();
			const next = recordMiss({ attempts: 9, windowStart }, NOW);
			expect(next.attempts).toBe(1);
			expect(next.windowStart).toBe(new Date(NOW).toISOString());
			expect(next.justLocked).toBe(false);
		});

		test(`the ${MAX_ATTEMPTS}th miss in one window locks out for the full lockout period`, () => {
			const windowStart = new Date(NOW - 60 * 1000).toISOString();
			const next = recordMiss({ attempts: MAX_ATTEMPTS - 1, windowStart }, NOW);
			expect(next.attempts).toBe(MAX_ATTEMPTS);
			expect(next.justLocked).toBe(true);
			expect(Date.parse(next.lockedUntil)).toBe(NOW + LOCKOUT_MS);
		});

		test("a walk of the whole keyspace stalls at the cap rather than continuing", () => {
			let state = null;
			let locked = 0;
			for (let i = 0; i < 50; i++) {
				if (checkLockout(state, NOW).locked) {
					locked++;
					continue;
				}
				state = recordMiss(state, NOW);
			}
			// Only MAX_ATTEMPTS of the 50 probes ever reached the collection.
			expect(50 - locked).toBe(MAX_ATTEMPTS);
		});
	});

	test("resetState clears the counter", () => {
		expect(resetState(NOW)).toEqual({ attempts: 0, windowStart: new Date(NOW).toISOString(), lockedUntil: null });
	});

	test("toPersistable drops justLocked, which rate_limits has no attribute for", () => {
		const next = recordMiss({ attempts: MAX_ATTEMPTS - 1, windowStart: new Date(NOW).toISOString() }, NOW);
		expect(next).toHaveProperty("justLocked");
		expect(Object.keys(toPersistable(next)).sort()).toEqual(["attempts", "lockedUntil", "windowStart"]);
	});
});
