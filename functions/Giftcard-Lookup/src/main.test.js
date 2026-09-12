jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

describe("Giftcard-Lookup", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	test("finds a card by exact UPC match", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
		});
		const ctx = makeContext({ body: { code: "75855123" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ found: true, id: "gc1", balance: 500, eventId: null, active: true });
	});

	test("surfaces DJ-voucher fields for a card linked to an event", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "gc9", UPC: "75855999", balance: 2000, events: "event1", active: true }],
		});
		const ctx = makeContext({ body: { code: "75855999" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ found: true, id: "gc9", balance: 2000, eventId: "event1", active: true });
	});

	test("a revoked voucher reports active:false", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "gc10", UPC: "75855111", balance: 1000, events: "event1", active: false }],
		});
		const ctx = makeContext({ body: { code: "75855111" } });

		const result = await handler(ctx);

		expect(result.body.active).toBe(false);
	});

	test("finds a card whose UPC is stored as an array", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "gc2", UPC: ["aaa", "75855123"], balance: 1000 }],
		});
		const ctx = makeContext({ body: { code: "75855123" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ found: true, id: "gc2", balance: 1000, eventId: null, active: true });
	});

	test("never returns more than the one matched card, even if others come back", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [
				{ $id: "other", UPC: "111", balance: 999999 },
				{ $id: "gc1", UPC: "75855123", balance: 500 },
			],
		});
		const ctx = makeContext({ body: { code: "75855123" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ found: true, id: "gc1", balance: 500, eventId: null, active: true });
		expect(result.body.balance).not.toBe(999999);
	});

	test("balance defaults to 0 when missing on the document", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "gc3", UPC: "code" }],
		});
		const ctx = makeContext({ body: { code: "code" } });

		const result = await handler(ctx);

		expect(result.body.balance).toBe(0);
	});

	test("returns found:false when nothing matches", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: { code: "nope" } });

		const result = await handler(ctx);

		expect(result).toEqual({ statusCode: 200, body: { found: false } });
	});

	test("rejects a missing/blank code", async () => {
		const ctx = makeContext({ body: { code: "   " } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
	});

	test("surfaces a 500 if the query itself fails", async () => {
		mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: { code: "75855123" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});
});
