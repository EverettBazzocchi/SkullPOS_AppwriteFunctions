const { eventSalesWindow } = require("./eventWindow.js");

const hours = (window) => (window.end.getTime() - window.start.getTime()) / (60 * 60 * 1000);

describe("eventSalesWindow", () => {
	test("returns null when the event has no date", () => {
		expect(eventSalesWindow({ barOpenTime: "19:00", barCloseTime: "04:00" })).toBeNull();
	});

	test("returns null when date is unparseable", () => {
		expect(eventSalesWindow({ date: "not-a-date", barOpenTime: "19:00", barCloseTime: "04:00" })).toBeNull();
	});

	test("start is always exactly the event's date field, untouched", () => {
		const { start } = eventSalesWindow({ date: "2026-03-15T13:37:00.000Z", barOpenTime: "19:00", barCloseTime: "04:00" });
		expect(start.toISOString()).toBe("2026-03-15T13:37:00.000Z");
	});

	describe("duration from the admin-editable bar hours", () => {
		test("derives the window from barOpenTime/barCloseTime", () => {
			const window = eventSalesWindow({ date: "2026-06-05T01:00:00.000Z", barOpenTime: "22:00", barCloseTime: "02:00" });
			expect(hours(window)).toBe(4);
		});

		test("bar hours win over event_start/event_end, which no screen can edit", () => {
			// Live shape: "The NB Afterparty" -- event_start 22 / event_end 4 (6h) but 22:00-02:00 (4h).
			const window = eventSalesWindow({
				date: "2026-06-05T01:00:00.000Z",
				barOpenTime: "22:00",
				barCloseTime: "02:00",
				event_start: 22,
				event_end: 4,
			});
			expect(hours(window)).toBe(4);
		});

		test("honours minutes, not just whole hours", () => {
			const window = eventSalesWindow({ date: "2026-06-05T01:00:00.000Z", barOpenTime: "21:30", barCloseTime: "02:00" });
			expect(hours(window)).toBe(4.5);
		});

		test("accepts the colon-less form Verify-Pin accepts, so the two agree on the same stored value", () => {
			const window = eventSalesWindow({ date: "2026-06-05T01:00:00.000Z", barOpenTime: "1800", barCloseTime: "0200" });
			expect(hours(window)).toBe(8);
		});

		test("returns null for a zero-length window rather than a window that matches nothing", () => {
			expect(eventSalesWindow({ date: "2026-06-05T01:00:00.000Z", barOpenTime: "20:00", barCloseTime: "20:00" })).toBeNull();
		});
	});

	describe("event_start/event_end fallback for rows with no bar hours", () => {
		test("defaults to a 7pm-4am (9 hour) window when nothing is set", () => {
			const window = eventSalesWindow({ date: "2026-06-05T01:00:00.000Z" });
			expect(window.start.toISOString()).toBe("2026-06-05T01:00:00.000Z");
			expect(hours(window)).toBe(9);
		});

		test("treats a small event_start hour as PM and event_end as-is (AM)", () => {
			const window = eventSalesWindow({ date: "2026-01-01T00:00:00.000Z", event_start: 8, event_end: 3 });
			expect(hours(window)).toBe(7);
		});

		test("does not adjust an event_start hour that's already 12 or greater", () => {
			const window = eventSalesWindow({ date: "2026-01-01T00:00:00.000Z", event_start: 14, event_end: 22 });
			expect(hours(window)).toBe(8);
		});

		test("falls back when the bar hours are set but unparseable", () => {
			const window = eventSalesWindow({ date: "2026-01-01T00:00:00.000Z", barOpenTime: "8pm", barCloseTime: "late", event_start: 14, event_end: 22 });
			expect(hours(window)).toBe(8);
		});

		test("returns null when event_start === event_end", () => {
			expect(eventSalesWindow({ date: "2026-01-01T00:00:00.000Z", event_start: 22, event_end: 22 })).toBeNull();
		});
	});
});
