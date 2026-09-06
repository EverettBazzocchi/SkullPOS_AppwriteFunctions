jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, mockUsers, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const CATEGORIES_ID = "67c9ffdd0039c4e09c9a";
const INGREDIENTS_ID = "ingredients";
const TRANSACTIONS_ID = "68e4cd3500179ce661c6";
const STAFF_TEAM_ID = "68e35aed00144b8cde9d";

const cartJson = (items) => JSON.stringify(items);

/**
 * Wires listDocuments to serve fixed fixtures per collection, and (for
 * Transactions specifically) a different set depending on which date
 * range was actually queried -- so "current period" vs "previous period"
 * calls can be told apart the same way the real Databases API would let
 * you tell them apart (by what was actually asked for).
 */
function wireCollections({ categories = [], ingredients = [], transactionsByRangeStart = {} } = {}) {
	mockDatabases.listDocuments.mockImplementation((dbId, collectionId, queries) => {
		if (collectionId === CATEGORIES_ID) return Promise.resolve({ documents: categories });
		if (collectionId === INGREDIENTS_ID) return Promise.resolve({ documents: ingredients });
		if (collectionId === TRANSACTIONS_ID) {
			// Match on the greaterThanEqual (range start) clause specifically --
			// a naive "does any query string mention this date" check is wrong
			// because the previous period's lessThanEqual (its end) is the same
			// timestamp as the current period's start.
			const rangeKey = Object.keys(transactionsByRangeStart).find((startIso) =>
				queries.some((q) => q.startsWith("greaterThanEqual") && q.includes(startIso)),
			);
			return Promise.resolve({ documents: rangeKey ? transactionsByRangeStart[rangeKey] : [] });
		}
		return Promise.resolve({ documents: [] });
	});
}

describe("Sales-Report", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	test("aggregates sale volume, category breakdown, and per-leg payment totals correctly", async () => {
		const start = "2026-01-01T00:00:00.000Z";
		const end = "2026-01-02T00:00:00.000Z";
		wireCollections({
			categories: [
				{ $id: "cat-food", name: "Food", alcohol: false },
				{ $id: "cat-na", name: "Non-Alcoholic Drinks", alcohol: false },
			],
			transactionsByRangeStart: {
				[start]: [
					{
						cart: cartJson([
							{ name: "Beer", quantity: 2, price: 700, alcohol: true },
							{ name: "Burger", quantity: 1, price: 1200, categories: "cat-food" },
						]),
						total: 2600,
						discount: 0,
						tip: 100,
						payments: JSON.stringify([
							{ method: "cash", amount: 1600 },
							{ method: "stripe", amount: 1000, stripeId: "pi_1" },
						]),
					},
					{
						cart: cartJson([{ name: "Soda", quantity: 1, price: 300, categories: "cat-na" }]),
						total: 300,
						discount: 0,
						tip: 0,
						payments: JSON.stringify([{ method: "giftcard", amount: 300, giftcardId: "gc1" }]),
					},
				],
			},
		});
		mockUsers.listMemberships.mockResolvedValue({ memberships: [] }); // non-staff
		const ctx = makeContext({
			body: { startDate: start, endDate: end, test: true },
			headers: { "x-appwrite-user-id": "u1" },
		});

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body.totalSales).toBe(2900);
		expect(result.body.alcoholAmount).toBe(1400);
		expect(result.body.foodAmount).toBe(1200);
		expect(result.body.nonAlcoholicDrinksAmount).toBe(300);
		expect(result.body.tips).toBe(100);
		// per-leg, not per-transaction: cash+card from txn 1, giftcard from txn 2
		expect(result.body.cashAmount).toBe(1600);
		expect(result.body.cardAmount).toBe(1000);
		expect(result.body.giftcardAmount).toBe(300);
		expect(result.body.amountPaid).toBe(2900);
		expect(result.body.ItemsSold).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "Beer", quantity: 2, revenue: 1400 }),
				expect.objectContaining({ name: "Burger", quantity: 1, revenue: 1200 }),
				expect.objectContaining({ name: "Soda", quantity: 1, revenue: 300 }),
			]),
		);
	});

	test("clamps a non-staff caller's start date to 24h before the end date, ignoring what was requested", async () => {
		const end = "2026-01-10T00:00:00.000Z";
		const requestedStart = "2020-01-01T00:00:00.000Z"; // years back
		const clampedStart = new Date(new Date(end).getTime() - 24 * 60 * 60 * 1000).toISOString();
		wireCollections({ transactionsByRangeStart: { [clampedStart]: [] } });
		mockUsers.listMemberships.mockResolvedValue({ memberships: [] });
		const ctx = makeContext({
			body: { startDate: requestedStart, endDate: end, test: true },
			headers: { "x-appwrite-user-id": "u1" },
		});

		const result = await handler(ctx);

		expect(result.body.restricted).toBe(true);
		// the mock only has a fixture keyed by the CLAMPED start -- if the
		// handler had used the far-past requested start instead, this call
		// wouldn't match it and the assertion below would see the default [].
		const transactionCalls = mockDatabases.listDocuments.mock.calls.filter((c) => c[1] === TRANSACTIONS_ID);
		expect(transactionCalls.some((c) => c[2].some((q) => q.includes(clampedStart)))).toBe(true);
		expect(transactionCalls.some((c) => c[2].some((q) => q.includes(requestedStart)))).toBe(false);
	});

	test("a confirmed staff team member is not clamped and gets the exact requested range", async () => {
		const start = "2020-01-01T00:00:00.000Z";
		const end = "2026-01-10T00:00:00.000Z";
		wireCollections({ transactionsByRangeStart: { [start]: [] } });
		mockUsers.listMemberships.mockResolvedValue({
			memberships: [{ teamId: STAFF_TEAM_ID, confirm: true }],
		});
		const ctx = makeContext({
			body: { startDate: start, endDate: end, test: true },
			headers: { "x-appwrite-user-id": "staff-1" },
		});

		const result = await handler(ctx);

		expect(result.body.restricted).toBe(false);
		const transactionCalls = mockDatabases.listDocuments.mock.calls.filter((c) => c[1] === TRANSACTIONS_ID);
		expect(transactionCalls.some((c) => c[2].some((q) => q.includes(start)))).toBe(true);
	});

	test("an unconfirmed (pending invite) team membership does not count as staff", async () => {
		wireCollections({ transactionsByRangeStart: {} });
		mockUsers.listMemberships.mockResolvedValue({
			memberships: [{ teamId: STAFF_TEAM_ID, confirm: false }],
		});
		const ctx = makeContext({
			body: { endDate: "2026-01-10T00:00:00.000Z", test: true },
			headers: { "x-appwrite-user-id": "pending-1" },
		});

		const result = await handler(ctx);

		expect(result.body.restricted).toBe(true);
	});

	test("a Users API failure fails CLOSED (treated as non-staff), not open", async () => {
		wireCollections({ transactionsByRangeStart: {} });
		mockUsers.listMemberships.mockRejectedValue(new Error("service unavailable"));
		const ctx = makeContext({
			body: { endDate: "2026-01-10T00:00:00.000Z", test: true },
			headers: { "x-appwrite-user-id": "u1" },
		});

		const result = await handler(ctx);

		expect(result.body.restricted).toBe(true);
	});

	test("no caller id at all is treated as non-staff", async () => {
		wireCollections({ transactionsByRangeStart: {} });
		const ctx = makeContext({ body: { endDate: "2026-01-10T00:00:00.000Z", test: true }, headers: {} });

		const result = await handler(ctx);

		expect(result.body.restricted).toBe(true);
		expect(mockUsers.listMemberships).not.toHaveBeenCalled();
	});

	describe("the `previous` comparison period", () => {
		test("staff with a bounded range gets a previous-period comparison", async () => {
			const start = "2026-01-08T00:00:00.000Z";
			const end = "2026-01-09T00:00:00.000Z"; // 1 day range
			const prevStart = "2026-01-07T00:00:00.000Z"; // the equal-length period right before
			wireCollections({
				transactionsByRangeStart: {
					[start]: [{ cart: "[]", total: 500, discount: 0, tip: 0, payments: JSON.stringify([{ method: "cash", amount: 500 }]) }],
					[prevStart]: [{ cart: "[]", total: 200, discount: 0, tip: 0, payments: JSON.stringify([{ method: "cash", amount: 200 }]) }],
				},
			});
			mockUsers.listMemberships.mockResolvedValue({ memberships: [{ teamId: STAFF_TEAM_ID, confirm: true }] });
			const ctx = makeContext({
				body: { startDate: start, endDate: end, test: true },
				headers: { "x-appwrite-user-id": "staff-1" },
			});

			const result = await handler(ctx);

			expect(result.body.totalSales).toBe(500);
			expect(result.body.previous).not.toBeNull();
			expect(result.body.previous.totalSales).toBe(200);
		});

		test("a non-staff (restricted) caller never gets a previous period, even with the same shape of request", async () => {
			const start = "2026-01-08T00:00:00.000Z";
			const end = "2026-01-09T00:00:00.000Z";
			wireCollections({ transactionsByRangeStart: { [start]: [] } });
			mockUsers.listMemberships.mockResolvedValue({ memberships: [] });
			const ctx = makeContext({
				body: { startDate: start, endDate: end, test: true },
				headers: { "x-appwrite-user-id": "u1" },
			});

			const result = await handler(ctx);

			expect(result.body.previous).toBeNull();
		});

		test("staff requesting 'All Time' (no startDate) gets no previous period either -- nothing equal-length to compare", async () => {
			wireCollections({ transactionsByRangeStart: {} });
			mockUsers.listMemberships.mockResolvedValue({ memberships: [{ teamId: STAFF_TEAM_ID, confirm: true }] });
			const ctx = makeContext({
				body: { endDate: "2026-01-10T00:00:00.000Z", test: true },
				headers: { "x-appwrite-user-id": "staff-1" },
			});

			const result = await handler(ctx);

			expect(result.body.previous).toBeNull();
		});
	});

	test("returns a zeroed report shape when there are no transactions in range", async () => {
		wireCollections({ transactionsByRangeStart: {} });
		mockUsers.listMemberships.mockResolvedValue({ memberships: [] });
		const ctx = makeContext({
			body: { startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-01-02T00:00:00.000Z", test: true },
			headers: { "x-appwrite-user-id": "u1" },
		});

		const result = await handler(ctx);

		expect(result.body.totalSales).toBe(0);
		expect(result.body.ItemsSold).toEqual([]);
	});

	test("a transaction with unparseable cart JSON doesn't crash the whole report", async () => {
		const start = "2026-01-01T00:00:00.000Z";
		wireCollections({
			transactionsByRangeStart: {
				[start]: [{ cart: "{not valid json", total: 100, discount: 0, tip: 0, payments: JSON.stringify([{ method: "cash", amount: 100 }]) }],
			},
		});
		mockUsers.listMemberships.mockResolvedValue({ memberships: [] });
		const ctx = makeContext({
			body: { startDate: start, endDate: "2026-01-02T00:00:00.000Z", test: true },
			headers: { "x-appwrite-user-id": "u1" },
		});

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body.totalSales).toBe(100);
		expect(result.body.ItemsSold).toEqual([]);
	});

	test("selects testing:true vs testing:false based on the test flag", async () => {
		wireCollections({ transactionsByRangeStart: {} });
		mockUsers.listMemberships.mockResolvedValue({ memberships: [] });

		await handler(
			makeContext({
				body: { startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-01-02T00:00:00.000Z", test: true },
				headers: { "x-appwrite-user-id": "u1" },
			}),
		);
		let call = mockDatabases.listDocuments.mock.calls.find((c) => c[1] === TRANSACTIONS_ID);
		expect(call[2]).toContain('equal("testing", true)');

		resetAppwriteMocks();
		wireCollections({ transactionsByRangeStart: {} });
		mockUsers.listMemberships.mockResolvedValue({ memberships: [] });
		await handler(
			makeContext({
				body: { startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-01-02T00:00:00.000Z", test: false },
				headers: { "x-appwrite-user-id": "u1" },
			}),
		);
		call = mockDatabases.listDocuments.mock.calls.find((c) => c[1] === TRANSACTIONS_ID);
		expect(call[2]).toContain('notEqual("testing", true)');
	});

	describe("channel filter (self-checkout vs POS comparison)", () => {
		test("channel:'self_checkout' in the request adds a matching query filter", async () => {
			wireCollections({ transactionsByRangeStart: {} });
			mockUsers.listMemberships.mockResolvedValue({ memberships: [] });
			await handler(
				makeContext({
					body: {
						startDate: "2026-01-01T00:00:00.000Z",
						endDate: "2026-01-02T00:00:00.000Z",
						test: true,
						channel: "self_checkout",
					},
					headers: { "x-appwrite-user-id": "u1" },
				}),
			);

			const call = mockDatabases.listDocuments.mock.calls.find((c) => c[1] === TRANSACTIONS_ID);
			expect(call[2]).toContain('equal("channel", "self_checkout")');
		});

		test("channel:'pos' in the request adds the matching filter", async () => {
			wireCollections({ transactionsByRangeStart: {} });
			mockUsers.listMemberships.mockResolvedValue({ memberships: [] });
			await handler(
				makeContext({
					body: {
						startDate: "2026-01-01T00:00:00.000Z",
						endDate: "2026-01-02T00:00:00.000Z",
						test: true,
						channel: "pos",
					},
					headers: { "x-appwrite-user-id": "u1" },
				}),
			);

			const call = mockDatabases.listDocuments.mock.calls.find((c) => c[1] === TRANSACTIONS_ID);
			expect(call[2]).toContain('equal("channel", "pos")');
		});

		test("omitting channel adds no channel filter -- all channels combined (regression guard)", async () => {
			wireCollections({ transactionsByRangeStart: {} });
			mockUsers.listMemberships.mockResolvedValue({ memberships: [] });
			await handler(
				makeContext({
					body: { startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-01-02T00:00:00.000Z", test: true },
					headers: { "x-appwrite-user-id": "u1" },
				}),
			);

			const call = mockDatabases.listDocuments.mock.calls.find((c) => c[1] === TRANSACTIONS_ID);
			expect(call[2].some((q) => q.startsWith("equal(\"channel\""))).toBe(false);
		});
	});
});
