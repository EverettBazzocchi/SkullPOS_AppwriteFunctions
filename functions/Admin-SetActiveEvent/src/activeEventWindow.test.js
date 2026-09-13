const { parseInstant, floorWindow, describeFloorWindow, barWindowUsable } = require("./activeEventWindow.js");

const ms = (iso) => Date.parse(iso);

describe("parseInstant", () => {
	test("reads the ISO instants Appwrite actually sends", () => {
		expect(parseInstant("2026-09-27T03:00:00.000+00:00")).toBe(ms("2026-09-27T03:00:00.000Z"));
		expect(parseInstant("2026-09-27T03:00:00.000Z")).toBe(ms("2026-09-27T03:00:00.000Z"));
		expect(parseInstant("2026-09-27T03:00Z")).toBe(ms("2026-09-27T03:00:00.000Z"));
		expect(parseInstant("2026-09-27 03:00:00Z")).toBe(ms("2026-09-27T03:00:00.000Z"));
		expect(parseInstant("2026-09-26T22:00:00-05:00")).toBe(ms("2026-09-27T03:00:00.000Z"));
	});

	test("accepts a Date, because a caller that already parsed one shouldn't stringify it back", () => {
		expect(parseInstant(new Date("2026-09-27T03:00:00.000Z"))).toBe(ms("2026-09-27T03:00:00.000Z"));
		expect(parseInstant(new Date("nonsense"))).toBeNull();
	});

	// THE WHOLE REASON THIS IS STRICTER THAN Date.parse. `Date.parse("1800")` is not NaN, it is the
	// YEAR 1800 -- an end instant two centuries in the past, which would make a LIVE event eligible
	// for deactivation on an open floor.
	test("refuses an HHmm-shaped wall clock rather than reading it as a year", () => {
		expect(Date.parse("1800")).not.toBeNaN(); // pins the trap itself, so nobody "fixes" this test
		expect(parseInstant("1800")).toBeNull();
		expect(parseInstant("18:00")).toBeNull();
		expect(parseInstant("2026-09-27")).toBeNull(); // a date with no time is not an instant either
	});

	test("refuses blanks, junk and non-strings", () => {
		[null, undefined, "", "   ", "late", 0, 1758942000000, {}, []].forEach((value) => {
			expect(parseInstant(value)).toBeNull();
		});
	});
});

describe("floorWindow", () => {
	test("takes the union of the bar's hours and the event's own", () => {
		expect(
			floorWindow({
				startsAt: "2026-09-27T04:00:00.000Z",
				endsAt: "2026-09-27T06:00:00.000Z",
				barOpensAt: "2026-09-27T03:00:00.000Z",
				barClosesAt: "2026-09-27T07:00:00.000Z",
			}),
		).toEqual({ startMs: ms("2026-09-27T03:00:00.000Z"), endMs: ms("2026-09-27T07:00:00.000Z") });
	});

	test("works from either pair alone", () => {
		expect(floorWindow({ startsAt: "2026-09-27T03:00:00.000Z", endsAt: "2026-09-27T07:00:00.000Z" })).toEqual({
			startMs: ms("2026-09-27T03:00:00.000Z"),
			endMs: ms("2026-09-27T07:00:00.000Z"),
		});
		expect(floorWindow({ barOpensAt: "2026-09-27T03:00:00.000Z", barClosesAt: "2026-09-27T07:00:00.000Z" })).toEqual({
			startMs: ms("2026-09-27T03:00:00.000Z"),
			endMs: ms("2026-09-27T07:00:00.000Z"),
		});
	});

	// A row with a start and no end could be activated and then never proved ENDED -- a trap door
	// this function could open and never close.
	test("a start with no end is no window at all", () => {
		const described = describeFloorWindow({ barOpensAt: "2026-09-27T03:00:00.000Z" });
		expect(described.window).toBeNull();
		expect(described.reason).toMatch(/no readable end instant/i);
	});

	test("an inverted pair is no window at all", () => {
		const described = describeFloorWindow({
			startsAt: "2026-09-27T07:00:00.000Z",
			endsAt: "2026-09-27T03:00:00.000Z",
		});
		expect(described.window).toBeNull();
		expect(described.reason).toMatch(/not after the start/i);
	});

	test("a zero-length pair is no window at all", () => {
		expect(floorWindow({ startsAt: "2026-09-27T03:00:00.000Z", endsAt: "2026-09-27T03:00:00.000Z" })).toBeNull();
	});

	// `date` is a start and never an end, and its time half is documented junk -- the live test row
	// carries date 00:00Z against a startsAt of 01:00Z.
	test("`date` is NOT a fallback, in either direction", () => {
		expect(floorWindow({ date: "2026-09-10T00:00:00.000Z" })).toBeNull();
		expect(floorWindow({ date: "2026-09-10T00:00:00.000Z", endsAt: "2026-09-10T07:00:00.000Z" })).toBeNull();
		// And it never moves a window that the four instants already describe.
		expect(
			floorWindow({
				date: "1999-01-01T00:00:00.000Z",
				startsAt: "2026-09-27T03:00:00.000Z",
				endsAt: "2026-09-27T07:00:00.000Z",
			}),
		).toEqual({ startMs: ms("2026-09-27T03:00:00.000Z"), endMs: ms("2026-09-27T07:00:00.000Z") });
	});

	test("an HHmm in barClosesAt makes the row unreadable, not two centuries old", () => {
		const described = describeFloorWindow({ barOpensAt: "2026-09-27T03:00:00.000Z", barClosesAt: "1800" });
		expect(described.window).toBeNull();
		expect(described.rejected).toEqual(["barClosesAt"]);
	});

	test("distinguishes an unfilled draft from a row whose values were refused", () => {
		expect(describeFloorWindow({ name: "Draft" }).rejected).toEqual([]);
		expect(describeFloorWindow({ name: "Draft" }).reason).toMatch(/no start or end instants at all/i);
		expect(describeFloorWindow({ startsAt: "soon", endsAt: "late" }).rejected).toEqual(["startsAt", "endsAt"]);
	});
});

describe("barWindowUsable", () => {
	// The shape that takes the floor and then sells nothing: a good event pair, a broken bar pair.
	test("is false for a missing, unreadable or inverted bar pair even when the union window is fine", () => {
		const eventPair = { startsAt: "2026-09-27T03:00:00.000Z", endsAt: "2026-09-27T07:00:00.000Z" };
		expect(floorWindow(eventPair)).not.toBeNull();
		expect(barWindowUsable(eventPair)).toBe(false);
		expect(barWindowUsable({ ...eventPair, barOpensAt: "2026-09-27T03:00:00.000Z", barClosesAt: "1800" })).toBe(false);
		expect(
			barWindowUsable({ ...eventPair, barOpensAt: "2026-09-27T07:00:00.000Z", barClosesAt: "2026-09-27T03:00:00.000Z" }),
		).toBe(false);
	});

	test("is true for the live rows' shape", () => {
		expect(barWindowUsable({ barOpensAt: "2026-09-27T03:00:00.000+00:00", barClosesAt: "2026-09-27T07:00:00.000+00:00" })).toBe(
			true,
		);
	});
});
