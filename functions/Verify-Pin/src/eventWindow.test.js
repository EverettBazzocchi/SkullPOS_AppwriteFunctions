const { computeEventWindow } = require("./eventWindow.js");

// The `barOpenTime`/`barCloseTime` duration tests that used to live here are gone with the
// attributes themselves: there is no longer any legacy route from a start to an END, so pinning one
// would pin behaviour the module deliberately no longer has. What replaces them is the decision
// that took their place -- a start with no end is a start-only window, never a null -- which is
// pinned explicitly below rather than left as an emergent property.

describe("computeEventWindow", () => {
	test("returns null when the event has no start of any kind", () => {
		expect(computeEventWindow({})).toBeNull();
	});

	test("returns null when date is unparseable", () => {
		expect(computeEventWindow({ date: "not-a-date" })).toBeNull();
	});

	test("collapses to just the start instant when the row carries no end", () => {
		const window = computeEventWindow({ date: "2026-06-05T01:00:00.000Z" });
		expect(window.startMs).toBe(new Date("2026-06-05T01:00:00.000Z").getTime());
		expect(window.endMs).toBe(window.startMs);
	});

	test("start is always exactly the event's date field, untouched", () => {
		const window = computeEventWindow({ date: "2026-03-15T13:37:00.000Z", barClosesAt: "2026-03-15T21:37:00.000Z" });
		expect(window.startMs).toBe(new Date("2026-03-15T13:37:00.000Z").getTime());
	});

	// --- the migrated shape: real timestamps -------------------------------------------------
	//
	// A 22:00-02:00 bar night in Winnipeg (CDT, UTC-5): barOpensAt 2026-09-28T03:00Z, barClosesAt
	// 2026-09-28T07:00Z. `date` is the one legacy field still read, and only ever as a start anchor.
	const DATE_ONLY = { date: "2026-09-28T03:00:00.000Z" };
	const NEW_ONLY = {
		startsAt: "2026-09-28T03:00:00.000Z",
		endsAt: "2026-09-28T07:00:00.000Z",
		barOpensAt: "2026-09-28T03:00:00.000Z",
		barClosesAt: "2026-09-28T07:00:00.000Z",
	};

	describe("startsAt/endsAt/barOpensAt/barClosesAt", () => {
		// The equivalence this replaces ("old fields, new fields and both produce the identical
		// window") could only ever hold while barOpenTime/barCloseTime supplied a duration. What
		// still has to hold, and is what any deploy order actually depends on now, is that a
		// leftover `date` never perturbs a row that carries the instants.
		test("a leftover legacy date changes nothing about a row that carries the instants", () => {
			const migrated = computeEventWindow(NEW_ONLY);
			const both = computeEventWindow({ ...DATE_ONLY, ...NEW_ONLY });

			expect(both).toEqual(migrated);
			expect(migrated.startMs).toBe(Date.parse("2026-09-28T03:00:00.000Z"));
			expect(migrated.endMs).toBe(Date.parse("2026-09-28T07:00:00.000Z"));
		});

		// THE bug this migration exists to kill. `date` stores 20:00 for an event whose bar opens at
		// 18:00 -- its time half is junk -- so anchoring on it starts the pin's window two hours
		// late and rejects the bartender for the first two hours of her own shift.
		test("barOpensAt wins over date's junk time, so a bartender is not locked out of her first hours", () => {
			const row = {
				date: "2026-06-06T01:00:00.000Z", // 20:00 local -- meaningless time, correct day
				barOpensAt: "2026-06-05T23:00:00.000Z", // 18:00 local -- the real bar open
				barClosesAt: "2026-06-06T07:00:00.000Z", // 02:00 local
			};

			const window = computeEventWindow(row);

			expect(window.startMs).toBe(Date.parse("2026-06-05T23:00:00.000Z"));
			expect(window.endMs).toBe(Date.parse("2026-06-06T07:00:00.000Z"));
			// The same row anchored on `date` alone starts two hours later -- that gap is the lockout.
			const legacy = computeEventWindow({ date: row.date });
			expect(legacy.startMs - window.startMs).toBe(2 * 60 * 60 * 1000);
		});

		test("spans the union of the bar's hours and the event's own, so an early call time still works", () => {
			const window = computeEventWindow({
				startsAt: "2026-09-28T01:00:00.000Z", // doors two hours before the bar opens
				endsAt: "2026-09-28T06:00:00.000Z",
				barOpensAt: "2026-09-28T03:00:00.000Z",
				barClosesAt: "2026-09-28T07:00:00.000Z", // bar runs an hour past the event's end
			});

			expect(window.startMs).toBe(Date.parse("2026-09-28T01:00:00.000Z"));
			expect(window.endMs).toBe(Date.parse("2026-09-28T07:00:00.000Z"));
		});

		test("uses startsAt/endsAt when the bar instants are absent", () => {
			const window = computeEventWindow({ startsAt: "2026-09-28T03:00:00.000Z", endsAt: "2026-09-28T07:00:00.000Z" });
			expect(window.startMs).toBe(Date.parse("2026-09-28T03:00:00.000Z"));
			expect(window.endMs).toBe(Date.parse("2026-09-28T07:00:00.000Z"));
		});

		// THE deliberate choice, pinned so it cannot be "tidied" into a null later. A save that
		// composes barOpensAt from a bar open time whose close time is unparseable ("late") produces
		// exactly this row. The pin is then live only inside Verify-Pin's own ±1h buffer -- narrow,
		// but a bartender with a narrow window can still open her till, and one with no window
		// cannot, and gets a response byte-identical to a wrong pin telling her nothing.
		test("anchors on barOpensAt and gives a start-only window, never null, when no end instant exists", () => {
			const window = computeEventWindow({
				date: "2026-09-28T05:00:00.000Z",
				barOpensAt: "2026-09-28T03:00:00.000Z",
			});

			expect(window).not.toBeNull();
			expect(window.startMs).toBe(Date.parse("2026-09-28T03:00:00.000Z"));
			expect(window.endMs).toBe(window.startMs);
		});

		test("anchors on the legacy date and still honours barClosesAt when only the end was backfilled", () => {
			const window = computeEventWindow({
				date: "2026-09-28T03:00:00.000Z",
				barClosesAt: "2026-09-28T08:00:00.000Z", // bar ran an hour late
			});

			expect(window.startMs).toBe(Date.parse("2026-09-28T03:00:00.000Z"));
			expect(window.endMs).toBe(Date.parse("2026-09-28T08:00:00.000Z"));
		});

		test("ignores a blank or unparseable timestamp and falls back rather than producing a NaN window", () => {
			const window = computeEventWindow({ ...DATE_ONLY, barOpensAt: "", barClosesAt: "whenever" });
			expect(window).toEqual(computeEventWindow(DATE_ONLY));
			expect(Number.isNaN(window.startMs)).toBe(false);
			expect(Number.isNaN(window.endMs)).toBe(false);
		});

		test("works with no legacy date at all, once a row has been fully migrated", () => {
			const window = computeEventWindow(NEW_ONLY);
			expect(window).not.toBeNull();
			expect(window.endMs - window.startMs).toBe(4 * 60 * 60 * 1000);
		});

		// An inverted pair must not silently invert the window: a negative span would leave the pin
		// valid only inside the caller's buffer, i.e. a mid-shift lockout with no error anywhere.
		test("clamps an end that precedes the start instead of producing a negative window", () => {
			const window = computeEventWindow({ startsAt: "2026-09-28T07:00:00.000Z", endsAt: "2026-09-28T03:00:00.000Z" });
			expect(window.endMs).toBe(window.startMs);
		});
	});
});
