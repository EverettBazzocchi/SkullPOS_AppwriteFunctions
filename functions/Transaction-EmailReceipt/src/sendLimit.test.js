const { checkSendQuota, recordSend, MAX_SENDS, WINDOW_MS } = require("./sendLimit.js");

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

describe("Transaction-EmailReceipt sendLimit", () => {
	test("a caller with no counter on record is under quota", () => {
		expect(checkSendQuota(null, NOW)).toEqual({ exceeded: false });
	});

	test("a caller below the cap is under quota", () => {
		const state = { attempts: MAX_SENDS - 1, windowStart: new Date(NOW - 60 * 1000).toISOString() };
		expect(checkSendQuota(state, NOW)).toEqual({ exceeded: false });
	});

	test("a caller at the cap inside the window is over quota, with the time left in it", () => {
		const windowStart = NOW - 5 * 60 * 1000;
		const state = { attempts: MAX_SENDS, windowStart: new Date(windowStart).toISOString() };
		expect(checkSendQuota(state, NOW)).toEqual({ exceeded: true, retryAfterMs: WINDOW_MS - 5 * 60 * 1000 });
	});

	test("a caller at the cap from an expired window is under quota again", () => {
		const state = { attempts: MAX_SENDS, windowStart: new Date(NOW - WINDOW_MS - 1).toISOString() };
		expect(checkSendQuota(state, NOW)).toEqual({ exceeded: false });
	});

	test("an unparseable windowStart never wedges receipts shut", () => {
		expect(checkSendQuota({ attempts: 999, windowStart: "not a date" }, NOW)).toEqual({ exceeded: false });
	});

	test("the first send opens a window at 1", () => {
		expect(recordSend(null, NOW)).toEqual({
			attempts: 1,
			windowStart: new Date(NOW).toISOString(),
			lockedUntil: null,
		});
	});

	test("sends inside the window accumulate against the same windowStart", () => {
		const windowStart = new Date(NOW - 60 * 1000).toISOString();
		expect(recordSend({ attempts: 7, windowStart }, NOW)).toEqual({ attempts: 8, windowStart, lockedUntil: null });
	});

	test("a send after the window expires starts a fresh one", () => {
		const state = { attempts: MAX_SENDS, windowStart: new Date(NOW - WINDOW_MS - 1).toISOString() };
		expect(recordSend(state, NOW)).toEqual({
			attempts: 1,
			windowStart: new Date(NOW).toISOString(),
			lockedUntil: null,
		});
	});

	test("a mail loop stalls at the cap rather than continuing", () => {
		let state = null;
		let sent = 0;
		for (let i = 0; i < 200; i++) {
			if (checkSendQuota(state, NOW).exceeded) continue;
			state = recordSend(state, NOW);
			sent++;
		}
		expect(sent).toBe(MAX_SENDS);
	});

	test("the persisted shape carries only attributes rate_limits actually has", () => {
		expect(Object.keys(recordSend(null, NOW)).sort()).toEqual(["attempts", "lockedUntil", "windowStart"]);
	});
});
