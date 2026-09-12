jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

describe("Bartender-Sales", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	test("sums completed sales and tips, and lists them", async () => {
		mockDatabases.getDocument.mockResolvedValue({ $id: "bt1", name: "Alex" });
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [
				{ $id: "t1", $createdAt: "2026-01-01T00:00:00Z", total: 1000, tip: 100, status: "complete", payment_method: "stripe" },
				{ $id: "t2", $createdAt: "2026-01-01T01:00:00Z", total: 500, tip: 50, status: "complete", payment_method: "cash" },
			],
		});
		const ctx = makeContext({ body: { bartenderId: "bt1" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body.salesTotal).toBe(1500);
		expect(result.body.tipsTotal).toBe(150);
		expect(result.body.transactionCount).toBe(2);
		expect(result.body.transactions).toHaveLength(2);
		expect(result.body.transactions[0]).toEqual({
			id: "t1", createdAt: "2026-01-01T00:00:00Z", total: 1000, tip: 100, status: "complete", paymentMethod: "stripe",
		});
	});

	test("excludes a refunded sale from the totals, but still lists it", async () => {
		mockDatabases.getDocument.mockResolvedValue({ $id: "bt1", name: "Alex" });
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [
				{ $id: "t1", $createdAt: "2026-01-01T00:00:00Z", total: 1000, tip: 100, status: "complete" },
				{ $id: "t2", $createdAt: "2026-01-01T01:00:00Z", total: 2000, tip: 200, status: "refunded" },
			],
		});
		const ctx = makeContext({ body: { bartenderId: "bt1" } });

		const result = await handler(ctx);

		expect(result.body.salesTotal).toBe(1000);
		expect(result.body.tipsTotal).toBe(100);
		expect(result.body.transactionCount).toBe(1);
		expect(result.body.transactions).toHaveLength(2);
	});

	test("queries transactions scoped to this bartenderId only", async () => {
		mockDatabases.getDocument.mockResolvedValue({ $id: "bt1", name: "Alex" });
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: { bartenderId: "bt1" } });

		await handler(ctx);

		const [, , queries] = mockDatabases.listDocuments.mock.calls[0];
		expect(queries.some((q) => q.includes("bt1"))).toBe(true);
	});

	test("no sales yet returns all-zero totals", async () => {
		mockDatabases.getDocument.mockResolvedValue({ $id: "bt1", name: "Alex" });
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: { bartenderId: "bt1" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ salesTotal: 0, tipsTotal: 0, transactionCount: 0, transactions: [] });
	});

	test("404s when the bartender doesn't exist", async () => {
		mockDatabases.getDocument.mockRejectedValue(new Error("not found"));
		const ctx = makeContext({ body: { bartenderId: "missing" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(404);
		expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
	});

	test("rejects a missing bartenderId", async () => {
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.getDocument).not.toHaveBeenCalled();
	});

	test("rejects invalid JSON", async () => {
		const ctx = makeContext({ body: {} });
		ctx.req.body = "not json";

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});

	test("surfaces a 500 if the transactions query fails", async () => {
		mockDatabases.getDocument.mockResolvedValue({ $id: "bt1", name: "Alex" });
		mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: { bartenderId: "bt1" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});
});
