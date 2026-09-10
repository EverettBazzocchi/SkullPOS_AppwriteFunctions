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

	test("orders by $createdAt desc (newest first) and limits+1 to detect another page", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: { test: true } });

		await handler(ctx);

		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toContain('orderDesc("$createdAt")');
		expect(queries).toContain("limit(31)"); // default limit 30 + 1
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

	test("returns hasMore:true and a nextCursor when an extra document comes back", async () => {
		const docs = Array.from({ length: 31 }, (_, i) => doc(`t${i}`, "2026-01-01T00:00:00.000Z"));
		mockDatabases.listDocuments.mockResolvedValue({ documents: docs });
		const ctx = makeContext({ body: { test: true } });

		const result = await handler(ctx);

		expect(result.body.documents).toHaveLength(30);
		expect(result.body.hasMore).toBe(true);
		expect(result.body.nextCursor).toBe("t29");
	});

	test("returns hasMore:false and nextCursor:null when there's no extra document", async () => {
		const docs = Array.from({ length: 5 }, (_, i) => doc(`t${i}`, "2026-01-01T00:00:00.000Z"));
		mockDatabases.listDocuments.mockResolvedValue({ documents: docs });
		const ctx = makeContext({ body: { test: true } });

		const result = await handler(ctx);

		expect(result.body.documents).toHaveLength(5);
		expect(result.body.hasMore).toBe(false);
		expect(result.body.nextCursor).toBeNull();
	});

	test("passes a provided cursor into Query.cursorAfter", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: { test: true, cursor: "some-id" } });

		await handler(ctx);

		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toContain('cursorAfter("some-id")');
	});

	test("honors a requested limit, capped at 100", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: { test: true, limit: 500 } });

		await handler(ctx);

		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toContain("limit(101)"); // capped at MAX_LIMIT (100) + 1
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
