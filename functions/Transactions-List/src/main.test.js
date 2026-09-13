jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, mockUsers, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const ADMIN_TEAM_ID = "68e35aed00144b8cde9d";
const PIN_PAYMENT_TEAM_ID = "6a9cbb1c95ea7d59dd8c";
const DAY_MS = 24 * 60 * 60 * 1000;
const doc = (id, createdAt, testing = true) => ({ $id: id, $createdAt: createdAt, testing });

// A real caller is either a PIN-verified till (an anonymous account Verify-Pin joined to the PIN
// Payment Access team) or an admin-app session, both executing with the platform-injected key.
// The tests here used to pass no headers at all -- that caller is exactly the unauthenticated one
// this function now refuses, so every case that is not *about* authorization uses this helper.
function callerContext(body, userId = "pos-device-1") {
	return makeContext({
		body,
		headers: { "x-appwrite-user-id": userId, "x-appwrite-key": "injected-key" },
	});
}

function grantMembership(teamId = PIN_PAYMENT_TEAM_ID) {
	mockUsers.listMemberships.mockResolvedValue({ memberships: [{ teamId, confirm: true }] });
}

function startBound(queries) {
	const query = queries.find((q) => q.startsWith("greaterThanEqual"));
	return Date.parse(query.match(/"(\d{4}-[^"]+)"/)[1]);
}

function endBound(queries) {
	const query = queries.find((q) => q.startsWith("lessThanEqual"));
	return Date.parse(query.match(/"(\d{4}-[^"]+)"/)[1]);
}

describe("Transactions-List", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		grantMembership();
	});

	test("orders by $createdAt desc (newest first) and limits+1 to detect another page", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = callerContext({ test: true });

		await handler(ctx);

		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toContain('orderDesc("$createdAt")');
		expect(queries).toContain("limit(31)"); // default limit 30 + 1
	});

	test("filters by testing:true when test is requested", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = callerContext({ test: true });

		await handler(ctx);

		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toContain('equal("testing", true)');
	});

	test("filters by testing:false (notEqual true) for the live site", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = callerContext({ test: false });

		await handler(ctx);

		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toContain('notEqual("testing", true)');
	});

	test("returns hasMore:true and a nextCursor when an extra document comes back", async () => {
		const docs = Array.from({ length: 31 }, (_, i) => doc(`t${i}`, "2026-01-01T00:00:00.000Z"));
		mockDatabases.listDocuments.mockResolvedValue({ documents: docs });
		const ctx = callerContext({ test: true });

		const result = await handler(ctx);

		expect(result.body.documents).toHaveLength(30);
		expect(result.body.hasMore).toBe(true);
		expect(result.body.nextCursor).toBe("t29");
	});

	test("returns hasMore:false and nextCursor:null when there's no extra document", async () => {
		const docs = Array.from({ length: 5 }, (_, i) => doc(`t${i}`, "2026-01-01T00:00:00.000Z"));
		mockDatabases.listDocuments.mockResolvedValue({ documents: docs });
		const ctx = callerContext({ test: true });

		const result = await handler(ctx);

		expect(result.body.documents).toHaveLength(5);
		expect(result.body.hasMore).toBe(false);
		expect(result.body.nextCursor).toBeNull();
	});

	test("passes a provided cursor into Query.cursorAfter", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = callerContext({ test: true, cursor: "some-id" });

		await handler(ctx);

		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toContain('cursorAfter("some-id")');
	});

	test("honors a requested limit, capped at 100", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = callerContext({ test: true, limit: 500 });

		await handler(ctx);

		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toContain("limit(101)"); // capped at MAX_LIMIT (100) + 1
	});

	test("surfaces a 500 if the query fails", async () => {
		mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
		const ctx = callerContext({ test: true });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});

	test("an unparseable date is a 400, not an unhandled throw", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = callerContext({ test: true, endDate: "garbage" });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
	});

	describe("caller authorization", () => {
		test("a session in none of the till/admin teams is refused, and no transaction is read", async () => {
			mockUsers.listMemberships.mockResolvedValue({ memberships: [] });
			mockDatabases.listDocuments.mockResolvedValue({ documents: [doc("t1", "2026-01-01T00:00:00.000Z")] });
			const ctx = callerContext({ test: true });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
		});

		test("no caller id at all (a raw API-key invocation) is refused", async () => {
			const ctx = makeContext({ body: { test: true } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(mockUsers.listMemberships).not.toHaveBeenCalled();
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
		});

		test("a transient Users API failure degrades to a restricted listing rather than failing the view", async () => {
			mockUsers.listMemberships.mockRejectedValue(new Error("users api down"));
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const ctx = callerContext({ test: true });

			const result = await handler(ctx);

			expect(result.body.restricted).toBe(true);
			expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining("Failed to check team membership"));
		});
	});

	describe("admin vs. restricted date range", () => {
		test("a non-admin's window is the last 24 hours of server time -- a past endDate cannot move it", async () => {
			// The P0: the clamp used to be computed from the caller's own endDate, so one request
			// per day of history walked the whole ledger. Both bounds now come from Date.now().
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const before = Date.now();
			const ctx = callerContext({
				test: true,
				startDate: "2020-01-01T00:00:00.000Z",
				endDate: "2026-01-10T00:00:00.000Z",
			});

			const result = await handler(ctx);
			const after = Date.now();

			expect(result.body.restricted).toBe(true);
			const queries = mockDatabases.listDocuments.mock.calls[0][2];
			expect(startBound(queries)).toBeGreaterThanOrEqual(before - DAY_MS - 1000);
			expect(startBound(queries)).toBeLessThanOrEqual(after - DAY_MS + 1000);
			expect(endBound(queries)).toBeGreaterThanOrEqual(before - 1000);
			expect(queries.some((q) => q.includes("2026-01-10"))).toBe(false);
			expect(queries.some((q) => q.includes("2020-01-01"))).toBe(false);
		});

		test("a non-admin asking for a 30-day-old day gets the same range as one asking for nothing", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS).toISOString();

			await handler(callerContext({ test: true, endDate: thirtyDaysAgo }));
			await handler(callerContext({ test: true }));

			const walked = mockDatabases.listDocuments.mock.calls[0][2];
			const plain = mockDatabases.listDocuments.mock.calls[1][2];
			expect(Math.abs(startBound(walked) - startBound(plain))).toBeLessThan(2000);
			expect(Math.abs(endBound(walked) - endBound(plain))).toBeLessThan(2000);
		});

		test("a non-admin endDate inside the window still narrows it (the admin app pages with one)", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
			const ctx = callerContext({ test: true, endDate: anHourAgo.toISOString() });

			await handler(ctx);

			const queries = mockDatabases.listDocuments.mock.calls[0][2];
			expect(endBound(queries)).toBe(anHourAgo.getTime());
		});

		test("an admin's requested range is honored, unclamped", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			grantMembership(ADMIN_TEAM_ID);
			const start = "2020-01-01T00:00:00.000Z";
			const end = "2026-01-10T00:00:00.000Z";
			const ctx = callerContext({ test: true, startDate: start, endDate: end }, "admin-1");

			const result = await handler(ctx);

			expect(result.body.restricted).toBe(false);
			const queries = mockDatabases.listDocuments.mock.calls[0][2];
			expect(queries.some((q) => q.includes(start))).toBe(true);
			expect(queries.some((q) => q.includes(end))).toBe(true);
		});

		test("an admin with no startDate still defaults to the 24h before their endDate", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			grantMembership(ADMIN_TEAM_ID);
			const end = "2026-01-10T00:00:00.000Z";
			const ctx = callerContext({ test: true, endDate: end }, "admin-1");

			await handler(ctx);

			const queries = mockDatabases.listDocuments.mock.calls[0][2];
			expect(startBound(queries)).toBe(Date.parse(end) - DAY_MS);
		});
	});

	describe("field exposure", () => {
		const fullRow = {
			$id: "t1",
			$createdAt: "2026-01-01T00:00:00.000Z",
			$updatedAt: "2026-01-01T00:05:00.000Z",
			$permissions: ['read("team:admin")'],
			status: "complete",
			payment_method: "stripe",
			total: 1400,
			tip: 100,
			discount: 0,
			cart: "[]",
			payments: "[]",
			CreatedBy: "Till 1",
			testing: true,
			member_name: "Alice Example",
			member_email: "alice@example.com",
			stripe_id: "pi_123",
			bartenderId: "6aa4b42657f13c492d78",
			transaction_data: "encrypted-blob",
		};

		test("a non-admin never receives membership PII, the PaymentIntent id, or the encrypted blob", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [fullRow] });
			const ctx = callerContext({ test: true });

			const result = await handler(ctx);

			const [row] = result.body.documents;
			expect(row.member_name).toBeUndefined();
			expect(row.member_email).toBeUndefined();
			expect(row.stripe_id).toBeUndefined();
			expect(row.transaction_data).toBeUndefined();
			expect(row.bartenderId).toBeUndefined();
			expect(JSON.stringify(result.body)).not.toContain("alice@example.com");
		});

		test("a non-admin still receives everything the POS transaction/refund view renders", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [fullRow] });
			const ctx = callerContext({ test: true });

			const result = await handler(ctx);

			const [row] = result.body.documents;
			expect(row).toMatchObject({
				$id: "t1",
				$createdAt: "2026-01-01T00:00:00.000Z",
				status: "complete",
				payment_method: "stripe",
				total: 1400,
				tip: 100,
				discount: 0,
				cart: "[]",
				CreatedBy: "Till 1",
			});
		});

		test("an admin still receives the raw document", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [fullRow] });
			grantMembership(ADMIN_TEAM_ID);
			const ctx = callerContext({ test: true }, "admin-1");

			const result = await handler(ctx);

			expect(result.body.documents[0]).toEqual(fullRow);
		});

		test("paging still works off the raw $id even though non-admin rows are projected", async () => {
			const docs = Array.from({ length: 31 }, (_, i) => ({ ...fullRow, $id: `t${i}` }));
			mockDatabases.listDocuments.mockResolvedValue({ documents: docs });
			const ctx = callerContext({ test: true });

			const result = await handler(ctx);

			expect(result.body.nextCursor).toBe("t29");
			expect(result.body.documents[29].member_email).toBeUndefined();
		});
	});
});
