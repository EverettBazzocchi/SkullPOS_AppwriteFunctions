jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, mockUsers, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const ADMIN_TEAM_ID = "68e35aed00144b8cde9d";
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

	describe("admin vs. restricted date range", () => {
		test("a non-admin's requested range is clamped to the last 24 hours", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			mockUsers.listMemberships.mockResolvedValue({ memberships: [] });
			const end = "2026-01-10T00:00:00.000Z";
			const requestedStart = "2020-01-01T00:00:00.000Z";
			const clampedStart = new Date(new Date(end).getTime() - 24 * 60 * 60 * 1000).toISOString();
			const ctx = makeContext({
				body: { test: true, startDate: requestedStart, endDate: end },
				headers: { "x-appwrite-user-id": "u1" },
			});

			const result = await handler(ctx);

			expect(result.body.restricted).toBe(true);
			const queries = mockDatabases.listDocuments.mock.calls[0][2];
			expect(queries.some((q) => q.includes(clampedStart))).toBe(true);
			expect(queries.some((q) => q.includes(requestedStart))).toBe(false);
		});

		test("an admin's requested range is honored, unclamped", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			mockUsers.listMemberships.mockResolvedValue({ memberships: [{ teamId: ADMIN_TEAM_ID, confirm: true }] });
			const start = "2020-01-01T00:00:00.000Z";
			const end = "2026-01-10T00:00:00.000Z";
			const ctx = makeContext({
				body: { test: true, startDate: start, endDate: end },
				headers: { "x-appwrite-user-id": "admin-1" },
			});

			const result = await handler(ctx);

			expect(result.body.restricted).toBe(false);
			const queries = mockDatabases.listDocuments.mock.calls[0][2];
			expect(queries.some((q) => q.includes(start))).toBe(true);
		});

		test("no caller id at all (e.g. a direct API call) is treated as non-admin", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const ctx = makeContext({ body: { test: true } });

			const result = await handler(ctx);

			expect(result.body.restricted).toBe(true);
			expect(mockUsers.listMemberships).not.toHaveBeenCalled();
		});
	});
});
