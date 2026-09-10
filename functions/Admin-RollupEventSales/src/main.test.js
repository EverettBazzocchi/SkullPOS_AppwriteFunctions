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
	event_start: 7,
	event_end: 4,
	...overrides,
});

const futureEvent = (id) => ({
	$id: id,
	name: "Future Event",
	date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
	event_start: 7,
	event_end: 4,
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
		expect(result.body).toEqual({ processed: 0, updated: [], failures: [] });
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("skips an event with no date", async () => {
		wireCollections({ events: [{ $id: "no-date", name: "No Date", event_start: 7, event_end: 4 }] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body).toEqual({ processed: 0, updated: [], failures: [] });
	});

	test("rolls up sales for a past event and writes them onto the event document", async () => {
		const transactions = [
			{
				cart: JSON.stringify([{ name: "Beer", price: 500, quantity: 2, alcohol: true }]),
				tip: 100,
				discount: 0,
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

	test("combines ticket sales into revenue and profit, keeping pos_revenue as the POS-only figure", async () => {
		const transactions = [{ cart: JSON.stringify([]), tip: 0, discount: 0, payment_due: 1000 }];
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
