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

	// --- the migrated shape: real timestamps -------------------------------------------------
	//
	// The same shift, written three ways. A 22:00-02:00 bar night in Winnipeg (CDT, UTC-5):
	// barOpensAt 2026-09-28T03:00Z, barClosesAt 2026-09-28T07:00Z. The legacy row expresses it as
	// `date` (whose wall-clock half was ASSUMED to line up with barOpenTime) plus the HH:mm pair.
	const LEGACY_ONLY = { date: "2026-09-28T03:00:00.000Z", barOpenTime: "22:00", barCloseTime: "02:00" };
	const NEW_ONLY = {
		startsAt: "2026-09-28T03:00:00.000Z",
		endsAt: "2026-09-28T07:00:00.000Z",
		barOpensAt: "2026-09-28T03:00:00.000Z",
		barClosesAt: "2026-09-28T07:00:00.000Z",
	};

	describe("startsAt/endsAt/barOpensAt/barClosesAt", () => {
		// The migration's core promise: whichever shape a row is in mid-rollout, the bartender's pin
		// is valid for exactly the same instants. Any deploy order, and a rollback of any single
		// component, is safe only because of this.
		test("a row with only the old fields, only the new, and both produce the identical window", () => {
			const legacy = computeEventWindow(LEGACY_ONLY);
			const migrated = computeEventWindow(NEW_ONLY);
			const both = computeEventWindow({ ...LEGACY_ONLY, ...NEW_ONLY });

			expect(migrated).toEqual(legacy);
			expect(both).toEqual(legacy);
			expect(legacy.startMs).toBe(Date.parse("2026-09-28T03:00:00.000Z"));
			expect(legacy.endMs).toBe(Date.parse("2026-09-28T07:00:00.000Z"));
		});

		// THE bug this migration exists to kill. `date` stores 20:00 for an event whose bar opens at
		// 18:00 -- its time half is junk -- so the legacy derivation starts the pin's window two
		// hours late and rejects the bartender for the first two hours of her own shift.
		test("barOpensAt wins over date's junk time, so a bartender is not locked out of her first hours", () => {
			const row = {
				date: "2026-06-06T01:00:00.000Z", // 20:00 local -- meaningless time, correct day
				barOpenTime: "18:00",
				barCloseTime: "02:00",
				barOpensAt: "2026-06-05T23:00:00.000Z", // 18:00 local -- the real bar open
				barClosesAt: "2026-06-06T07:00:00.000Z", // 02:00 local
			};

			const window = computeEventWindow(row);

			expect(window.startMs).toBe(Date.parse("2026-06-05T23:00:00.000Z"));
			expect(window.endMs).toBe(Date.parse("2026-06-06T07:00:00.000Z"));
			// The legacy derivation of the very same row starts two hours later -- that gap is the
			// lockout.
			const legacy = computeEventWindow({ date: row.date, barOpenTime: row.barOpenTime, barCloseTime: row.barCloseTime });
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

		// Half-backfilled rows are a real state during the migration, not a hypothetical: the
		// backfill writes row by row and can be interrupted.
		test("anchors on barOpensAt and extends by the legacy HH:mm duration when no end instant exists yet", () => {
			const window = computeEventWindow({
				date: "2026-09-28T05:00:00.000Z",
				barOpensAt: "2026-09-28T03:00:00.000Z",
				barOpenTime: "22:00",
				barCloseTime: "02:00",
			});

			expect(window.startMs).toBe(Date.parse("2026-09-28T03:00:00.000Z"));
			expect(window.endMs - window.startMs).toBe(4 * 60 * 60 * 1000);
		});

		test("anchors on the legacy date and still honours barClosesAt when only the end was backfilled", () => {
			const window = computeEventWindow({
				date: "2026-09-28T03:00:00.000Z",
				barOpenTime: "22:00",
				barCloseTime: "02:00",
				barClosesAt: "2026-09-28T08:00:00.000Z", // bar ran an hour late
			});

			expect(window.startMs).toBe(Date.parse("2026-09-28T03:00:00.000Z"));
			expect(window.endMs).toBe(Date.parse("2026-09-28T08:00:00.000Z"));
		});

		test("ignores a blank or unparseable timestamp and falls back rather than producing a NaN window", () => {
			const window = computeEventWindow({ ...LEGACY_ONLY, barOpensAt: "", barClosesAt: "whenever" });
			expect(window).toEqual(computeEventWindow(LEGACY_ONLY));
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
