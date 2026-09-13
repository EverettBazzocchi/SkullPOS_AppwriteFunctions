jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const fs = require("fs");
const path = require("path");
const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const EVENTS_ID = "68e400210008d19bb5c9";
const DATABASE_ID = "67c9ffd9003d68236514";
const at = (iso) => Date.parse(iso);

// The three live rows, verified read-only against the project on 2026-09-13 -- see
// decideActiveEvent.test.js, which owns the rule coverage. This suite is about I/O: what gets read,
// what gets written, in what ORDER, and what a human sees in the Executions view afterwards.
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

function wireEvents(events) {
	mockDatabases.listDocuments.mockResolvedValue({ documents: events, total: events.length });
}

let nowSpy;
function freezeAt(iso) {
	nowSpy.mockReturnValue(at(iso));
}

describe("Admin-SetActiveEvent", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		delete process.env.ACTIVE_EVENT_AUTOPILOT;
		nowSpy = jest.spyOn(Date, "now").mockReturnValue(at("2026-09-13T22:00:00.000Z"));
		mockDatabases.updateDocument.mockResolvedValue({});
	});

	afterEach(() => {
		nowSpy.mockRestore();
	});

	// --- what it reads -------------------------------------------------------------------------

	test("pages the whole collection and never filters on isActive or testing server-side", async () => {
		wireEvents([stale(), hax(), party()]);

		await handler(makeContext({ body: {} }));

		expect(mockDatabases.listDocuments).toHaveBeenCalledWith(DATABASE_ID, EVENTS_ID, expect.any(Array));
		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toEqual(expect.arrayContaining(['orderAsc("$id")', "limit(100)"]));
		// A SQL inequality silently drops NULL rows, and Query.equal('isActive', true) would hide the
		// candidate this function exists to find. Both traps are already documented twice in this repo.
		expect(queries.join(" ")).not.toMatch(/isActive/);
		expect(queries.join(" ")).not.toMatch(/testing/);
	});

	test("follows the cursor past the first page", async () => {
		const page1 = Array.from({ length: 100 }, (_, index) => ({
			$id: `bulk-${String(index).padStart(3, "0")}`,
			name: `Bulk ${index}`,
			isActive: false,
		}));
		mockDatabases.listDocuments
			.mockResolvedValueOnce({ documents: page1 })
			.mockResolvedValueOnce({ documents: [party()] });

		const result = await handler(makeContext({ body: {} }));

		expect(mockDatabases.listDocuments).toHaveBeenCalledTimes(2);
		expect(mockDatabases.listDocuments.mock.calls[1][2]).toEqual(
			expect.arrayContaining(['cursorAfter("bulk-099")']),
		);
		expect(result.body.eventsRead).toBe(101);
	});

	test("a failed listing changes nothing and says the floor was left alone", async () => {
		mockDatabases.listDocuments.mockRejectedValue(new Error("boom"));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
		expect(result.body).toEqual({ error: "Failed to list events" });
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		expect(ctx.error).toHaveBeenCalledWith(expect.stringMatching(/left exactly as it is/i));
	});

	// --- what it writes ------------------------------------------------------------------------

	test("the live incident: the first run after deploy clears the stale test event", async () => {
		freezeAt("2026-09-13T22:15:00.000Z");
		wireEvents([stale(), hax(), party()]);

		const result = await handler(makeContext({ body: {} }));

		expect(mockDatabases.updateDocument).toHaveBeenCalledTimes(1);
		expect(mockDatabases.updateDocument).toHaveBeenCalledWith(DATABASE_ID, EVENTS_ID, stale().$id, {
			isActive: false,
		});
		expect(result.body.deactivated).toEqual([stale().$id]);
		expect(result.body.activated).toBeNull();
	});

	test("zero writes when the desired state already holds", async () => {
		freezeAt("2026-09-27T05:00:00.000Z");
		wireEvents([stale({ isActive: false }), hax(), party({ isActive: true })]);
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		expect(result.body.activated).toBeNull();
		expect(result.body.deactivated).toEqual([]);
		expect(ctx.log).toHaveBeenCalledWith(expect.stringMatching(/already holds the floor/));
	});

	test("zero writes on a quiet night with nothing stale left", async () => {
		freezeAt("2026-09-20T18:00:00.000Z");
		wireEvents([stale({ isActive: false }), hax(), party()]);
		const ctx = makeContext({ body: {} });

		await handler(ctx);

		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		expect(ctx.log).toHaveBeenCalledWith(expect.stringMatching(/no event qualifies right now/));
	});

	test("writes exactly one key -- never an echo of the row's other fields", async () => {
		freezeAt("2026-09-27T05:00:00.000Z");
		wireEvents([stale(), hax(), party()]);

		await handler(makeContext({ body: {} }));

		mockDatabases.updateDocument.mock.calls.forEach(([, , , payload]) => {
			expect(Object.keys(payload)).toEqual(["isActive"]);
		});
	});

	// ORDERING IS LOAD-BEARING. The transient between the two writes must be "two rows active",
	// never "zero rows active" -- zero mid-event hides every alcohol item and drops the door to the
	// CA$30 default.
	test("activates FIRST and deactivates SECOND", async () => {
		freezeAt("2026-09-27T05:00:00.000Z");
		wireEvents([stale(), hax(), party()]);

		await handler(makeContext({ body: {} }));

		expect(mockDatabases.updateDocument.mock.calls.map(([, , id, payload]) => [id, payload.isActive])).toEqual([
			[party().$id, true],
			[stale().$id, false],
		]);
	});

	// --- failure handling ----------------------------------------------------------------------

	test("a failed activation skips every deactivation and returns 500", async () => {
		freezeAt("2026-09-27T05:00:00.000Z");
		wireEvents([stale(), hax(), party()]);
		mockDatabases.updateDocument.mockRejectedValueOnce(new Error("write rejected"));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		// Exactly one attempt: the activation. The old event keeps the floor.
		expect(mockDatabases.updateDocument).toHaveBeenCalledTimes(1);
		expect(result.statusCode).toBe(500);
		expect(result.body.abortedAfterActivationFailure).toBe(true);
		expect(result.body.deactivated).toEqual([]);
		expect(result.body.failures).toEqual([
			{ id: party().$id, name: party().name, error: "write rejected" },
		]);
		expect(ctx.error).toHaveBeenCalledWith(expect.stringMatching(/Skipping every deactivation this run/));
	});

	test("one failed deactivation does not strand the others", async () => {
		freezeAt("2026-09-27T05:00:00.000Z");
		const otherStale = { ...hax(), isActive: true };
		wireEvents([stale(), otherStale, party({ isActive: true })]);
		mockDatabases.updateDocument
			.mockRejectedValueOnce(new Error("nope"))
			.mockResolvedValueOnce({});

		const result = await handler(makeContext({ body: {} }));

		expect(mockDatabases.updateDocument).toHaveBeenCalledTimes(2);
		expect(result.body.failures).toHaveLength(1);
		expect(result.body.deactivated).toHaveLength(1);
		expect(result.statusCode).toBe(200);
	});

	// --- the kill switch -------------------------------------------------------------------------

	test("ACTIVE_EVENT_AUTOPILOT=report computes the full decision and writes nothing", async () => {
		process.env.ACTIVE_EVENT_AUTOPILOT = "report";
		freezeAt("2026-09-27T05:00:00.000Z");
		wireEvents([stale(), hax(), party()]);
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		expect(result.body.mode).toBe("report");
		expect(result.body.wouldActivate).toBe(party().$id);
		expect(result.body.wouldDeactivate).toEqual([stale().$id]);
		expect(ctx.log).toHaveBeenCalledWith(expect.stringMatching(/autopilot is SUSPENDED/));
	});

	test("it is case- and whitespace-insensitive", async () => {
		process.env.ACTIVE_EVENT_AUTOPILOT = "  REPORT ";
		freezeAt("2026-09-27T05:00:00.000Z");
		wireEvents([stale(), hax(), party()]);

		const result = await handler(makeContext({ body: {} }));

		expect(result.body.mode).toBe("report");
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	// THE POLARITY IS THE WHOLE POINT: a typo must never silently disable the automation on the
	// night of a paying event.
	test.each([["", "blank"], ["apply", "apply"], ["reprot", "a typo"], ["on", "an inverted guess"]])(
		"ACTIVE_EVENT_AUTOPILOT=%p (%s) still applies changes",
		async (value) => {
			process.env.ACTIVE_EVENT_AUTOPILOT = value;
			freezeAt("2026-09-13T22:15:00.000Z");
			wireEvents([stale(), hax(), party()]);

			const result = await handler(makeContext({ body: {} }));

			expect(result.body.mode).toBe("apply");
			expect(result.body.deactivated).toEqual([stale().$id]);
		},
	);

	test("an unset variable applies changes", async () => {
		freezeAt("2026-09-13T22:15:00.000Z");
		wireEvents([stale(), hax(), party()]);

		const result = await handler(makeContext({ body: {} }));

		expect(result.body.mode).toBe("apply");
		expect(result.body.deactivated).toEqual([stale().$id]);
	});

	// --- what a human sees afterwards ------------------------------------------------------------

	test("every run logs one line that reconstructs the decision without the data", async () => {
		freezeAt("2026-09-27T05:00:00.000Z");
		wireEvents([stale(), hax(), party()]);
		const ctx = makeContext({ body: {} });

		await handler(ctx);

		const line = ctx.log.mock.calls.map(([message]) => message).find((message) => message.startsWith("[apply]"));
		expect(line).toContain("now=2026-09-27T05:00:00.000Z");
		expect(line).toContain("read=3");
		expect(line).toContain(`intended="${party().name}" (${party().$id})`);
		expect(line).toContain("The NB Afterparty @ Skullspace[LIVE]");
		expect(line).toContain("incumbents=0 blockers=0");
		expect(line).toContain(`willDeactivate="${stale().name}" (${stale().$id})`);
	});

	test("the response carries the structured keys the admin app and a curl read", async () => {
		freezeAt("2026-09-27T05:00:00.000Z");
		wireEvents([stale(), hax(), party()]);

		const result = await handler(makeContext({ body: {} }));

		expect(Object.keys(result.body).sort()).toEqual(
			[
				"activated",
				"ambiguous",
				"blockers",
				"candidates",
				// Null on a healthy run; a number when the run refused because the container clock is
				// behind the data. It is in the BODY and not only in the Errors view because a refusal and
				// a healthy quiet night are otherwise the same response.
				"clockSkewMs",
				"deactivated",
				"eventsRead",
				"failures",
				"graceHours",
				"heldBack",
				"incumbents",
				"leadHours",
				"mode",
				"now",
				"unreadable",
				"unscheduled",
			].sort(),
		);
		expect(result.body.leadHours).toBe(6);
		expect(result.body.graceHours).toBe(4);
		expect(result.body.clockSkewMs).toBeNull();
	});

	test("a clock-skew refusal is distinguishable from a healthy quiet night", async () => {
		// The rows were written "after" this container thinks it is now, so every start/end comparison
		// the function makes would be wrong. It writes nothing -- and, crucially, it must not report
		// that as the same thing as a Tuesday with no event on.
		freezeAt("2026-09-13T18:00:00.000Z");
		wireEvents([stale({ $updatedAt: "2026-09-13T21:42:14.318+00:00" }), hax(), party()]);

		const result = await handler(makeContext({ body: {} }));

		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		expect(result.body.clockSkewMs).toBeGreaterThan(0);
		expect(result.body.activated).toBeNull();
		expect(result.body.deactivated).toEqual([]);
	});

	test("a refusal reaches the Errors view, not just the response body", async () => {
		freezeAt("2026-09-27T05:00:00.000Z");
		// Tomorrow's event ticked active while tonight's is running: the sharpest edge in the design.
		const tomorrow = {
			...party(),
			$id: "tomorrow",
			name: "Tomorrow Night",
			isActive: true,
			startsAt: "2026-09-28T03:00:00.000Z",
			endsAt: "2026-09-28T07:00:00.000Z",
			barOpensAt: "2026-09-28T03:00:00.000Z",
			barClosesAt: "2026-09-28T07:00:00.000Z",
		};
		wireEvents([tomorrow, party()]);
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		expect(result.body.ambiguous).toBe(true);
		expect(result.body.blockers).toEqual([{ id: "tomorrow", name: "Tomorrow Night", state: "FUTURE" }]);
		expect(ctx.error).toHaveBeenCalledWith(expect.stringMatching(/running RIGHT NOW/));
	});

	// --- the structural DST guarantee --------------------------------------------------------------

	// Every comparison this function makes is instant-versus-instant. That is not a claim to be
	// re-argued each time somebody edits it -- it is checkable, so it is checked. A single
	// getHours()/toLocaleString()/"America/Winnipeg" anywhere in here reintroduces the exact class of
	// bug this codebase has already been burned by: recombining a calendar day with a wall clock.
	test("no source file constructs local time, names a timezone, or computes a calendar day", () => {
		const sources = ["main.js", "decideActiveEvent.js", "activeEventWindow.js"];
		sources.forEach((file) => {
			const raw = fs.readFileSync(path.join(__dirname, file), "utf8");
			const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
			[
				/America\//,
				/\bgetHours\b/,
				/\bsetHours\b/,
				/\bgetMinutes\b/,
				/\bgetDate\b/,
				/\bgetTimezoneOffset\b/,
				/toLocale[A-Za-z]*String/,
				/\btoDateString\b/,
			].forEach((pattern) => {
				expect(code).not.toMatch(pattern);
			});
		});
	});
});

// The registration is part of the deliverable, and it is the half that fails SILENTLY: a function
// left disabled, or pushed with an empty `schedule`, produces no execution, no log and no write --
// a symptom identical to a working autopilot that correctly decided nothing needed changing. That
// is precisely the failure this function exists to remove, so it is pinned here rather than left to
// whoever reads appwrite.config.json at 1am. (It was in fact shipped `"enabled": false` with an
// empty schedule, which is why this test exists.)
describe("appwrite.config.json registration", () => {
	const entry = JSON.parse(
		fs.readFileSync(path.join(__dirname, "..", "..", "..", "appwrite.config.json"), "utf8"),
	).functions.find((fn) => fn.$id === "admin-set-active-event");

	test("is registered at all", () => {
		expect(entry).toBeDefined();
		expect(entry.name).toBe("Admin-SetActiveEvent");
		expect(entry.path).toBe("functions/Admin-SetActiveEvent");
		expect(entry.entrypoint).toBe("src/main.js");
	});

	// Registered but DISARMED on purpose, and this test exists to keep it that way until a human
	// decides otherwise. Arming it is not a neutral act: the first run clears the stale
	// "Everetts Test event ignopre" and, with the next real event on 2026-09-26, the floor then
	// carries NO active event for thirteen days -- alcohol hidden on the register and both boards,
	// and the door back to its default ticket price. That may well be the correct end state, but it
	// is an operator's decision made with their eyes open, not something a deploy does quietly.
	//
	// To arm it: set enabled true and schedule "*/15 * * * *" here, update this test in the same
	// commit so the intent is recorded, push the config, then confirm a "trigger":"schedule"
	// execution actually appears -- crons only register on deploy, and an unregistered schedule
	// looks exactly like one that correctly decided nothing needed changing.
	test("is registered DISARMED until deliberately enabled", () => {
		expect(entry.enabled).toBe(false);
		expect(entry.schedule).toBe("");
	});

	test("can read and write documents, and a human can run it by hand", () => {
		// The cron is a convenience on this install, not the guarantee -- until a
		// "trigger":"schedule" execution has been observed, create-execution by an admin is the
		// actual mechanism, which is what `execute` is for.
		expect(entry.scopes.sort()).toEqual(["documents.read", "documents.write"]);
		expect(entry.execute).toContain("team:68e35aed00144b8cde9d");
		expect(entry.events).toEqual([]);
		expect(entry.runtime).toBe("node-16.0");
	});
});
