jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, mockUsers, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");
const { MAX_ATTEMPTS } = require("./rateLimit.js");

const PIN_PAYMENT_TEAM_ID = "6a9cbb1c95ea7d59dd8c";
const ADMIN_TEAM_ID = "68e35aed00144b8cde9d";

// Every real caller is a PIN-verified till: an anonymous account that Verify-Pin has joined to the
// PIN Payment Access team, executing with the platform-injected key. The tests in this file used
// to pass no headers at all, which is precisely the unauthenticated caller this function now
// refuses -- so the context helper below is what "a legitimate POS device" looks like.
function tillContext(body, { ip = "203.0.113.9" } = {}) {
	return makeContext({
		body,
		headers: {
			"x-appwrite-user-id": "pos-device-1",
			"x-appwrite-key": "injected-key",
			"x-forwarded-for": ip,
		},
	});
}

function grantMembership(teamId = PIN_PAYMENT_TEAM_ID) {
	mockUsers.listMemberships.mockResolvedValue({ memberships: [{ teamId, confirm: true }] });
}

describe("Giftcard-Lookup", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		grantMembership();
	});

	test("finds a card by exact UPC match", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
		});
		const ctx = tillContext({ code: "75855123" });

		const result = await handler(ctx);

		expect(result.body).toEqual({ found: true, id: "gc1", balance: 500, eventId: null, active: true });
	});

	test("surfaces DJ-voucher fields for a card linked to an event", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "gc9", UPC: "75855999", balance: 2000, events: "event1", active: true }],
		});
		const ctx = tillContext({ code: "75855999" });

		const result = await handler(ctx);

		expect(result.body).toEqual({ found: true, id: "gc9", balance: 2000, eventId: "event1", active: true });
	});

	test("a revoked voucher reports active:false", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "gc10", UPC: "75855111", balance: 1000, events: "event1", active: false }],
		});
		const ctx = tillContext({ code: "75855111" });

		const result = await handler(ctx);

		expect(result.body.active).toBe(false);
	});

	test("finds a card whose UPC is stored as an array", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "gc2", UPC: ["aaa", "75855123"], balance: 1000 }],
		});
		const ctx = tillContext({ code: "75855123" });

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
		const ctx = tillContext({ code: "75855123" });

		const result = await handler(ctx);

		expect(result.body).toEqual({ found: true, id: "gc1", balance: 500, eventId: null, active: true });
		expect(result.body.balance).not.toBe(999999);
	});

	test("balance defaults to 0 when missing on the document", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "gc3", UPC: "code" }],
		});
		const ctx = tillContext({ code: "code" });

		const result = await handler(ctx);

		expect(result.body.balance).toBe(0);
	});

	test("returns found:false when nothing matches", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = tillContext({ code: "nope" });

		const result = await handler(ctx);

		expect(result).toEqual({ statusCode: 200, body: { found: false } });
	});

	test("rejects a missing/blank code", async () => {
		const ctx = tillContext({ code: "   " });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
	});

	test("surfaces a 500 if the query itself fails", async () => {
		mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
		const ctx = tillContext({ code: "75855123" });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});

	describe("caller authorization", () => {
		test("a session in none of the till/admin teams is refused, and never reaches the giftcards collection", async () => {
			mockUsers.listMemberships.mockResolvedValue({ memberships: [] });
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 5000 }],
			});
			const ctx = tillContext({ code: "75855123" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(result.body).not.toHaveProperty("balance");
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
		});

		test("an unconfirmed membership in an allowed team does not count", async () => {
			mockUsers.listMemberships.mockResolvedValue({ memberships: [{ teamId: PIN_PAYMENT_TEAM_ID, confirm: false }] });
			const ctx = tillContext({ code: "75855123" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
		});

		test("no caller id at all (a raw API-key invocation) is refused", async () => {
			const ctx = makeContext({ body: { code: "75855123" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(mockUsers.listMemberships).not.toHaveBeenCalled();
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
		});

		test("an admin-team caller is allowed", async () => {
			grantMembership(ADMIN_TEAM_ID);
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
			});
			const ctx = tillContext({ code: "75855123" });

			const result = await handler(ctx);

			expect(result.body.found).toBe(true);
		});

		// `execute` is still `users`, so this check is the access control, not a second copy of
		// one. Both of its "cannot run" states therefore refuse -- and the second one was every
		// request in production, since a function with no declared scopes is never handed a key.
		test("a Users API failure refuses rather than answering the lookup unverified", async () => {
			mockUsers.listMemberships.mockRejectedValue(new Error("users api down"));
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
			});
			const ctx = tillContext({ code: "75855123" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(503);
			expect(result.body).not.toHaveProperty("balance");
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
		});

		test("no injected x-appwrite-key refuses, and names the missing scope in the log", async () => {
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
			});
			const ctx = makeContext({
				body: { code: "75855123" },
				headers: { "x-appwrite-user-id": "anonymous-session", "x-forwarded-for": "203.0.113.9" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(503);
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
			expect(ctx.error).toHaveBeenCalledWith(expect.stringMatching(/users\.read/));
		});
	});

	describe("enumeration throttle", () => {
		test("a miss records an attempt against the caller's IP", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const ctx = tillContext({ code: "75855000" });

			await handler(ctx);

			expect(mockDatabases.createDocument).toHaveBeenCalledWith(
				"67c9ffd9003d68236514",
				"rate_limits",
				expect.stringMatching(/^gcl_/),
				expect.objectContaining({ attempts: 1, lockedUntil: null }),
			);
		});

		test("the persisted state carries only the three attributes rate_limits actually has", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const ctx = tillContext({ code: "75855000" });

			await handler(ctx);

			const written = mockDatabases.createDocument.mock.calls[0][3];
			expect(Object.keys(written).sort()).toEqual(["attempts", "lockedUntil", "windowStart"]);
		});

		test(`the ${MAX_ATTEMPTS}th consecutive miss locks the IP out`, async () => {
			mockDatabases.getDocument.mockResolvedValue({
				attempts: MAX_ATTEMPTS - 1,
				windowStart: new Date().toISOString(),
				lockedUntil: null,
			});
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const ctx = tillContext({ code: "75855000" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(429);
			expect(mockDatabases.updateDocument).toHaveBeenCalledWith(
				"67c9ffd9003d68236514",
				"rate_limits",
				expect.stringMatching(/^gcl_/),
				expect.objectContaining({ lockedUntil: expect.any(String) }),
			);
		});

		test("a locked-out caller gets the same 429 for a code that DOES exist -- no oracle", async () => {
			mockDatabases.getDocument.mockResolvedValue({
				attempts: MAX_ATTEMPTS,
				windowStart: new Date().toISOString(),
				lockedUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
			});
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 5000 }],
			});
			const ctx = tillContext({ code: "75855123" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(429);
			expect(result.body.found).toBe(false);
			expect(result.body).not.toHaveProperty("id");
			expect(result.body).not.toHaveProperty("balance");
			// The giftcards collection is never even queried while locked out.
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
		});

		test("an expired lockout lets the caller straight back in", async () => {
			mockDatabases.getDocument.mockResolvedValue({
				attempts: MAX_ATTEMPTS,
				windowStart: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
				lockedUntil: new Date(Date.now() - 1000).toISOString(),
			});
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
			});
			const ctx = tillContext({ code: "75855123" });

			const result = await handler(ctx);

			expect(result.body.found).toBe(true);
		});

		test("two different IPs are throttled independently", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			await handler(tillContext({ code: "75855000" }, { ip: "203.0.113.1" }));
			await handler(tillContext({ code: "75855001" }, { ip: "198.51.100.7" }));

			const [firstId, secondId] = mockDatabases.createDocument.mock.calls.map((call) => call[2]);
			expect(firstId).not.toBe(secondId);
		});

		test("a found card clears the accumulated misses for that IP", async () => {
			mockDatabases.getDocument.mockResolvedValue({ attempts: 3, windowStart: new Date().toISOString(), lockedUntil: null });
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
			});
			const ctx = tillContext({ code: "75855123" });

			await handler(ctx);

			expect(mockDatabases.updateDocument).toHaveBeenCalledWith(
				"67c9ffd9003d68236514",
				"rate_limits",
				expect.stringMatching(/^gcl_/),
				expect.objectContaining({ attempts: 0, lockedUntil: null }),
			);
		});

		// The limiter is the only thing standing between one caller and a 100,000-code walk, so a
		// miss it cannot count must not be answered. Swallowing these two failures (which is what
		// the code did, on a function with no documents.write scope, so EVERY write failed) left
		// the counter permanently at nothing and the oracle completely open.
		test("a miss whose counter write fails is refused, not answered", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			mockDatabases.createDocument.mockRejectedValue(new Error("no documents.write scope"));
			const ctx = tillContext({ code: "75855000" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(503);
			expect(result.body).not.toHaveProperty("found");
			expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining("documents.write"));
		});

		test("a counter that cannot be read is refused before the giftcards collection is touched", async () => {
			const unreadable = new Error("rate_limits unavailable");
			unreadable.code = 500;
			mockDatabases.getDocument.mockRejectedValue(unreadable);
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
			});
			const ctx = tillContext({ code: "75855123" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(503);
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
		});

		test("a 404 from the counter is 'no misses yet', not a storage failure", async () => {
			const missing = new Error("not found");
			missing.code = 404;
			mockDatabases.getDocument.mockRejectedValue(missing);
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
			});
			const ctx = tillContext({ code: "75855123" });

			const result = await handler(ctx);

			expect(result.body.found).toBe(true);
		});

		test("a rate-limit write failure on a FOUND card never blocks a legitimate redemption", async () => {
			mockDatabases.getDocument.mockResolvedValue({ attempts: 3, windowStart: new Date().toISOString(), lockedUntil: null });
			mockDatabases.updateDocument.mockRejectedValue(new Error("no documents.write scope"));
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
			});
			const ctx = tillContext({ code: "75855123" });

			const result = await handler(ctx);

			expect(result.body.found).toBe(true);
			expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining("Failed to persist rate-limit state"));
		});
	});
});
