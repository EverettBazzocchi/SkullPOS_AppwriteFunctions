jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, mockUsers, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");
const { MAX_ATTEMPTS } = require("./rateLimit.js");

const PIN_PAYMENT_TEAM_ID = "6a9cbb1c95ea7d59dd8c";

// Every real caller is a PIN-verified till: an anonymous account that Verify-Pin has joined to the
// PIN Payment Access team, executing with the platform-injected key. Appwrite has already checked
// that membership against the function's `execute` list before the body runs, so a caller that gets
// this far is an authorized one. The tests in this file used to pass no headers at all, which is
// precisely the caller-less API-key invocation this function refuses.
// `caller` is the throttle key now, not the IP. Appwrite sets x-appwrite-user-id from the session
// and a caller cannot supply it, so each till gets its own bucket and nobody can choose someone
// else's. x-forwarded-for is still passed on some cases purely to prove it is ignored.
function tillContext(body, { caller = "pos-device-1", ip } = {}) {
	return makeContext({
		body,
		headers: {
			"x-appwrite-user-id": caller,
			"x-appwrite-key": "injected-key",
			...(ip ? { "x-forwarded-for": ip } : {}),
		},
	});
}

describe("Giftcard-Lookup", () => {
	beforeEach(() => {
		resetAppwriteMocks();
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

	// The one authorization decision this function still makes for itself. Appwrite enforces the
	// `execute` team allowlist before the function body runs, so a session caller has already been
	// proven to be a confirmed member of an allowed team; the only caller that gets past that list
	// is a project API key with execution.write, which carries no session user.
	describe("caller authorization -- refusing an API-key-only invocation", () => {
		test("no caller id at all (a raw API-key invocation) is refused", async () => {
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 5000 }],
			});
			const ctx = makeContext({ body: { code: "75855123" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(result.body).not.toHaveProperty("balance");
			expect(mockUsers.listMemberships).not.toHaveBeenCalled();
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
		});

		// Appwrite sends x-appwrite-user-id with an empty value rather than omitting it when the
		// execution has no session user, so "" is the shape this actually arrives in.
		test("an empty caller id is refused as firmly as a missing one", async () => {
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 5000 }],
			});
			const ctx = makeContext({
				body: { code: "75855123" },
				headers: { "x-appwrite-user-id": "", "x-appwrite-key": "injected-key" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(result.body).not.toHaveProperty("balance");
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
		});
	});

	// The incident of 2026-09-13 07:51 UTC: the guard re-derived team membership through the Users
	// API and refused with a 503 whenever that call could not answer, which stopped giftcard
	// scanning at the bar. Each row below is a way that lookup used to fail or refuse. A session
	// caller has already cleared Appwrite's `execute` allowlist, so every row must still be served
	// -- and in particular none of them may produce a 503.
	describe("a session caller is never turned away by an external lookup", () => {
		const hostileConditions = [
			[
				"the caller id does not resolve as a project user",
				() => {
					// The literal error the live function logged.
					const notFound = new Error("User with the requested ID could not be found.");
					notFound.code = 404;
					mockUsers.listMemberships.mockRejectedValue(notFound);
				},
			],
			["the Users API is down", () => mockUsers.listMemberships.mockRejectedValue(new Error("users api down"))],
			["the caller belongs to no team", () => mockUsers.listMemberships.mockResolvedValue({ memberships: [] })],
			[
				"the caller's membership is unconfirmed",
				() => mockUsers.listMemberships.mockResolvedValue({ memberships: [{ teamId: PIN_PAYMENT_TEAM_ID, confirm: false }] }),
			],
		];

		test.each(hostileConditions)("still answers the lookup when %s", async (_label, arrange) => {
			arrange();
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
			});
			const ctx = tillContext({ code: "75855123" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body).toEqual({ found: true, id: "gc1", balance: 500, eventId: null, active: true });
		});

		// Appwrite injects x-appwrite-key only for a function that declares scopes. Whether that
		// injection happened must not decide whether the bar can scan a card.
		test("still answers the lookup when no x-appwrite-key is injected", async () => {
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
			});
			const ctx = makeContext({
				body: { code: "75855123" },
				headers: { "x-appwrite-user-id": "pos-device-1", "x-forwarded-for": "203.0.113.9" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body.found).toBe(true);
		});

		// The structural reason all of the above hold: the authorization path makes no outbound
		// call, so it has no failure mode to mishandle. Reintroducing a membership lookup here --
		// fail-closed or fail-open -- fails this test.
		test("decides authorization without consulting any external service", async () => {
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "gc1", UPC: "75855123", balance: 500 }],
			});
			const ctx = tillContext({ code: "75855123" });

			await handler(ctx);

			expect(mockUsers.listMemberships).not.toHaveBeenCalled();
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

		test("two different tills are throttled independently", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			await handler(tillContext({ code: "75855000" }, { caller: "pos-device-1" }));
			await handler(tillContext({ code: "75855001" }, { caller: "pos-device-2" }));

			const [firstId, secondId] = mockDatabases.createDocument.mock.calls.map((call) => call[2]);
			expect(firstId).not.toBe(secondId);
		});

		// The bug this replaces: the key came from x-forwarded-for, which createExecution lets the
		// caller set. Rotating it made the enumeration oracle unthrottled; pinning it to another
		// till's value exhausted that till's bucket from outside. It also meant every till at the
		// venue shared one bucket, because they all leave through one public IP.
		test("the throttle bucket cannot be chosen by the caller -- x-forwarded-for is ignored", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			await handler(tillContext({ code: "75855000" }, { caller: "pos-device-1", ip: "203.0.113.1" }));
			await handler(tillContext({ code: "75855001" }, { caller: "pos-device-1", ip: "198.51.100.7" }));

			const [firstId, secondId] = mockDatabases.createDocument.mock.calls.map((call) => call[2]);
			expect(firstId).toBe(secondId);
		});

		test("a found card clears the accumulated misses for that till", async () => {
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
