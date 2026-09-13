jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const EVENTS_ID = "68e400210008d19bb5c9";
const CATEGORIES_ID = "67c9ffdd0039c4e09c9a";
const INGREDIENTS_ID = "ingredients";
const TRANSACTIONS_ID = "68e4cd3500179ce661c6";
const TICKETS_ID = "tickets";

const pastEvent = (id, overrides = {}) => ({
	$id: id,
	name: "Past Event",
	date: "2020-01-01T01:00:00.000Z", // always in the past relative to any test run
	barOpenTime: "19:00",
	barCloseTime: "04:00",
	...overrides,
});

const futureEvent = (id) => ({
	$id: id,
	name: "Future Event",
	date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
	barOpenTime: "19:00",
	barCloseTime: "04:00",
});

function wireCollections({ events = [], categories = [], ingredients = [], transactions = [], tickets = [] } = {}) {
	mockDatabases.listDocuments.mockImplementation((dbId, collectionId) => {
		if (collectionId === EVENTS_ID) return Promise.resolve({ documents: events });
		if (collectionId === CATEGORIES_ID) return Promise.resolve({ documents: categories });
		if (collectionId === INGREDIENTS_ID) return Promise.resolve({ documents: ingredients });
		if (collectionId === TRANSACTIONS_ID) return Promise.resolve({ documents: transactions });
		if (collectionId === TICKETS_ID) return Promise.resolve({ documents: tickets });
		return Promise.resolve({ documents: [] });
	});
}

describe("Admin-RollupEventSales", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	test("does nothing when there are no events with a completed window", async () => {
		wireCollections({ events: [futureEvent("e1")] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body).toEqual({ processed: 0, updated: [], failures: [], skipped: [], needsReview: [] });
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("skips an event with no date, silently", async () => {
		wireCollections({ events: [{ $id: "no-date", name: "No Date", barOpenTime: "19:00", barCloseTime: "04:00" }] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body).toEqual({ processed: 0, updated: [], failures: [], skipped: [], needsReview: [] });
	});

	test("reports (and does not zero out) an event whose window is degenerate", async () => {
		// open === close is a 0-length window: it matches no transactions, and writing that result
		// would overwrite the event's real figures with zeroes and count as a success.
		wireCollections({ events: [pastEvent("degenerate", { barOpenTime: "20:00", barCloseTime: "20:00" })] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.processed).toBe(0);
		expect(result.body.skipped).toEqual([{ id: "degenerate", name: "Past Event", reason: expect.stringMatching(/no usable sales window/i) }]);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	// --- the migrated time model ---------------------------------------------------------------

	test("rolls up an event that carries only the new timestamps and no legacy date", async () => {
		wireCollections({
			events: [
				{
					$id: "migrated",
					name: "Migrated Event",
					startsAt: "2020-01-01T01:00:00.000Z",
					endsAt: "2020-01-01T10:00:00.000Z",
					barOpensAt: "2020-01-01T01:00:00.000Z",
					barClosesAt: "2020-01-01T10:00:00.000Z",
				},
			],
			transactions: [{ cart: JSON.stringify([{ name: "Beer", price: 500, quantity: 2, alcohol: true }]), tip: 100, discount: 0, total: 1100, payment_due: 1100 }],
		});
		mockDatabases.updateDocument.mockResolvedValue({});

		const result = await handler(makeContext({ body: {} }));

		expect(result.body.processed).toBe(1);
		expect(result.body.updated).toEqual(["migrated"]);
		expect(result.body.skipped).toEqual([]);
	});

	// A fully-migrated row whose window is unusable still has to be REPORTED, not silently ignored
	// the way a never-scheduled draft is -- the old `event.date` test would have dropped it.
	test("reports a fully-migrated event whose window is degenerate instead of ignoring it", async () => {
		wireCollections({
			events: [{ $id: "degenerate-new", name: "Migrated Event", startsAt: "2020-01-01T01:00:00.000Z", endsAt: "2020-01-01T01:00:00.000Z" }],
		});

		const result = await handler(makeContext({ body: {} }));

		expect(result.body.processed).toBe(0);
		expect(result.body.skipped).toEqual([
			{ id: "degenerate-new", name: "Migrated Event", reason: expect.stringMatching(/no usable sales window/i) },
		]);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("leaves an event alone while its new-field window is still open", async () => {
		wireCollections({
			events: [
				{
					$id: "running",
					name: "Tonight",
					startsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
					endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
				},
			],
		});

		const result = await handler(makeContext({ body: {} }));

		expect(result.body).toEqual({ processed: 0, updated: [], failures: [], skipped: [], needsReview: [] });
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("rolls up sales for a past event and writes them onto the event document", async () => {
		const transactions = [
			{
				cart: JSON.stringify([{ name: "Beer", price: 500, quantity: 2, alcohol: true }]),
				tip: 100,
				discount: 0,
				total: 1100,
				payment_due: 1100,
			},
		];
		wireCollections({ events: [pastEvent("e1")], transactions });
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.processed).toBe(1);
		expect(result.body.updated).toEqual(["e1"]);
		expect(result.body.failures).toEqual([]);
		expect(mockDatabases.updateDocument).toHaveBeenCalledWith(
			expect.any(String),
			EVENTS_ID,
			"e1",
			expect.objectContaining({ alcohol_sales: 1000, tips_earned: 100, cash_sales: 1100, pos_revenue: 1100, revenue: 1100, profit: 1100 })
		);
	});

	describe("membership dues are not bar revenue", () => {
		test("a dues payment rung up during the event is left out of the event's figures", async () => {
			// The Sales Report already treats `membership` as a separable non-sales channel; rolling
			// it into revenue/profit here made the two consumers disagree about the same $40.
			wireCollections({
				events: [pastEvent("e1")],
				transactions: [
					{ cart: JSON.stringify([]), tip: 0, discount: 0, total: 1000, payment_due: 1000, channel: "pos" },
					{ cart: JSON.stringify([]), tip: 0, discount: 0, total: 4000, payment_due: 4000, channel: "membership" },
				],
			});
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			await handler(ctx);

			expect(mockDatabases.updateDocument).toHaveBeenCalledWith(
				expect.any(String),
				EVENTS_ID,
				"e1",
				expect.objectContaining({ pos_revenue: 1000, revenue: 1000, cash_sales: 1000 })
			);
		});

		test("still counts the legacy rows whose channel was never set", async () => {
			// `channel` is NULL on 986 of 1,056 rows -- excluding dues with a Query.notEqual would
			// have dropped every one of those real POS sales along with them.
			wireCollections({
				events: [pastEvent("e1")],
				transactions: [{ cart: JSON.stringify([]), tip: 0, discount: 0, total: 1000, payment_due: 1000 }],
			});
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			await handler(ctx);

			expect(mockDatabases.updateDocument).toHaveBeenCalledWith(
				expect.any(String),
				EVENTS_ID,
				"e1",
				expect.objectContaining({ pos_revenue: 1000 })
			);
		});
	});

	describe("card_sales_incl_tips -- what Stripe actually deposited", () => {
		const tippedCardSale = {
			cart: JSON.stringify([]),
			tip: 100,
			discount: 0,
			total: 750,
			payments: JSON.stringify([{ method: "stripe", amount: 750, stripeId: "pi_1", tip: 100 }]),
		};

		function writesFor(eventId) {
			return mockDatabases.updateDocument.mock.calls.filter((c) => c[1] === EVENTS_ID && c[2] === eventId).map((c) => c[3]);
		}

		test("is written alongside the tip-exclusive figures", async () => {
			wireCollections({ events: [pastEvent("e1")], transactions: [tippedCardSale] });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			await handler(ctx);

			const writes = writesFor("e1");
			expect(writes).toContainEqual(expect.objectContaining({ card_sales: 750, tips_earned: 100, pos_revenue: 750 }));
			expect(writes).toContainEqual({ card_sales_incl_tips: 850 });
			// the non-schema helper value must never reach the document
			writes.forEach((write) => expect(write).not.toHaveProperty("card_tips"));
		});

		test("a project without the attribute yet still gets its real figures, and is told once", async () => {
			// Deploy order must not matter: until the attribute is created, this write is rejected,
			// and a rejected supplemental write must not cost the event the figures that do exist.
			wireCollections({ events: [pastEvent("e1"), pastEvent("e2")], transactions: [tippedCardSale] });
			mockDatabases.updateDocument.mockImplementation((_db, _col, _id, data) =>
				"card_sales_incl_tips" in data ? Promise.reject(new Error("Unknown attribute: card_sales_incl_tips")) : Promise.resolve({})
			);
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.updated).toEqual(["e1", "e2"]);
			expect(result.body.failures).toEqual([]);
			expect(writesFor("e2")).toEqual([expect.objectContaining({ card_sales: 750 })]); // not retried
			expect(ctx.error).toHaveBeenCalledTimes(1);
			expect(ctx.error.mock.calls[0][0]).toMatch(/card_sales_incl_tips/);
		});
	});

	test("combines ticket sales into revenue and profit, keeping pos_revenue as the POS-only figure", async () => {
		const transactions = [{ cart: JSON.stringify([]), tip: 0, discount: 0, total: 1000, payment_due: 1000 }];
		const tickets = [
			{ eventName: "Past Event", status: "VALID", price: 2000 },
			{ eventName: "Past Event", status: "USED", price: 1500 },
			{ eventName: "Past Event", status: "CANCELLED", price: 9999 }, // excluded
			{ eventName: "Past Event", status: "VALID", price: 500, paymentMode: "TEST" }, // excluded
		];
		wireCollections({ events: [pastEvent("e1")], transactions, tickets });
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: {} });

		await handler(ctx);

		expect(mockDatabases.updateDocument).toHaveBeenCalledWith(
			expect.any(String),
			EVENTS_ID,
			"e1",
			expect.objectContaining({ pos_revenue: 1000, revenue: 1000 + 2000 + 1500, cogs: 0, profit: 1000 + 2000 + 1500 })
		);
	});

	test("queries tickets scoped to the event's exact name", async () => {
		wireCollections({ events: [pastEvent("e1")], transactions: [] });
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: {} });

		await handler(ctx);

		const ticketsCall = mockDatabases.listDocuments.mock.calls.find((call) => call[1] === TICKETS_ID);
		expect(ticketsCall[2]).toContain('equal("eventName", "Past Event")');
	});

	test("queries transactions scoped to the event's computed window and only complete, non-test ones", async () => {
		wireCollections({ events: [pastEvent("e1")], transactions: [] });
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: {} });

		await handler(ctx);

		const transactionsCall = mockDatabases.listDocuments.mock.calls.find((call) => call[1] === TRANSACTIONS_ID);
		const queries = transactionsCall[2];
		expect(queries).toContain('equal("status", "complete")');
		expect(queries).toContain('notEqual("testing", true)');
		expect(queries.some((q) => q.startsWith("greaterThanEqual"))).toBe(true);
		expect(queries.some((q) => q.startsWith("lessThanEqual"))).toBe(true);
	});

	describe("the window the transaction query is scoped to", () => {
		function windowOf(result) {
			const call = mockDatabases.listDocuments.mock.calls.find((c) => c[1] === TRANSACTIONS_ID);
			const from = call[2].find((q) => q.startsWith("greaterThanEqual"));
			const to = call[2].find((q) => q.startsWith("lessThanEqual"));
			const iso = (q) => q.match(/"([^"]+T[^"]+)"/)[1];
			return new Date(iso(to)).getTime() - new Date(iso(from)).getTime();
		}

		test("comes from the admin-editable bar hours, not from event_start/event_end", async () => {
			// The admin app writes only barOpenTime/barCloseTime -- event_start/event_end are not
			// editable anywhere, so honouring them meant shortening an event's bar hours moved
			// Verify-Pin's window and left this one frozen, folding the tail into the event.
			wireCollections({ events: [pastEvent("e1", { barOpenTime: "22:00", barCloseTime: "02:00", event_start: 22, event_end: 4 })] });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.updated).toEqual(["e1"]);
			expect(windowOf(result)).toBe(4 * 60 * 60 * 1000); // bar hours, not the 6h event_start/end span
		});

		test("falls back to event_start/event_end for a row with no bar hours set", async () => {
			wireCollections({ events: [pastEvent("e1", { barOpenTime: null, barCloseTime: null, event_start: 8, event_end: 3 })] });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			await handler(ctx);

			expect(windowOf()).toBe(7 * 60 * 60 * 1000);
		});
	});

	describe("attributing tickets when the same event name runs more than once", () => {
		const occurrence = (id, dateIso) => ({
			$id: id,
			name: "Goth Night",
			date: dateIso,
			barOpenTime: "22:00",
			barCloseTime: "02:00",
		});

		function ticketQueriesFor(callIndex) {
			return mockDatabases.listDocuments.mock.calls.filter((c) => c[1] === TICKETS_ID)[callIndex][2];
		}

		test("a name that occurs once is matched with no date bound at all", async () => {
			// Unbounded is what keeps a LATE-written ticket counted -- a door sale rung up after
			// close, or a Zeffy payment recovered days later by Admin-VerifyZeffyTickets.
			wireCollections({ events: [pastEvent("e1")], transactions: [] });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			await handler(ctx);

			const queries = ticketQueriesFor(0);
			expect(queries.some((q) => q.startsWith("greaterThanEqual") || q.startsWith("lessThanEqual"))).toBe(false);
		});

		test("two occurrences split the timeline between them instead of each counting the other's tickets", async () => {
			const first = occurrence("jan", "2020-01-05T22:00:00.000Z");
			const second = occurrence("feb", "2020-02-05T22:00:00.000Z");
			wireCollections({ events: [first, second], transactions: [] });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.updated).toEqual(["jan", "feb"]);
			const janQueries = ticketQueriesFor(0);
			const febQueries = ticketQueriesFor(1);
			// January is bounded above only, February below only -- the same midpoint instant.
			const janUpper = janQueries.find((q) => q.startsWith("lessThanEqual"));
			const febLower = febQueries.find((q) => q.startsWith("greaterThanEqual"));
			expect(janUpper).toBeDefined();
			expect(febLower).toBeDefined();
			expect(janQueries.some((q) => q.startsWith("greaterThanEqual"))).toBe(false);
			expect(febQueries.some((q) => q.startsWith("lessThanEqual"))).toBe(false);
			// the same split instant, with February starting 1ms after January's inclusive bound
			const msOf = (q) => new Date(q.match(/"([^"]+T[^"]+)"/)[1]).getTime();
			expect(msOf(febLower) - msOf(janUpper)).toBe(1);
		});

		test("a still-future occurrence still bounds the past one", async () => {
			const past = occurrence("past", "2020-01-05T22:00:00.000Z");
			const future = occurrence("future", new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
			wireCollections({ events: [past, future], transactions: [] });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.updated).toEqual(["past"]);
			expect(ticketQueriesFor(0).some((q) => q.startsWith("lessThanEqual"))).toBe(true);
		});
	});

	test("refuses to erase an event's recorded ticket revenue when the name no longer matches any ticket", async () => {
		// The tickets keep the old eventName after a rename; the write below is an unconditional
		// overwrite, so this used to zero out real, already-banked ticket revenue with nothing
		// logged.
		wireCollections({
			events: [pastEvent("renamed", { name: "HAX 7.0 EDM Community Nite", revenue: 81384, pos_revenue: 61650 })],
			transactions: [],
			tickets: [],
		});
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		expect(result.body.updated).toEqual([]);
		expect(result.body.needsReview).toEqual([{ id: "renamed", name: "HAX 7.0 EDM Community Nite", reason: expect.stringMatching(/renamed/i) }]);
	});

	test("still rolls up an event that has recorded revenue but never had any ticket revenue", async () => {
		wireCollections({
			events: [pastEvent("pos-only", { revenue: 61650, pos_revenue: 61650 })],
			transactions: [{ cart: JSON.stringify([]), tip: 0, discount: 0, total: 1000, payment_due: 1000 }],
			tickets: [],
		});
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.updated).toEqual(["pos-only"]);
		expect(result.body.needsReview).toEqual([]);
	});

	test("processes multiple due events independently and reports per-event failures", async () => {
		wireCollections({ events: [pastEvent("good"), pastEvent("bad")], transactions: [] });
		mockDatabases.updateDocument.mockImplementation((_db, _col, id) =>
			id === "bad" ? Promise.reject(new Error("locked")) : Promise.resolve({})
		);
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.processed).toBe(2);
		expect(result.body.updated).toEqual(["good"]);
		expect(result.body.failures).toEqual([{ id: "bad", name: "Past Event", error: "locked" }]);
	});

	test("surfaces a 500 if listing events fails", async () => {
		mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});
});
