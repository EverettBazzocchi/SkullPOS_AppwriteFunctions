jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const doc = (id, createdAt, testing = true) => ({ $id: id, $createdAt: createdAt, testing });

describe("Transactions-List", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	test("returns transactions sorted newest first", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [doc("old", "2026-01-01T00:00:00.000Z"), doc("new", "2026-01-02T00:00:00.000Z")],
		});
		const ctx = makeContext({ body: { test: true } });

		const result = await handler(ctx);

		expect(result.body.documents.map((d) => d.$id)).toEqual(["new", "old"]);
	});

	test("filters by testing:true when test is requested", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: { test: true } });

		await handler(ctx);

		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toContain('equal("testing", true)');
	});

	test("filters by testing:false (notEqual true) for the live site", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: { test: false } });

		await handler(ctx);

		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toContain('notEqual("testing", true)');
	});

	test("pages through more than one page of results", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => doc(`p1-${i}`, "2026-01-01T00:00:00.000Z"));
		const page2 = [doc("p2-0", "2026-01-02T00:00:00.000Z")];
		mockDatabases.listDocuments.mockResolvedValueOnce({ documents: page1 }).mockResolvedValueOnce({ documents: page2 });
		const ctx = makeContext({ body: { test: true } });

		const result = await handler(ctx);

		expect(mockDatabases.listDocuments).toHaveBeenCalledTimes(2);
		expect(result.body.documents).toHaveLength(101);
	});

	test("surfaces a 500 if the query fails", async () => {
		mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: { test: true } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});
});
