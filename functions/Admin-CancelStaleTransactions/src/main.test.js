jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const doc = (id, status) => ({ $id: id, status });

describe("Admin-CancelStaleTransactions", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	test("cancels every stale pending transaction returned by the query", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [doc("t1", "pending"), doc("t2", "pending")] });
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body.staleFound).toBe(2);
		expect(result.body.cancelled).toBe(2);
		expect(mockDatabases.updateDocument).toHaveBeenCalledWith(expect.any(String), expect.any(String), "t1", { status: "cancelled" });
		expect(mockDatabases.updateDocument).toHaveBeenCalledWith(expect.any(String), expect.any(String), "t2", { status: "cancelled" });
	});

	test("queries only status:pending, created at or before the 1-hour cutoff", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: {} });

		await handler(ctx);

		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toContain('equal("status", "pending")');
		expect(queries.some((q) => q.startsWith('lessThanEqual("$createdAt"'))).toBe(true);
	});

	test("nothing to cancel when there are no stale pending transactions", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.staleFound).toBe(0);
		expect(result.body.cancelled).toBe(0);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("pages through more than one page of results", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => doc(`p1-${i}`, "pending"));
		const page2 = [doc("p2-0", "pending")];
		mockDatabases.listDocuments.mockResolvedValueOnce({ documents: page1 }).mockResolvedValueOnce({ documents: page2 });
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(mockDatabases.listDocuments).toHaveBeenCalledTimes(2);
		expect(result.body.staleFound).toBe(101);
		expect(result.body.cancelled).toBe(101);
	});

	test("a failed cancel is reported but doesn't stop the run", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [doc("bad", "pending"), doc("good", "pending")] });
		mockDatabases.updateDocument.mockImplementation((_db, _col, id) =>
			id === "bad" ? Promise.reject(new Error("locked")) : Promise.resolve({})
		);
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.cancelled).toBe(1);
		expect(result.body.failures).toEqual([{ transactionId: "bad", error: "locked" }]);
	});

	test("surfaces a 500 if listing transactions fails", async () => {
		mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});
});
