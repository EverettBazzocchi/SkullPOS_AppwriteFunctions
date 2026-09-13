const { decideActiveEvent, LEAD_MS, GRACE_MS, isTestRow } = require("./decideActiveEvent.js");

// Every rule, table-tested against a pure function -- no SDK, no mock, no clock. `now` is always an
// explicit instant, so a test that passes today passes in 2030.
const at = (iso) => Date.parse(iso);
const HOUR = 60 * 60 * 1000;

const decide = (rows, nowIso, options) => decideActiveEvent(rows, at(nowIso), options);
const ids = (docs) => docs.map((doc) => doc.$id);

// --- the three live rows, read-only-verified against the project on 2026-09-13 -------------------
// Using the real ids, names and instants makes these tests double as the record of what the
// collection actually looked like the day this was written.

// isActive:true, testing:false, union window 2026-09-10T00:00Z -> 07:00Z. The stale test event the
// floor had been pointing at for three days.
const stale = (overrides = {}) => ({
	$id: "6a9a44984028f75b0052",
	$updatedAt: "2026-09-13T21:42:14.318+00:00",
	name: "Everetts Test event ignopre",
	isActive: true,
	testing: false,
	sellsAlcohol: true,
	date: "2026-09-10T00:00:00.000Z",
	startsAt: "2026-09-10T01:00:00.000+00:00",
	endsAt: "2026-09-10T07:00:00.000+00:00",
	barOpensAt: "2026-09-10T00:00:00.000+00:00",
	barClosesAt: "2026-09-10T07:00:00.000+00:00",
	...overrides,
});

// The real paying event. Union window 2026-09-27T03:00Z -> 07:00Z, i.e. 22:00-02:00 America/Winnipeg
// across the night of the 26th. Lead-in opens 2026-09-26T21:00Z (16:00 local); swept
// 2026-09-27T11:00Z (06:00 local).
const party = (overrides = {}) => ({
	$id: "6aa08566ea9606801071",
	$updatedAt: "2026-09-13T18:12:34.070+00:00",
	name: "The NB Afterparty @ Skullspace",
	isActive: false,
	testing: false,
	sellsAlcohol: true,
	date: "2026-09-27T03:00:00.000Z",
	startsAt: "2026-09-27T03:00:00.000+00:00",
	endsAt: "2026-09-27T07:00:00.000+00:00",
	barOpensAt: "2026-09-27T03:00:00.000+00:00",
	barClosesAt: "2026-09-27T07:00:00.000+00:00",
	...overrides,
});

// Long over, inactive. Present in most fixtures because a rule that only works on a two-row
// collection is not the rule this function needs.
const hax = (overrides = {}) => ({
	$id: "6a9a44984ca3104e2efc",
	$updatedAt: "2026-09-13T18:12:33.465+00:00",
	name: "HAX 7.0 EDM Community Night",
	isActive: false,
	testing: false,
	sellsAlcohol: true,
	startsAt: "2026-06-05T23:00:00.000+00:00",
	endsAt: "2026-06-06T07:00:00.000+00:00",
	barOpensAt: "2026-06-05T23:00:00.000+00:00",
	barClosesAt: "2026-06-06T07:00:00.000+00:00",
	...overrides,
});

// A synthetic row for the shapes the live collection does not currently contain.
const event = (id, name, startIso, endIso, overrides = {}) => ({
	$id: id,
	$updatedAt: "2026-01-01T00:00:00.000Z",
	name,
	isActive: false,
	testing: false,
	sellsAlcohol: true,
	startsAt: startIso,
	endsAt: endIso,
	barOpensAt: startIso,
	barClosesAt: endIso,
	...overrides,
});

// Applies a decision to the rows the way Appwrite would, so a follow-up run can be asked what it
// makes of the state the previous one left behind.
function applyWrites(rows, decision, nowIso) {
	const activated = decision.activate ? decision.activate.$id : null;
	const deactivated = new Set(ids(decision.deactivate));
	return rows.map((row) => {
		if (row.$id === activated) return { ...row, isActive: true, $updatedAt: nowIso };
		if (deactivated.has(row.$id)) return { ...row, isActive: false, $updatedAt: nowIso };
		return row;
	});
}

const errors = (decision) => decision.reports.filter((r) => r.level === "error").map((r) => r.message);

// =================================================================================================
// The eight scenarios, walked through against the live rows.
// =================================================================================================

describe("scenario 1 -- 2026-09-26 21:55 local, five minutes before the bar opens", () => {
	test("the Afterparty already holds the floor and this run writes nothing", () => {
		const rows = [stale({ isActive: false }), hax(), party({ isActive: true })];
		const decision = decide(rows, "2026-09-27T02:55:00.000Z");

		expect(decision.intended.$id).toBe(party().$id);
		expect(decision.activate).toBeNull();
		expect(decision.deactivate).toEqual([]);
		expect(decision.incumbents).toEqual([
			{ id: party().$id, name: party().name, state: "LEAD_IN" },
		]);
		expect(decision.ambiguous).toBe(false);
	});

	test("it has been the incumbent, writing nothing, since the 21:00Z run six hours earlier", () => {
		const rows = [stale({ isActive: false }), hax(), party({ isActive: true })];
		[
			"2026-09-26T21:00:00.000Z",
			"2026-09-26T23:30:00.000Z",
			"2026-09-27T01:15:00.000Z",
			"2026-09-27T02:55:00.000Z",
			"2026-09-27T02:59:59.999Z",
		].forEach((nowIso) => {
			const decision = decide(rows, nowIso);
			expect(decision.activate).toBeNull();
			expect(decision.deactivate).toEqual([]);
			expect(decision.intended.$id).toBe(party().$id);
		});
	});
});

describe("scenario 2 -- 02:30 local, bar closed, staff cashing out", () => {
	test("the finished event keeps the floor through its grace, with zero writes", () => {
		const rows = [stale({ isActive: false }), hax(), party({ isActive: true })];
		const decision = decide(rows, "2026-09-27T07:30:00.000Z");

		expect(decision.candidates).toEqual([]); // GRACE is never a candidate
		expect(decision.incumbents).toEqual([]);
		expect(decision.activate).toBeNull();
		expect(decision.deactivate).toEqual([]); // and GRACE is never swept either
		expect(decision.heldBack).toBeNull();
	});

	test("it is swept at end + 4h = 06:00 local, not before", () => {
		const rows = [stale({ isActive: false }), hax(), party({ isActive: true })];

		expect(decide(rows, "2026-09-27T10:59:59.999Z").deactivate).toEqual([]);
		expect(ids(decide(rows, "2026-09-27T11:00:00.000Z").deactivate)).toEqual([party().$id]);
	});
});

describe("scenario 3 -- the operator ticks it active on the afternoon of the 26th", () => {
	test("a 16:05 run re-confirms the operator's choice and writes nothing", () => {
		const rows = [stale({ isActive: false }), hax(), party({ isActive: true })];
		const decision = decide(rows, "2026-09-26T21:05:00.000Z");

		expect(decision.intended.$id).toBe(party().$id);
		expect(decision.activate).toBeNull();
		expect(decision.deactivate).toEqual([]);
	});

	test("the 16:00 run gets there first anyway, so the human and the machine converge", () => {
		const rows = [stale({ isActive: false }), hax(), party()];

		expect(decide(rows, "2026-09-26T20:59:59.999Z").activate).toBeNull();
		expect(decide(rows, "2026-09-26T21:00:00.000Z").activate.$id).toBe(party().$id);
	});

	// The sharpest edge in the design, and it must be pinned rather than discovered at 1am.
	test("a tick BEFORE the lead makes the row a blocker: nothing is activated and nothing is touched", () => {
		const rows = [stale({ isActive: false }), hax(), party({ isActive: true })];
		const decision = decide(rows, "2026-09-26T19:00:00.000Z"); // 14:00 local, outside the 6h lead

		expect(decision.blockers).toEqual([{ id: party().$id, name: party().name, state: "FUTURE" }]);
		expect(decision.activate).toBeNull();
		expect(decision.deactivate).toEqual([]);
		expect(decision.ambiguous).toBe(true);
	});

	test("and it converges on its own once the lead opens", () => {
		const rows = [stale({ isActive: false }), hax(), party({ isActive: true })];
		const decision = decide(rows, "2026-09-26T21:00:00.000Z");

		expect(decision.blockers).toEqual([]);
		expect(decision.intended.$id).toBe(party().$id);
		expect(decision.activate).toBeNull(); // already active -- the operator's tick stands
	});
});

describe("scenario 4 -- two events carry isActive:true", () => {
	test("(a) the realistic one: the stale row is swept and the real event keeps the floor", () => {
		const rows = [stale({ isActive: true }), hax(), party({ isActive: true })];
		const decision = decide(rows, "2026-09-26T21:05:00.000Z");

		expect(decision.incumbents).toEqual([{ id: party().$id, name: party().name, state: "LEAD_IN" }]);
		expect(decision.activate).toBeNull();
		expect(ids(decision.deactivate)).toEqual([stale().$id]);

		const after = applyWrites(rows, decision, "2026-09-26T21:05:00.000Z");
		expect(after.filter((row) => row.isActive).map((row) => row.$id)).toEqual([party().$id]);
	});

	test("(b) two genuinely current events: neither is touched, both are named at error()", () => {
		const other = event("both-b", "Back Room Set", "2026-09-27T04:00:00.000Z", "2026-09-27T08:00:00.000Z", {
			isActive: true,
		});
		const rows = [stale({ isActive: true }), party({ isActive: true }), other];
		const decision = decide(rows, "2026-09-27T05:00:00.000Z");

		expect(decision.incumbents).toHaveLength(2);
		expect(decision.activate).toBeNull();
		expect(decision.ambiguous).toBe(true);
		// The ENDED sweep still runs in the same pass, so the state drains toward single-active.
		expect(ids(decision.deactivate)).toEqual([stale().$id]);
		expect(errors(decision).join(" ")).toContain(party().$id);
		expect(errors(decision).join(" ")).toContain("both-b");
	});
});

describe("scenario 5 -- a row with barOpensAt but a null endsAt", () => {
	test("barClosesAt present makes it completely ordinary", () => {
		const row = event("half", "Half Filled", null, null, {
			startsAt: null,
			endsAt: null,
			barOpensAt: "2026-09-27T03:00:00.000Z",
			barClosesAt: "2026-09-27T07:00:00.000Z",
		});
		const decision = decide([row], "2026-09-27T05:00:00.000Z");

		expect(decision.activate.$id).toBe("half");
		expect(decision.unscheduled).toEqual([]);
	});

	test("no end instant at all makes it UNSCHEDULED: never activated, and reported", () => {
		const row = event("no-end", "No End", null, null, {
			startsAt: null,
			endsAt: null,
			barOpensAt: "2026-09-27T03:00:00.000Z",
			barClosesAt: null,
		});
		const decision = decide([row], "2026-09-27T05:00:00.000Z");

		expect(decision.activate).toBeNull();
		expect(decision.candidates).toEqual([]);
		expect(decision.unscheduled).toEqual([
			{ id: "no-end", name: "No End", reason: expect.stringMatching(/no readable end instant/i) },
		]);
	});

	test("and if it is the ACTIVE row it becomes a blocker -- suspended, never switched off", () => {
		const row = event("no-end", "No End", null, null, {
			startsAt: null,
			endsAt: null,
			barOpensAt: "2026-09-27T03:00:00.000Z",
			barClosesAt: null,
			isActive: true,
		});
		const decision = decide([row, party()], "2026-09-27T05:00:00.000Z");

		expect(decision.blockers).toEqual([{ id: "no-end", name: "No End", state: "UNSCHEDULED" }]);
		expect(decision.activate).toBeNull();
		expect(decision.deactivate).toEqual([]);
		// The Afterparty is LIVE and is the thing being blocked, so the wording escalates.
		expect(errors(decision).join(" ")).toMatch(/running RIGHT NOW/);
		expect(errors(decision).join(" ")).toMatch(/Alcohol will stay hidden/);
	});
});

describe("scenario 6 -- the only row whose window contains now is flagged testing", () => {
	const testRow = (overrides = {}) =>
		event("tonight-test", "Tonight (test)", "2026-09-27T03:00:00.000Z", "2026-09-27T07:00:00.000Z", {
			testing: true,
			...overrides,
		});

	test("it is never a candidate, so no path can write isActive:true to it", () => {
		const decision = decide([stale({ isActive: false }), testRow()], "2026-09-27T05:00:00.000Z");
		expect(decision.candidates).toEqual([]);
		expect(decision.activate).toBeNull();
	});

	test("the sweep guard holds the stale row back rather than leaving the floor dark", () => {
		const rows = [stale({ isActive: true }), testRow()];
		const decision = decide(rows, "2026-09-27T05:00:00.000Z");

		expect(decision.deactivate).toEqual([]);
		expect(decision.heldBack).toEqual({ id: stale().$id, name: stale().name, state: "ENDED" });
		expect(errors(decision).join(" ")).toMatch(/NO active event at all/);
	});

	// The side door: sweeping everything around an already-active test event promotes it to the
	// floor by subtraction, without ever writing isActive:true to it.
	test("it is not promoted by subtraction either", () => {
		const rows = [stale({ isActive: true }), testRow({ isActive: true })];
		const decision = decide(rows, "2026-09-27T05:00:00.000Z");

		expect(decision.deactivate).toEqual([]);
		expect(decision.heldBack.id).toBe(stale().$id);
		expect(errors(decision).join(" ")).toMatch(/only a TEST event holding the floor/);
	});

	// The guard's OTHER trigger, and it had no test of its own until one was written: a row this
	// function cannot READ is as dangerous as one it can see running, because the reason it cannot
	// read it may well be that somebody fat-fingered tonight's barClosesAt an hour before doors.
	// "Possibly running" therefore has to include UNSCHEDULED, not just LIVE -- otherwise a botched
	// row is treated as evidence that nothing is on, and the sweep takes the floor to zero on the
	// one night it must not. Deleting `|| entry.state === UNSCHEDULED` from the guard used to pass
	// every test in this file.
	test("an unreadable row also counts as possibly running, so the sweep still holds back", () => {
		const junk = event("junk", "Tonight?", "1800", "1800", { barOpensAt: "1800", barClosesAt: "1800" });
		const rows = [stale({ isActive: true }), junk];
		const decision = decide(rows, "2026-09-27T05:00:00.000Z");

		expect(decision.deactivate).toEqual([]);
		expect(decision.heldBack.id).toBe(stale().$id);
		expect(errors(decision).join(" ")).toMatch(/NO active event at all/);
		// ...and it says WHICH row it could not read, because that is the row to go and fix.
		expect(errors(decision).join(" ")).toMatch(/Tonight\?/);
	});

	test("but a real active event means the sweep proceeds normally", () => {
		const rows = [stale({ isActive: true }), testRow(), party({ isActive: true })];
		const decision = decide(rows, "2026-09-27T05:00:00.000Z");

		expect(ids(decision.deactivate)).toEqual([stale().$id]);
		expect(decision.heldBack).toBeNull();
	});
});

describe("scenario 7 -- a quiet Tuesday, nothing matches now", () => {
	test("the stale row is finally swept and the collection goes to zero active", () => {
		const rows = [stale({ isActive: true }), hax(), party()];
		const decision = decide(rows, "2026-09-15T18:00:00.000Z");

		expect(decision.candidates).toEqual([]);
		expect(decision.activate).toBeNull();
		expect(ids(decision.deactivate)).toEqual([stale().$id]);
		expect(decision.heldBack).toBeNull();

		const after = applyWrites(rows, decision, "2026-09-15T18:00:00.000Z");
		expect(after.filter((row) => row.isActive)).toEqual([]);
	});

	test("and every run after that is a read and nothing else", () => {
		const rows = [stale({ isActive: false }), hax(), party()];
		const decision = decide(rows, "2026-09-15T18:15:00.000Z");

		expect(decision.activate).toBeNull();
		expect(decision.deactivate).toEqual([]);
		expect(decision.reports.filter((r) => r.level === "error")).toEqual([]);
	});
});

describe("scenario 8 -- the cron does not run for six hours, then runs once", () => {
	test("the single late run produces exactly what a continuous one would have", () => {
		const rows = [stale({ isActive: true }), hax(), party()];
		const late = decide(rows, "2026-09-27T02:00:00.000Z");

		// Six hourly runs it missed would have landed here too -- there is no backlog to replay.
		expect(late.activate.$id).toBe(party().$id);
		expect(ids(late.deactivate)).toEqual([stale().$id]);
	});

	test("a concurrent replay burst is harmless: every copy decides the same thing", () => {
		const rows = [stale({ isActive: true }), hax(), party()];
		const burst = [0, 13, 240, 999].map((offsetMs) =>
			decideActiveEvent(rows, at("2026-09-27T02:00:00.000Z") + offsetMs),
		);

		burst.forEach((decision) => {
			expect(decision.activate.$id).toBe(burst[0].activate.$id);
			expect(ids(decision.deactivate)).toEqual(ids(burst[0].deactivate));
		});

		// ...and the copies that lose the race find the work already done.
		const after = applyWrites(rows, burst[0], "2026-09-27T02:00:00.000Z");
		const loser = decideActiveEvent(after, at("2026-09-27T02:00:00.000Z") + 999);
		expect(loser.activate).toBeNull();
		expect(loser.deactivate).toEqual([]);
	});
});

// =================================================================================================
// Idempotency
// =================================================================================================

describe("idempotency", () => {
	test("a second run immediately after the first writes nothing", () => {
		const rows = [stale({ isActive: true }), hax(), party()];
		const first = decide(rows, "2026-09-26T21:00:00.000Z");
		expect(first.activate.$id).toBe(party().$id);
		expect(ids(first.deactivate)).toEqual([stale().$id]);

		const second = decide(applyWrites(rows, first, "2026-09-26T21:00:00.000Z"), "2026-09-26T21:00:01.000Z");
		expect(second.activate).toBeNull();
		expect(second.deactivate).toEqual([]);
	});

	test("and so does every run across the whole night, once the first has settled it", () => {
		let rows = [stale({ isActive: true }), hax(), party()];
		rows = applyWrites(rows, decide(rows, "2026-09-26T21:00:00.000Z"), "2026-09-26T21:00:00.000Z");

		// Every quarter-hour from activation to the end of grace: exactly zero further writes.
		for (let t = at("2026-09-26T21:15:00.000Z"); t < at("2026-09-27T11:00:00.000Z"); t += 15 * 60 * 1000) {
			const decision = decideActiveEvent(rows, t);
			expect(decision.activate).toBeNull();
			expect(decision.deactivate).toEqual([]);
		}

		// And then, at 06:00 local, exactly one.
		const sweep = decide(rows, "2026-09-27T11:00:00.000Z");
		expect(ids(sweep.deactivate)).toEqual([party().$id]);
		expect(decide(applyWrites(rows, sweep, "2026-09-27T11:00:00.000Z"), "2026-09-27T11:15:00.000Z").deactivate).toEqual(
			[],
		);
	});
});

// =================================================================================================
// The same-night handover, step by step -- the case that decides whether LEAD > GRACE is safe.
// =================================================================================================

describe("same-night handover: a 14:00-18:00 matinee and a 20:00-02:00 party", () => {
	// Local times spelled as instants (America/Winnipeg is UTC-5 in September).
	const matinee = (overrides = {}) =>
		event("matinee", "All-Ages Matinee", "2026-09-26T19:00:00.000Z", "2026-09-26T23:00:00.000Z", overrides);
	const night = (overrides = {}) =>
		event("night", "Late Party", "2026-09-27T01:00:00.000Z", "2026-09-27T07:00:00.000Z", overrides);

	test("08:00 local -- the matinee is in its lead-in and is activated", () => {
		const decision = decide([matinee(), night()], "2026-09-26T13:00:00.000Z");
		expect(decision.activate.$id).toBe("matinee");
		expect(decision.deactivate).toEqual([]);
	});

	test("16:30 local -- the matinee is LIVE and the party's lead-in has opened; zero writes", () => {
		const decision = decide([matinee({ isActive: true }), night()], "2026-09-26T21:30:00.000Z");
		expect(decision.candidates.map((c) => c.id).sort()).toEqual(["matinee", "night"]);
		// The comparator is never consulted while an incumbent exists.
		expect(decision.intended.$id).toBe("matinee");
		expect(decision.activate).toBeNull();
		expect(decision.deactivate).toEqual([]);
	});

	test("19:00 local -- the matinee is in GRACE and a LEAD_IN-only successor does not displace it", () => {
		const decision = decide([matinee({ isActive: true }), night()], "2026-09-27T00:00:00.000Z");
		expect(decision.intended).toBeNull();
		expect(decision.activate).toBeNull();
		expect(decision.deactivate).toEqual([]);
	});

	test("20:00 local -- the party starts, so handover fires: activate first, deactivate second", () => {
		const rows = [matinee({ isActive: true }), night()];
		const decision = decide(rows, "2026-09-27T01:00:00.000Z");

		expect(decision.activate.$id).toBe("night");
		expect(ids(decision.deactivate)).toEqual(["matinee"]);

		const after = applyWrites(rows, decision, "2026-09-27T01:00:00.000Z");
		expect(after.filter((row) => row.isActive).map((row) => row.$id)).toEqual(["night"]);
	});

	test("exactly one row is active at the end of every run across the whole evening", () => {
		let rows = [matinee(), night()];
		for (let t = at("2026-09-26T12:00:00.000Z"); t <= at("2026-09-27T12:00:00.000Z"); t += 15 * 60 * 1000) {
			const decision = decideActiveEvent(rows, t);
			rows = applyWrites(rows, decision, new Date(t).toISOString());
			expect(rows.filter((row) => row.isActive).length).toBeLessThanOrEqual(1);
		}
		// ...and by the morning after, nothing is left active.
		expect(rows.filter((row) => row.isActive)).toEqual([]);
	});

	test("a crash between the two writes is repaired by the next run, not left for four hours", () => {
		// Activation landed; the deactivation did not.
		const rows = [matinee({ isActive: true }), night({ isActive: true })];
		const decision = decide(rows, "2026-09-27T01:15:00.000Z");

		expect(decision.activate).toBeNull(); // the successor is already active
		expect(ids(decision.deactivate)).toEqual(["matinee"]); // handover still finishes the job
	});
});

// =================================================================================================
// Property A, B and F, stated as properties rather than as examples.
// =================================================================================================

describe("property A -- never deactivate an event that has not ended", () => {
	const nowIso = "2026-09-27T05:00:00.000Z";
	const now = at(nowIso);

	// Rows whose own end instant is NOT in the past. These are unreachable by the write planner in
	// every circumstance -- there is no move available on them at all.
	const notEnded = {
		FUTURE: event("p-future", "Tomorrow", "2026-09-28T03:00:00.000Z", "2026-09-28T07:00:00.000Z"),
		LEAD_IN: event("p-lead", "Later Tonight", "2026-09-27T09:00:00.000Z", "2026-09-27T13:00:00.000Z"),
		LIVE: event("p-live", "Running", "2026-09-27T03:00:00.000Z", "2026-09-27T07:00:00.000Z"),
		UNSCHEDULED: event("p-unsched", "No Window", null, null, { startsAt: null, endsAt: null, barOpensAt: null, barClosesAt: null }),
		UNREADABLE: event("p-junk", "Junk Times", "1800", "1800", { barOpensAt: "1800", barClosesAt: "1800" }),
	};
	const grace = event("p-grace", "Just Finished", "2026-09-26T23:00:00.000Z", "2026-09-27T03:00:00.000Z");

	Object.entries(notEnded).forEach(([state, row]) => {
		test(`a ${state} row that is active is never deactivated`, () => {
			// Paired with a whole zoo of other rows -- a LIVE handover, a stale sweep, an ambiguous
			// pair -- so no rule can reach it sideways either.
			const rows = [
				{ ...row, isActive: true },
				stale({ isActive: true }),
				party(),
				hax(),
				grace,
				...Object.values(notEnded),
			];
			const decision = decideActiveEvent(rows, now);
			expect(ids(decision.deactivate)).not.toContain(row.$id);
		});
	});

	// GRACE is the one class whose own window HAS ended, which is why the handover branch is allowed
	// to reach it. It is still never swept on the clock alone before end + 4h.
	test("a GRACE row is deactivated only as the second half of a live handover", () => {
		const withoutSuccessor = decideActiveEvent([{ ...grace, isActive: true }, hax()], now);
		expect(withoutSuccessor.deactivate).toEqual([]);

		const withSuccessor = decideActiveEvent([{ ...grace, isActive: true }, notEnded.LIVE], now);
		expect(withSuccessor.activate.$id).toBe("p-live");
		expect(ids(withSuccessor.deactivate)).toEqual(["p-grace"]);

		// A LEAD_IN-only successor is not enough.
		const leadOnly = decideActiveEvent([{ ...grace, isActive: true }, notEnded.LEAD_IN], now);
		expect(leadOnly.activate).toBeNull();
		expect(leadOnly.deactivate).toEqual([]);
	});

	// The handover branch reaches GRACE rows, so the "is the successor actually LIVE?" test is the
	// only thing standing between a closing shift and having the till yanked out from under them.
	// The pair rule that enforces it for a fresh activation lives in the candidates branch -- which
	// an INCUMBENT skips entirely, because incumbency short-circuits the comparator. So the LIVE
	// test has to be on the handover itself as well, and this is the shape that proves it: last
	// night's event still inside its wind-down while somebody has already ticked tomorrow's on.
	// Relaxing the handover to `intended ? ... : []` used to pass every test in this file.
	test("a LEAD_IN incumbent does not cut a grace holder's wind-down short", () => {
		const closing = event("closing", "Last Night", "2026-09-26T21:00:00.000Z", "2026-09-27T01:00:00.000Z", {
			isActive: true,
		});
		const tomorrow = event("tomorrow", "Tomorrow", "2026-09-27T09:00:00.000Z", "2026-09-27T13:00:00.000Z", {
			isActive: true,
		});
		// 02:00 local: the bar shut an hour ago and the cash-out is still running.
		const decision = decideActiveEvent([closing, tomorrow], at("2026-09-27T03:00:00.000Z"));

		expect(decision.intended.$id).toBe("tomorrow");
		expect(decision.deactivate).toEqual([]);
		// It stays shielded right up to its own end + 4h, and is then swept on the clock like
		// anything else -- never earlier, and never because a lead-in wanted the floor.
		expect(ids(decideActiveEvent([closing, tomorrow], at("2026-09-27T04:59:00.000Z")).deactivate)).toEqual([]);
		expect(ids(decideActiveEvent([closing, tomorrow], at("2026-09-27T05:01:00.000Z")).deactivate)).toEqual([
			"closing",
		]);
	});

	test("an UNREADABLE row is never swept no matter how old it looks", () => {
		const ancient = event("ancient", "Ancient", "1800", "1800", { barOpensAt: "1800", barClosesAt: "1800", isActive: true });
		const decision = decideActiveEvent([ancient, party({ isActive: true })], at("2026-09-27T05:00:00.000Z"));
		expect(decision.deactivate).toEqual([]);
		expect(decision.unreadable.map((u) => u.id)).toEqual(["ancient"]);
	});
});

describe("property B -- never activate a testing row", () => {
	test.each([[true], ["true"], [1]])("testing=%p is never a candidate and never activated", (flag) => {
		const row = event("t", "Tonight", "2026-09-27T03:00:00.000Z", "2026-09-27T07:00:00.000Z", { testing: flag });
		expect(isTestRow(row)).toBe(true);
		const decision = decideActiveEvent([row], at("2026-09-27T05:00:00.000Z"));
		expect(decision.candidates).toEqual([]);
		expect(decision.activate).toBeNull();
	});

	test.each([[false], ["false"], [0], [null], [undefined]])(
		"testing=%p is a normal event -- an over-broad test would strand the real floor",
		(flag) => {
			const row = event("t", "Tonight", "2026-09-27T03:00:00.000Z", "2026-09-27T07:00:00.000Z", { testing: flag });
			expect(isTestRow(row)).toBe(false);
			expect(decideActiveEvent([row], at("2026-09-27T05:00:00.000Z")).activate.$id).toBe("t");
		},
	);
});

describe("property F -- never leave more than one row active by its own writes", () => {
	test("across a dense grid of overlapping events and start states", () => {
		const base = [
			event("a", "A", "2026-09-27T01:00:00.000Z", "2026-09-27T05:00:00.000Z"),
			event("b", "B", "2026-09-27T03:00:00.000Z", "2026-09-27T09:00:00.000Z"),
			event("c", "C", "2026-09-27T04:00:00.000Z", "2026-09-27T06:00:00.000Z"),
			stale(),
		];
		for (let mask = 0; mask < 16; mask += 1) {
			let rows = base.map((row, index) => ({ ...row, isActive: Boolean(mask & (1 << index)) }));
			const activeBefore = rows.filter((row) => row.isActive).length;
			for (let t = at("2026-09-27T00:00:00.000Z"); t <= at("2026-09-27T14:00:00.000Z"); t += 30 * 60 * 1000) {
				const decision = decideActiveEvent(rows, t);
				rows = applyWrites(rows, decision, new Date(t).toISOString());
				const activeAfter = rows.filter((row) => row.isActive).length;
				// It may INHERIT a multi-active mess a human made (property A forbids resolving it),
				// but it may never create or grow one.
				expect(activeAfter).toBeLessThanOrEqual(Math.max(1, activeBefore));
			}
		}
	});

	test("it never activates and deactivates the same row in one run", () => {
		const rows = [stale({ isActive: true }), party({ isActive: true }), hax({ isActive: true })];
		for (let t = at("2026-09-26T00:00:00.000Z"); t <= at("2026-09-28T00:00:00.000Z"); t += 17 * 60 * 1000) {
			const decision = decideActiveEvent(rows, t);
			if (decision.activate) expect(ids(decision.deactivate)).not.toContain(decision.activate.$id);
		}
	});
});

// =================================================================================================
// The comparator
// =================================================================================================

describe("overlap comparator (no incumbent, no blocker, several candidates)", () => {
	const nowIso = "2026-09-27T05:00:00.000Z";

	test("LIVE beats LEAD_IN even when the lead-in event starts and ends sooner-looking", () => {
		const live = event("live", "Running", "2026-09-27T03:00:00.000Z", "2026-09-27T11:00:00.000Z");
		const lead = event("lead", "Soon", "2026-09-27T06:00:00.000Z", "2026-09-27T07:00:00.000Z");
		expect(decide([lead, live], nowIso).activate.$id).toBe("live");
	});

	test("among LIVE events, the one finishing soonest wins -- not the one that started first", () => {
		const allDay = event("allday", "All Day", "2026-09-27T00:00:00.000Z", "2026-09-27T23:00:00.000Z");
		const tonight = event("tonight", "Tonight", "2026-09-27T04:00:00.000Z", "2026-09-27T09:00:00.000Z");
		expect(decide([allDay, tonight], nowIso).activate.$id).toBe("tonight");
	});

	test("$id breaks a perfect tie, so the answer does not depend on row order", () => {
		const a = event("aaa", "A", "2026-09-27T03:00:00.000Z", "2026-09-27T07:00:00.000Z");
		const b = event("bbb", "B", "2026-09-27T03:00:00.000Z", "2026-09-27T07:00:00.000Z");
		expect(decide([a, b], nowIso).activate.$id).toBe("aaa");
		expect(decide([b, a], nowIso).activate.$id).toBe("aaa");
	});

	test("$updatedAt is never an arbiter -- the daily rollup bumps exactly the rows it would fool", () => {
		const old = event("old", "Old", "2026-09-27T04:00:00.000Z", "2026-09-27T06:00:00.000Z", {
			$updatedAt: "2020-01-01T00:00:00.000Z",
		});
		const touched = event("touched", "Touched", "2026-09-27T03:00:00.000Z", "2026-09-27T09:00:00.000Z", {
			$updatedAt: "2026-09-27T04:59:00.000Z",
		});
		// "old" wins on the earliest end, despite "touched" having been written a minute ago.
		expect(decide([old, touched], nowIso).activate.$id).toBe("old");
	});

	test("the log names the rule that picked the winner, not just the winner", () => {
		const live = event("live", "Running", "2026-09-27T03:00:00.000Z", "2026-09-27T11:00:00.000Z");
		const lead = event("lead", "Soon", "2026-09-27T06:00:00.000Z", "2026-09-27T07:00:00.000Z");
		const messages = decide([lead, live], nowIso).reports.map((r) => r.message).join(" ");
		expect(messages).toMatch(/2 events qualify right now/);
		expect(messages).toMatch(/running right now/i);
	});
});

// =================================================================================================
// DST. Every comparison is instant-versus-instant, so the shift cannot move anything.
// =================================================================================================

describe("DST boundaries (America/Winnipeg, CDT -> CST on 2026-11-01)", () => {
	// The fall-back night: 22:00 local CDT (UTC-5) to 02:00 local CST (UTC-6). The clocks go back an
	// hour mid-window, so the wall clock says four hours and the instants say FIVE.
	const fallBack = (overrides = {}) =>
		event("fall-back", "Fall Back Night", "2026-11-01T03:00:00.000Z", "2026-11-01T08:00:00.000Z", overrides);

	test("the 25-hour night is one contiguous window with no midnight or DST special case", () => {
		const rows = [fallBack()];
		// 21:00Z = 16:00 CDT on 2026-10-31: the lead opens exactly six hours before the union start.
		expect(decide(rows, "2026-10-31T20:59:59.999Z").activate).toBeNull();
		expect(decide(rows, "2026-10-31T21:00:00.000Z").activate.$id).toBe("fall-back");
		// 07:30Z is 01:30 CST -- AFTER the clocks went back, and still inside the event.
		expect(decide([fallBack({ isActive: true })], "2026-11-01T07:30:00.000Z").deactivate).toEqual([]);
		// Swept at 08:00Z + 4h = 12:00Z = 06:00 CST, exactly as on any other night.
		expect(decide([fallBack({ isActive: true })], "2026-11-01T11:59:59.999Z").deactivate).toEqual([]);
		expect(ids(decide([fallBack({ isActive: true })], "2026-11-01T12:00:00.000Z").deactivate)).toEqual(["fall-back"]);
	});

	test("the spring-forward night's 3-hour instant span is handled by the same arithmetic", () => {
		// 2026-03-08: 22:00 local CST (UTC-6) to 02:00 local CDT (UTC-5) -- four wall-clock hours,
		// three real ones, because 02:00 local never happens.
		const springForward = (overrides = {}) =>
			event("spring", "Spring Forward Night", "2026-03-08T04:00:00.000Z", "2026-03-08T07:00:00.000Z", overrides);

		expect(decide([springForward()], "2026-03-07T21:59:59.999Z").activate).toBeNull();
		expect(decide([springForward()], "2026-03-07T22:00:00.000Z").activate.$id).toBe("spring");
		expect(decide([springForward({ isActive: true })], "2026-03-08T06:59:00.000Z").deactivate).toEqual([]);
		expect(ids(decide([springForward({ isActive: true })], "2026-03-08T11:00:00.000Z").deactivate)).toEqual(["spring"]);
	});

	test("the decision depends only on the instant, never on how long the local day was", () => {
		// The same offsets from the window's own edges produce the same classification on a 23-hour
		// day, a 24-hour day and a 25-hour day.
		const nights = [
			event("n23", "Spring", "2026-03-08T04:00:00.000Z", "2026-03-08T07:00:00.000Z"),
			event("n24", "Ordinary", "2026-09-27T03:00:00.000Z", "2026-09-27T07:00:00.000Z"),
			event("n25", "Fall", "2026-11-01T03:00:00.000Z", "2026-11-01T08:00:00.000Z"),
		];
		nights.forEach((row) => {
			const window = { start: Date.parse(row.startsAt), end: Date.parse(row.endsAt) };
			expect(decideActiveEvent([row], window.start - LEAD_MS - 1).activate).toBeNull();
			expect(decideActiveEvent([row], window.start - LEAD_MS).activate.$id).toBe(row.$id);
			const active = [{ ...row, isActive: true }];
			expect(decideActiveEvent(active, window.end + GRACE_MS - 1).deactivate).toEqual([]);
			expect(ids(decideActiveEvent(active, window.end + GRACE_MS).deactivate)).toEqual([row.$id]);
		});
	});
});

// =================================================================================================
// Boundaries, fail-safes and the remaining edges.
// =================================================================================================

describe("class boundaries are half-open, so no instant lands in two classes", () => {
	const row = event("b", "Boundary", "2026-09-27T03:00:00.000Z", "2026-09-27T07:00:00.000Z");
	const start = at("2026-09-27T03:00:00.000Z");
	const end = at("2026-09-27T07:00:00.000Z");

	test.each([
		["one ms before the lead opens", start - LEAD_MS - 1, "FUTURE"],
		["the instant the lead opens", start - LEAD_MS, "LEAD_IN"],
		["one ms before the start", start - 1, "LEAD_IN"],
		["the start instant itself", start, "LIVE"],
		["one ms before the end", end - 1, "LIVE"],
		["the end instant itself", end, "GRACE"],
		["one ms before grace expires", end + GRACE_MS - 1, "GRACE"],
		["the instant grace expires", end + GRACE_MS, "ENDED"],
	])("%s is %s", (_label, nowMs, expected) => {
		const decision = decideActiveEvent([{ ...row, isActive: true }], nowMs);
		const seen = [...decision.candidates, ...decision.blockers].find((entry) => entry.id === "b");
		if (expected === "GRACE") {
			expect(seen).toBeUndefined();
			expect(decision.deactivate).toEqual([]);
		} else if (expected === "ENDED") {
			expect(ids(decision.deactivate)).toEqual(["b"]);
		} else {
			expect(seen.state).toBe(expected);
			expect(decision.deactivate).toEqual([]);
		}
	});
});

describe("the grace is asymmetric on purpose", () => {
	test("an event unticked at 02:05 after close is NOT switched back on at 02:15", () => {
		const rows = [party({ isActive: false })]; // the operator just unticked it
		const decision = decide(rows, "2026-09-27T07:15:00.000Z"); // 02:15 local, inside grace
		expect(decision.activate).toBeNull();
		expect(decision.candidates).toEqual([]);
	});
});

describe("clock sanity", () => {
	test("a container clock well behind the newest $updatedAt changes nothing and says so", () => {
		const rows = [stale({ isActive: true, $updatedAt: "2026-09-27T12:00:00.000Z" }), party()];
		const decision = decide(rows, "2026-09-27T11:00:00.000Z"); // an hour behind

		expect(decision.activate).toBeNull();
		expect(decision.deactivate).toEqual([]);
		expect(decision.clockSkewMs).toBe(HOUR);
		expect(errors(decision).join(" ")).toMatch(/clock/i);
		expect(errors(decision).join(" ")).toMatch(/BEHIND/);
	});

	test("a few minutes of ordinary skew is tolerated", () => {
		const rows = [stale({ isActive: true, $updatedAt: "2026-09-15T18:05:00.000Z" })];
		const decision = decide(rows, "2026-09-15T18:00:00.000Z");
		expect(decision.clockSkewMs).toBeNull();
		expect(ids(decision.deactivate)).toEqual([stale().$id]);
	});
});

describe("reporting", () => {
	test("warns when the event taking the floor sells alcohol but has an unusable bar pair", () => {
		const row = event("bad-bar", "Bad Bar Pair", "2026-09-27T03:00:00.000Z", "2026-09-27T07:00:00.000Z", {
			barOpensAt: "2026-09-27T07:00:00.000Z",
			barClosesAt: "2026-09-27T03:00:00.000Z",
			sellsAlcohol: true,
		});
		const decision = decide([row], "2026-09-27T05:00:00.000Z");

		expect(decision.activate.$id).toBe("bad-bar"); // the union window is fine, so it still wins
		expect(errors(decision).join(" ")).toMatch(/sells alcohol but its bar window is unusable/i);
	});

	test("names an unreadable row every run, but does not nag about an empty draft", () => {
		const junk = event("junk", "Junk", "1800", "1800", { barOpensAt: null, barClosesAt: null });
		const draft = event("draft", "Draft", null, null, { startsAt: null, endsAt: null, barOpensAt: null, barClosesAt: null });
		const decision = decide([junk, draft, party({ isActive: true })], "2026-09-27T05:00:00.000Z");

		expect(decision.unscheduled.map((u) => u.id).sort()).toEqual(["draft", "junk"]);
		expect(decision.unreadable.map((u) => u.id)).toEqual(["junk"]);
		expect(errors(decision).join(" ")).toContain("junk");
		expect(errors(decision).join(" ")).not.toContain('"Draft"');
	});

	test("an empty collection is a quiet, write-free no-op", () => {
		const decision = decideActiveEvent([], at("2026-09-27T05:00:00.000Z"));
		expect(decision).toMatchObject({ intended: null, activate: null, deactivate: [], ambiguous: false });
		expect(decision.reports).toEqual([]);
	});
});

describe("the lead and grace constants are what the reasoning assumes", () => {
	test("6h lead, 4h grace", () => {
		expect(LEAD_MS).toBe(6 * HOUR);
		expect(GRACE_MS).toBe(4 * HOUR);
	});

	test("the Afterparty is activated at 16:00 local on the 26th and swept at 06:00 local on the 27th", () => {
		expect(at(party().startsAt) - LEAD_MS).toBe(at("2026-09-26T21:00:00.000Z"));
		expect(at(party().endsAt) + GRACE_MS).toBe(at("2026-09-27T11:00:00.000Z"));
	});
});

// Three holes found by an adversarial re-read of this function. Every one of them is a case where
// the rules were followed to the letter and the FLOOR still ended up on the wrong event -- and
// where the run said nothing, or said it at log level, so nobody could have known.
describe("the wrong event holds the floor and the run has to say so", () => {
	// The design's "sharpest edge": tomorrow's event ticked active while tonight's is running.
	// Ticked more than six hours ahead it is FUTURE, so it is a BLOCKER and the refusal below
	// escalates. Ticked INSIDE its own six-hour lead-in it is a candidate, therefore an incumbent,
	// therefore the operator override -- and incumbency short-circuits the comparator, so the run
	// used to be completely silent in exactly the window the generous lead makes most likely.
	const matinee = (overrides = {}) =>
		event("matinee", "Matinee", "2026-09-26T19:00:00.000Z", "2026-09-26T23:00:00.000Z", overrides);

	test("a LEAD_IN incumbent shadowing a LIVE event is reported, not just tolerated", () => {
		const decision = decide([matinee(), party({ isActive: true })], "2026-09-26T21:00:00.000Z");

		// The decision itself is unchanged: A forbids touching either row, F forbids adding one.
		expect(decision.intended.$id).toBe(party().$id);
		expect(decision.activate).toBeNull();
		expect(decision.deactivate).toEqual([]);

		// The wording is the entire mitigation, so it has to name both rows and the consequence.
		const said = errors(decision).join(" ");
		expect(said).toMatch(/running RIGHT NOW/);
		expect(said).toContain("Matinee");
		expect(said).toContain(party().$id);
		expect(said).toMatch(/hide every alcohol item/);
	});

	test("the ordinary incumbent -- nothing else running -- stays quiet", () => {
		// Property C is about writes, but a report every fifteen minutes on a night that is going
		// fine is its own kind of damage: it buries the run that matters.
		const decision = decide([hax(), party({ isActive: true })], "2026-09-26T21:00:00.000Z");
		expect(errors(decision)).toEqual([]);
	});

	// A LEAD_IN-only successor never displaces a GRACE holder -- correct, and unchanged here. But
	// when the row being shielded is a TEST row, that rule is holding a test record on the live door
	// for up to the full four hours of grace.
	test("a TEST row shielded by its own grace is an error, not a log line", () => {
		const testNight = event("t", "Test night", "2026-09-26T19:00:00.000Z", "2026-09-26T23:00:00.000Z", {
			isActive: true,
			testing: true,
		});
		const decision = decide([testNight, party()], "2026-09-27T00:00:00.000Z");

		expect(decision.activate).toBeNull();
		expect(decision.deactivate).toEqual([]);
		expect(errors(decision).join(" ")).toMatch(/flagged TESTING/);
	});
});

// The sweep guard's second trigger. The first ("something might be running") is tested in scenario
// 6 -- but ONLY with the test row LIVE, which is the one state where the two triggers coincide.
describe("the sweep guard also fires when a TEST row would inherit the floor", () => {
	const stale_ = () => stale({ isActive: true });
	const testRow = (overrides = {}) =>
		event("tonight-test", "Tonight (test)", "2026-09-27T03:00:00.000Z", "2026-09-27T07:00:00.000Z", {
			isActive: true,
			testing: true,
			...overrides,
		});

	// LEAD_IN and GRACE are not "possibly running", so the old trigger was blind to both. The sweep
	// then subtracted the only non-test active row and Ticketing-ActiveEvent -- which falls back to
	// serving a test event rather than returning null -- put the test record on the door.
	test.each([
		["LEAD_IN", "2026-09-27T00:00:00.000Z"],
		["LIVE", "2026-09-27T05:00:00.000Z"],
		["GRACE", "2026-09-27T09:00:00.000Z"],
	])("a %s test row is never inherited by subtraction", (_state, nowIso) => {
		const rows = [stale_(), testRow()];
		const decision = decide(rows, nowIso);

		expect(decision.deactivate).toEqual([]);
		expect(decision.heldBack.id).toBe(stale().$id);
		expect(errors(decision).join(" ")).toMatch(/only a TEST event holding the floor/);

		const after = applyWrites(rows, decision, nowIso);
		expect(after.filter((row) => row.isActive && row.testing !== true)).toHaveLength(1);
	});

	// ...and the guard must not grow teeth it does not need. A quiet night with nothing active
	// afterwards still sweeps to zero -- that is scenario 7, and the whole reported incident.
	test("but a quiet night with no test row still sweeps to zero active", () => {
		const rows = [stale({ isActive: true }), hax(), party()];
		const decision = decide(rows, "2026-09-15T18:00:00.000Z");
		expect(ids(decision.deactivate)).toEqual([stale().$id]);
		expect(decision.heldBack).toBeNull();
	});

	test("and an ENDED test row is still swept like anything else", () => {
		const rows = [stale({ isActive: true }), testRow({ isActive: true })];
		const decision = decide(rows, "2026-09-27T12:00:00.000Z");
		expect(ids(decision.deactivate).sort()).toEqual([stale().$id, "tonight-test"].sort());
		expect(decision.heldBack).toBeNull();
	});
});

// Which row the guard holds back is not a detail: holding back a TEST row when a real one was
// available leaves the floor on a test record anyway, which is the outcome the guard exists to
// prevent. The rules say "hold the last active row back" without saying which one.
describe("the sweep guard holds back a REAL row in preference to a test one", () => {
	test("even when the test row finished more recently", () => {
		const rows = [
			// Ended long ago, real -- the recoverable thing to leave on the boards.
			stale({ isActive: true }),
			// Ended an hour ago, and therefore "freshest", but flagged testing.
			event("recent-test", "Recent (test)", "2026-09-26T19:00:00.000Z", "2026-09-26T23:00:00.000Z", {
				isActive: true,
				testing: true,
			}),
			// Running right now, and flagged testing -- so it can never be activated, which is what
			// makes the sweep's survivor a test row and fires the guard.
			event("live-test", "Live (test)", "2026-09-27T03:00:00.000Z", "2026-09-27T07:00:00.000Z", {
				isActive: true,
				testing: true,
			}),
		];
		const now = "2026-09-27T05:00:00.000Z";
		const decision = decide(rows, now);

		expect(decision.heldBack.id).toBe(stale().$id);
		expect(ids(decision.deactivate)).toEqual(["recent-test"]);

		const after = applyWrites(rows, decision, now);
		expect(after.filter((row) => row.isActive && row.testing !== true).map((row) => row.$id)).toEqual([
			stale().$id,
		]);
	});
});
