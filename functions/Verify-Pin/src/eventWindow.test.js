const { computeEventWindow } = require("./eventWindow.js");

describe("computeEventWindow", () => {
	test("returns null when the event has no date", () => {
		expect(computeEventWindow({ barOpenTime: "2200", barCloseTime: "02:00" })).toBeNull();
	});

	test("returns null when date is unparseable", () => {
		expect(computeEventWindow({ date: "not-a-date" })).toBeNull();
	});

	test("falls back to just the start instant when no bar hours are set", () => {
		const window = computeEventWindow({ date: "2026-06-05T01:00:00.000Z" });
		expect(window.startMs).toBe(new Date("2026-06-05T01:00:00.000Z").getTime());
		expect(window.endMs).toBe(window.startMs);
	});

	test("extends the window across midnight (open 22:00, close 02:00 -> 4 hour shift)", () => {
		const window = computeEventWindow({ date: "2026-09-27T03:00:00.000Z", barOpenTime: "2200", barCloseTime: "02:00" });
		expect(window.endMs - window.startMs).toBe(4 * 60 * 60 * 1000);
	});

	test("handles a same-day close time with no midnight crossing (open 14:00, close 22:00 -> 8 hours)", () => {
		const window = computeEventWindow({ date: "2026-06-05T19:00:00.000Z", barOpenTime: "1400", barCloseTime: "2200" });
		expect(window.endMs - window.startMs).toBe(8 * 60 * 60 * 1000);
	});

	test("accepts HH:mm formatted times as well as bare HHmm", () => {
		const withColons = computeEventWindow({ date: "2026-09-27T03:00:00.000Z", barOpenTime: "22:00", barCloseTime: "02:00" });
		const withoutColons = computeEventWindow({ date: "2026-09-27T03:00:00.000Z", barOpenTime: "2200", barCloseTime: "0200" });
		expect(withColons.endMs).toBe(withoutColons.endMs);
	});

	test("falls back to just the start instant when only one of barOpenTime/barCloseTime is set", () => {
		const window = computeEventWindow({ date: "2026-06-05T01:00:00.000Z", barOpenTime: "2200" });
		expect(window.endMs).toBe(window.startMs);
	});

	test("start is always exactly the event's date field, untouched", () => {
		const window = computeEventWindow({ date: "2026-03-15T13:37:00.000Z", barOpenTime: "1000", barCloseTime: "1800" });
		expect(window.startMs).toBe(new Date("2026-03-15T13:37:00.000Z").getTime());
	});
});
