jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

describe("Transaction-SetStatus", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	test("cancels a pending transaction", async () => {
		mockDatabases.getDocument.mockResolvedValue({ status: "pending" });
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

		const result = await handler(ctx);

		expect(result).toEqual({ statusCode: 200, body: { ok: true, status: "cancelled" } });
		expect(mockDatabases.updateDocument).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			"t1",
			{ status: "cancelled" },
		);
	});

	test.each(["complete", "refunded", "pending", "anything-else"])(
		"rejects %s -- only cancelled is ever allowed here",
		async (status) => {
			const ctx = makeContext({ body: { transactionId: "t1", status } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.getDocument).not.toHaveBeenCalled();
		},
	);

	test("rejects a missing transactionId", async () => {
		const ctx = makeContext({ body: { status: "cancelled" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});

	test("404s when the transaction doesn't exist", async () => {
		mockDatabases.getDocument.mockRejectedValue(new Error("not found"));
		const ctx = makeContext({ body: { transactionId: "missing", status: "cancelled" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(404);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("refuses to cancel a transaction that's already complete", async () => {
		mockDatabases.getDocument.mockResolvedValue({ status: "complete" });
		const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(result.body.error).toMatch(/not pending/i);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("refuses to re-cancel an already-cancelled transaction (no-op replay protection)", async () => {
		mockDatabases.getDocument.mockResolvedValue({ status: "cancelled" });
		const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("surfaces a 500 if the update itself fails", async () => {
		mockDatabases.getDocument.mockResolvedValue({ status: "pending" });
		mockDatabases.updateDocument.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});
});
