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

	// --- the migrated shape: real timestamps -------------------------------------------------
	//
	// The same 22:00-02:00 night in Winnipeg (CDT, UTC-5) written three ways: legacy only, new
	// only, and a row carrying both mid-migration.
	describe("startsAt/endsAt/barOpensAt/barClosesAt", () => {
		const LEGACY_ONLY = { date: "2026-09-28T03:00:00.000Z", barOpenTime: "22:00", barCloseTime: "02:00" };
		const NEW_ONLY = {
			startsAt: "2026-09-28T03:00:00.000Z",
			endsAt: "2026-09-28T07:00:00.000Z",
			barOpensAt: "2026-09-28T03:00:00.000Z",
			barClosesAt: "2026-09-28T07:00:00.000Z",
		};

		// Whichever shape a row is in while the rollout is half-done, the transactions folded into
		// that event's revenue, tips and COGS are exactly the same set.
		test("a row with only the old fields, only the new, and both produce the identical window", () => {
			const legacy = eventSalesWindow(LEGACY_ONLY);
			const migrated = eventSalesWindow(NEW_ONLY);
			const both = eventSalesWindow({ ...LEGACY_ONLY, ...NEW_ONLY });

			expect(migrated).toEqual(legacy);
			expect(both).toEqual(legacy);
			expect(legacy.start.toISOString()).toBe("2026-09-28T03:00:00.000Z");
			expect(legacy.end.toISOString()).toBe("2026-09-28T07:00:00.000Z");
		});

		test("the timestamps win over date + bar hours, which can disagree with them", () => {
			const window = eventSalesWindow({
				date: "2026-09-28T05:00:00.000Z", // junk time -- two hours after the real start
				barOpenTime: "22:00",
				barCloseTime: "02:00",
				startsAt: "2026-09-28T03:00:00.000Z",
				endsAt: "2026-09-28T07:00:00.000Z",
			});

			expect(window.start.toISOString()).toBe("2026-09-28T03:00:00.000Z");
			expect(hours(window)).toBe(4);
		});

		// A door sale before the bar opens and a last-call ring-up after the event's own end both
		// belong to this event -- the window is the union, not either pair alone.
		test("spans the union of the event's own window and the bar's", () => {
			const window = eventSalesWindow({
				startsAt: "2026-09-28T01:00:00.000Z",
				endsAt: "2026-09-28T06:00:00.000Z",
				barOpensAt: "2026-09-28T03:00:00.000Z",
				barClosesAt: "2026-09-28T07:00:00.000Z",
			});

			expect(window.start.toISOString()).toBe("2026-09-28T01:00:00.000Z");
			expect(window.end.toISOString()).toBe("2026-09-28T07:00:00.000Z");
		});

		// The whole point of the timestamps: no more "is a small hour PM?".
		test("never applies the small-hour PM guess to a row that carries the new fields", () => {
			// event_start 8 would be read as 8 PM by the legacy path, giving a 7-hour window.
			const window = eventSalesWindow({
				date: "2026-01-01T00:00:00.000Z",
				event_start: 8,
				event_end: 3,
				startsAt: "2026-01-01T02:00:00.000Z",
				endsAt: "2026-01-01T05:00:00.000Z",
			});

			expect(hours(window)).toBe(3);
			expect(window.start.toISOString()).toBe("2026-01-01T02:00:00.000Z");
		});

		// ...but it must stay exactly as it was for a row that carries nothing else.
		test("still applies the small-hour PM guess to a row with no new fields and no bar hours", () => {
			expect(hours(eventSalesWindow({ date: "2026-01-01T00:00:00.000Z", event_start: 8, event_end: 3 }))).toBe(7);
		});

		test("anchors on startsAt and derives the end the legacy way when only the start was backfilled", () => {
			const window = eventSalesWindow({
				date: "2026-09-28T05:00:00.000Z",
				startsAt: "2026-09-28T03:00:00.000Z",
				barOpenTime: "22:00",
				barCloseTime: "02:00",
			});

			expect(window.start.toISOString()).toBe("2026-09-28T03:00:00.000Z");
			expect(hours(window)).toBe(4);
		});

		test("anchors on the legacy date and honours endsAt when only the end was backfilled", () => {
			const window = eventSalesWindow({ ...LEGACY_ONLY, endsAt: "2026-09-28T08:00:00.000Z" });
			expect(window.start.toISOString()).toBe("2026-09-28T03:00:00.000Z");
			expect(hours(window)).toBe(5);
		});

		test("ignores a blank or unparseable timestamp and falls back instead of producing an invalid window", () => {
			const window = eventSalesWindow({ ...LEGACY_ONLY, startsAt: "", endsAt: "sometime" });
			expect(window).toEqual(eventSalesWindow(LEGACY_ONLY));
		});

		test("works with no legacy date at all, once a row has been fully migrated", () => {
			expect(hours(eventSalesWindow(NEW_ONLY))).toBe(4);
		});

		// Skipped and reported by main.js -- never rolled up, because a window that matches nothing
		// would overwrite the event's already-correct figures with zeroes.
		test("returns null for an inverted pair rather than a backwards window", () => {
			expect(eventSalesWindow({ startsAt: "2026-09-28T07:00:00.000Z", endsAt: "2026-09-28T03:00:00.000Z" })).toBeNull();
		});

		test("returns null for a zero-length new-field window", () => {
			expect(eventSalesWindow({ startsAt: "2026-09-28T03:00:00.000Z", endsAt: "2026-09-28T03:00:00.000Z" })).toBeNull();
		});
	});
});
