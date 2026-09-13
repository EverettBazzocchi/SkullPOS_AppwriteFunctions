const { planBackfill } = require("./backfill-ticket-event-ids.js");

// The backfill's decision rules, tested without a network. A wrong id here silently moves a
// ticket's revenue onto the wrong event in Admin-RollupEventSales, so "refuses to guess" is the
// property that actually matters -- more than how many rows it manages to fill in.

const EVENTS = [
	{ $id: "6a9a44984ca3104e2efc", name: "HAX 7.0 EDM Community Night" },
	{ $id: "6a9a44984028f75b0052", name: "Everetts Test event ignopre" },
	{ $id: "6aa08566ea9606801071", name: "The NB Afterparty @ Skullspace" },
];

const ticket = (id, eventName, extra = {}) => ({ $id: id, eventName, ...extra });

describe("backfill-ticket-event-ids", () => {
	test("plans an update for a ticket whose event name matches exactly one event", () => {
		const { planned } = planBackfill([ticket("t1", "HAX 7.0 EDM Community Night")], EVENTS);

		expect(planned).toHaveLength(1);
		expect(planned[0].eventId).toBe("6a9a44984ca3104e2efc");
		expect(planned[0].ticket.$id).toBe("t1");
	});

	test("skips a ticket that already has an eventId instead of recomputing or overwriting it", () => {
		const alreadyDone = ticket("t1", "HAX 7.0 EDM Community Night", { eventId: "6a9a44984ca3104e2efc" });
		// Even a row whose stored id disagrees with the name is left alone -- this script's job is
		// to fill in blanks, never to arbitrate a conflict a human has not looked at.
		const disagreeing = ticket("t2", "HAX 7.0 EDM Community Night", { eventId: "some-other-event" });

		const { planned, skippedAlreadySet } = planBackfill([alreadyDone, disagreeing], EVENTS);

		expect(planned).toHaveLength(0);
		expect(skippedAlreadySet).toEqual(["t1", "t2"]);
	});

	// Idempotency, stated as the property rather than the implementation: feeding the first run's
	// own output back in plans nothing.
	test("running it twice is a no-op the second time", () => {
		const tickets = [ticket("t1", "HAX 7.0 EDM Community Night"), ticket("t2", "Everetts Test event ignopre")];

		const first = planBackfill(tickets, EVENTS);
		expect(first.planned).toHaveLength(2);

		const afterWriting = first.planned.map((p) => ({ ...p.ticket, eventId: p.eventId }));
		const second = planBackfill(afterWriting, EVENTS);

		expect(second.planned).toHaveLength(0);
		expect(second.skippedAlreadySet).toEqual(["t1", "t2"]);
	});

	test("a partially applied run retries only the rows still missing an id", () => {
		const tickets = [
			ticket("t1", "HAX 7.0 EDM Community Night", { eventId: "6a9a44984ca3104e2efc" }), // written last time
			ticket("t2", "HAX 7.0 EDM Community Night"), // the PATCH that failed
		];

		const { planned } = planBackfill(tickets, EVENTS);

		expect(planned.map((p) => p.ticket.$id)).toEqual(["t2"]);
	});

	test("reports a name that matches no event rather than attaching it to something", () => {
		const { planned, byName, unresolved } = planBackfill([ticket("t1", "Door Sales")], EVENTS);

		expect(planned).toHaveLength(0);
		expect(unresolved).toBe(1);
		expect(byName.get("Door Sales").verdict).toContain("NO MATCHING EVENT");
	});

	test("refuses to choose when two events share a name", () => {
		const duplicateNames = [...EVENTS, { $id: "evtDupe", name: "HAX 7.0 EDM Community Night" }];

		const { planned, byName } = planBackfill([ticket("t1", "HAX 7.0 EDM Community Night")], duplicateNames);

		expect(planned).toHaveLength(0);
		expect(byName.get("HAX 7.0 EDM Community Night").verdict).toContain("AMBIGUOUS");
		expect(byName.get("HAX 7.0 EDM Community Night").verdict).toContain("evtDupe");
	});

	// Exact matches only. Every one of these is a plausible-looking near miss, and each would move
	// real money between events in the rollup if it were accepted.
	test.each([
		["trailing whitespace", "HAX 7.0 EDM Community Night "],
		["different case", "hax 7.0 edm community night"],
		["a prefix", "HAX 7.0"],
		["extra words", "HAX 7.0 EDM Community Night 2026"],
	])("does not match on %s", (_label, eventName) => {
		const { planned, unresolved } = planBackfill([ticket("t1", eventName)], EVENTS);

		expect(planned).toHaveLength(0);
		expect(unresolved).toBe(1);
	});

	test("skips a ticket with no event name at all", () => {
		const { planned, byName } = planBackfill([{ $id: "t1" }, ticket("t2", "")], EVENTS);

		expect(planned).toHaveLength(0);
		expect(byName.get("(no eventName)").total).toBe(2);
		expect(byName.get("(no eventName)").verdict).toContain("NO EVENT NAME");
	});

	// The shape of the live data on 2026-09-13, which is what --expect-updates is set from: 107 +
	// 95 resolvable, 2 rows that match no event and never will.
	test("the live 2026-09-13 shape plans 202 updates and leaves 2 unresolved", () => {
		const tickets = [
			...Array.from({ length: 107 }, (_, i) => ticket(`hax${i}`, "HAX 7.0 EDM Community Night")),
			...Array.from({ length: 95 }, (_, i) => ticket(`test${i}`, "Everetts Test event ignopre")),
			ticket("door1", "Door Sales"),
			ticket("idem1", "Idempotency Test Event"),
		];

		const { planned, unresolved, byName } = planBackfill(tickets, EVENTS);

		expect(planned).toHaveLength(202);
		expect(unresolved).toBe(2);
		expect(byName.get("HAX 7.0 EDM Community Night").willUpdate).toBe(107);
		expect(byName.get("Everetts Test event ignopre").willUpdate).toBe(95);
	});
});
