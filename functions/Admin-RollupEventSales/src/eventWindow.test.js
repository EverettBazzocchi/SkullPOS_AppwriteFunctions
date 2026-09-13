const { eventSalesWindow } = require("./eventWindow.js");

const hours = (window) => (window.end.getTime() - window.start.getTime()) / (60 * 60 * 1000);

// Two whole describe blocks used to live here -- "duration from the admin-editable bar hours" and
// "event_start/event_end fallback for rows with no bar hours" -- pinning the two legacy ways this
// function could invent an END from a start. Both attribute pairs are being deleted, so both
// derivations are deliberately gone and their tests with them. The behaviour that replaced them is
// pinned in "a start with no end" below: no end instant means no window, reported by main.js rather
// than guessed at, because the output of this function is money.

describe("eventSalesWindow", () => {
	test("returns null when the event has no start of any kind", () => {
		expect(eventSalesWindow({})).toBeNull();
	});

	test("returns null when date is unparseable", () => {
		expect(eventSalesWindow({ date: "not-a-date", endsAt: "2026-06-05T10:00:00.000Z" })).toBeNull();
	});

	test("start is always exactly the event's date field, untouched", () => {
		const { start } = eventSalesWindow({ date: "2026-03-15T13:37:00.000Z", endsAt: "2026-03-15T22:37:00.000Z" });
		expect(start.toISOString()).toBe("2026-03-15T13:37:00.000Z");
	});

	// The deliberate fail-closed half of this migration, and the reason this module and Verify-Pin's
	// now disagree on purpose. A missing end used to be papered over with a bar-hours duration, or
	// failing that a 7pm-4am default; either could attribute a whole window of transactions to the
	// wrong night and then overwrite figures that may already have been published. Skipping keeps
	// the event's existing numbers and puts a line in the Errors view.
	describe("a start with no end", () => {
		test("returns null for a row carrying startsAt but no end instant", () => {
			expect(eventSalesWindow({ startsAt: "2026-09-28T03:00:00.000Z" })).toBeNull();
		});

		test("returns null for a row carrying barOpensAt but no end instant", () => {
			expect(eventSalesWindow({ startsAt: null, barOpensAt: "2026-09-28T03:00:00.000Z" })).toBeNull();
		});

		test("returns null for a legacy row that only ever had a date", () => {
			expect(eventSalesWindow({ date: "2026-09-28T03:00:00.000Z" })).toBeNull();
		});
	});

	// --- the migrated shape: real timestamps -------------------------------------------------
	//
	// The same 22:00-02:00 night in Winnipeg (CDT, UTC-5), now expressible only as instants.
	describe("startsAt/endsAt/barOpensAt/barClosesAt", () => {
		const DATE_ONLY = { date: "2026-09-28T03:00:00.000Z" };
		const NEW_ONLY = {
			startsAt: "2026-09-28T03:00:00.000Z",
			endsAt: "2026-09-28T07:00:00.000Z",
			barOpensAt: "2026-09-28T03:00:00.000Z",
			barClosesAt: "2026-09-28T07:00:00.000Z",
		};

		// Replaces the old three-way equivalence proof, which could only hold while the HH:mm pair
		// supplied a duration. What matters now is that a leftover `date` on a migrated row cannot
		// move which transactions are folded into that event's revenue, tips and COGS.
		test("a leftover legacy date changes nothing about a row that carries the instants", () => {
			const migrated = eventSalesWindow(NEW_ONLY);
			const both = eventSalesWindow({ ...DATE_ONLY, ...NEW_ONLY });

			expect(both).toEqual(migrated);
			expect(migrated.start.toISOString()).toBe("2026-09-28T03:00:00.000Z");
			expect(migrated.end.toISOString()).toBe("2026-09-28T07:00:00.000Z");
		});

		test("the timestamps win over a date whose time half is junk", () => {
			const window = eventSalesWindow({
				date: "2026-09-28T05:00:00.000Z", // junk time -- two hours after the real start
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

		test("anchors on the legacy date and honours endsAt when only the end was backfilled", () => {
			const window = eventSalesWindow({ ...DATE_ONLY, endsAt: "2026-09-28T08:00:00.000Z" });
			expect(window.start.toISOString()).toBe("2026-09-28T03:00:00.000Z");
			expect(hours(window)).toBe(5);
		});

		test("ignores a blank or unparseable timestamp rather than producing an invalid window", () => {
			const usable = { ...DATE_ONLY, barClosesAt: "2026-09-28T07:00:00.000Z" };
			const window = eventSalesWindow({ ...usable, startsAt: "", endsAt: "sometime" });
			expect(window).toEqual(eventSalesWindow(usable));
			expect(hours(window)).toBe(4);
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
