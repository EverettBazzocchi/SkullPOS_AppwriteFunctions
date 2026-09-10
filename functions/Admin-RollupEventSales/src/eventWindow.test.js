const { eventSalesWindow } = require("./eventWindow.js");

describe("eventSalesWindow", () => {
	test("returns null when the event has no date", () => {
		expect(eventSalesWindow({ event_start: 7, event_end: 4 })).toBeNull();
	});

	test("returns null when date is unparseable", () => {
		expect(eventSalesWindow({ date: "not-a-date", event_start: 7, event_end: 4 })).toBeNull();
	});

	test("defaults to a 7pm-4am (9 hour) window when event_start/event_end aren't set", () => {
		const { start, end } = eventSalesWindow({ date: "2026-06-05T01:00:00.000Z" });
		expect(start.toISOString()).toBe("2026-06-05T01:00:00.000Z");
		expect(end.getTime() - start.getTime()).toBe(9 * 60 * 60 * 1000);
	});

	test("treats a small event_start hour as PM and event_end as-is (AM)", () => {
		// event_start: 8 (8pm) -> event_end: 3 (3am) is a 7 hour window
		const { start, end } = eventSalesWindow({ date: "2026-01-01T00:00:00.000Z", event_start: 8, event_end: 3 });
		expect(end.getTime() - start.getTime()).toBe(7 * 60 * 60 * 1000);
	});

	test("does not adjust an event_start hour that's already 12 or greater", () => {
		// event_start: 14 (2pm) -> event_end: 22 (10pm) is an 8 hour window, no PM/AM crossing
		const { start, end } = eventSalesWindow({ date: "2026-01-01T00:00:00.000Z", event_start: 14, event_end: 22 });
		expect(end.getTime() - start.getTime()).toBe(8 * 60 * 60 * 1000);
	});

	test("start is always exactly the event's date field, untouched", () => {
		const { start } = eventSalesWindow({ date: "2026-03-15T13:37:00.000Z", event_start: 7, event_end: 4 });
		expect(start.toISOString()).toBe("2026-03-15T13:37:00.000Z");
	});
});
