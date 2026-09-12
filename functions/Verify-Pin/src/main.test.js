jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const crypto = require("crypto");
const { mockDatabases, mockTeams, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const hash = (pin) => crypto.createHash("sha256").update(String(pin)).digest("hex");
const PIN_PAYMENT_TEAM_ID = "6a9cbb1c95ea7d59dd8c";

function mockPinRow({ label = "Bartender", system = "pos", pin = "1234" } = {}) {
	return { system, label, hash: hash(pin), active: true };
}

describe("Verify-Pin", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		mockTeams.createMembership.mockResolvedValue({});
	});

	test("correct, active PIN returns ok:true with its label", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [mockPinRow({ label: "Bartender", pin: "1234" })] });
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result).toEqual({ statusCode: 200, body: { ok: true, label: "Bartender", selfCheckout: false, bartenderId: null } });
		expect(mockDatabases.listDocuments).toHaveBeenCalledWith(
			expect.any(String),
			"pins",
			expect.arrayContaining([expect.stringContaining(hash("1234"))])
		);
	});

	test("wrong PIN returns ok:false and never reveals why", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: { pin: "9999" } });

		const result = await handler(ctx);

		expect(result).toEqual({ statusCode: 200, body: { ok: false } });
	});

	test("a PIN marked inactive is treated as no match (query already filters active:true)", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: false });
	});

	test("a system:self_checkout row reports selfCheckout:true in the response", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [mockPinRow({ label: "Self-Checkout Kiosk 1", system: "self_checkout", pin: "1234" })],
		});
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true, label: "Self-Checkout Kiosk 1", selfCheckout: true, bartenderId: null });
	});

	test("a system:pos row reports selfCheckout:false (ordinary staff PIN)", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [mockPinRow({ label: "Bartender", system: "pos", pin: "1234" })] });
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result.body.selfCheckout).toBe(false);
	});

	describe("payment-team membership grant", () => {
		test("grants payment-team membership to the caller on a successful match", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [mockPinRow({ pin: "1234" })] });
			const ctx = makeContext({ body: { pin: "1234" }, headers: { "x-appwrite-user-id": "u1" } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(true);
			expect(mockTeams.createMembership).toHaveBeenCalledWith(PIN_PAYMENT_TEAM_ID, [], undefined, "u1");
		});

		test("still succeeds even if granting membership fails", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [mockPinRow({ pin: "1234" })] });
			mockTeams.createMembership.mockRejectedValue(new Error("team API down"));
			const ctx = makeContext({ body: { pin: "1234" }, headers: { "x-appwrite-user-id": "u1" } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, label: "Bartender", selfCheckout: false, bartenderId: null });
		});

		test("does not attempt to grant membership when no caller id is present", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [mockPinRow({ pin: "1234" })] });
			const ctx = makeContext({ body: { pin: "1234" } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(true);
			expect(mockTeams.createMembership).not.toHaveBeenCalled();
		});

		test("does not attempt to grant membership when the PIN doesn't match", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const ctx = makeContext({ body: { pin: "9999" }, headers: { "x-appwrite-user-id": "u1" } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: false });
			expect(mockTeams.createMembership).not.toHaveBeenCalled();
		});
	});

	describe("bartender pins", () => {
		function mockBartenderRow({ name = "Alex", pin = "5678", events = [] } = {}) {
			return { $id: "bt1", name, hash: hash(pin), active: true, events };
		}

		test("a bartender pin whose event is happening right now succeeds with its bartenderId", async () => {
			mockDatabases.listDocuments
				.mockResolvedValueOnce({ documents: [] }) // pins: no match
				.mockResolvedValueOnce({ documents: [mockBartenderRow({ pin: "5678", events: [{ date: new Date().toISOString() }] })] });
			const ctx = makeContext({ body: { pin: "5678" } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, label: "Alex", selfCheckout: false, bartenderId: "bt1" });
			const [, collectionId, queries] = mockDatabases.listDocuments.mock.calls[1];
			expect(collectionId).toBe("bartenders");
			expect(queries.some((q) => q.includes("select"))).toBe(true);
		});

		test("accepts right at the 1-hour edge before an event starts", async () => {
			const eventDate = new Date(Date.now() + 59 * 60 * 1000).toISOString();
			mockDatabases.listDocuments
				.mockResolvedValueOnce({ documents: [] })
				.mockResolvedValueOnce({ documents: [mockBartenderRow({ pin: "5678", events: [{ date: eventDate }] })] });
			const ctx = makeContext({ body: { pin: "5678" } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(true);
		});

		test("rejects a bartender pin more than 1 hour from its event, with a specific message", async () => {
			const eventDate = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
			mockDatabases.listDocuments
				.mockResolvedValueOnce({ documents: [] })
				.mockResolvedValueOnce({ documents: [mockBartenderRow({ pin: "5678", events: [{ date: eventDate }] })] });
			const ctx = makeContext({ body: { pin: "5678" } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(false);
			expect(result.body.error).toMatch(/only valid within 1 hour/i);
		});

		test("accepts a pin well into a multi-hour shift, past the old fixed 1-hour-from-start cutoff", async () => {
			// Event started 3.5 hours ago with a 4-hour (10pm-2am) bar window -- well outside a
			// flat ±1h-from-start window, but still inside the actual shift + 1h buffer.
			const eventDate = new Date(Date.now() - 3.5 * 60 * 60 * 1000).toISOString();
			mockDatabases.listDocuments
				.mockResolvedValueOnce({ documents: [] })
				.mockResolvedValueOnce({
					documents: [mockBartenderRow({ pin: "5678", events: [{ date: eventDate, barOpenTime: "2200", barCloseTime: "02:00" }] })],
				});
			const ctx = makeContext({ body: { pin: "5678" } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(true);
		});

		test("rejects a bartender with no assigned events at all", async () => {
			mockDatabases.listDocuments
				.mockResolvedValueOnce({ documents: [] })
				.mockResolvedValueOnce({ documents: [mockBartenderRow({ pin: "5678", events: [] })] });
			const ctx = makeContext({ body: { pin: "5678" } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(false);
		});

		test("a pin matching neither pins nor bartenders returns the same plain ok:false", async () => {
			mockDatabases.listDocuments.mockResolvedValueOnce({ documents: [] }).mockResolvedValueOnce({ documents: [] });
			const ctx = makeContext({ body: { pin: "0000" } });

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: false } });
		});

		test("still grants payment-team membership for a valid bartender pin", async () => {
			mockDatabases.listDocuments
				.mockResolvedValueOnce({ documents: [] })
				.mockResolvedValueOnce({ documents: [mockBartenderRow({ pin: "5678", events: [{ date: new Date().toISOString() }] })] });
			const ctx = makeContext({ body: { pin: "5678" }, headers: { "x-appwrite-user-id": "u1" } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(true);
			expect(mockTeams.createMembership).toHaveBeenCalledWith(PIN_PAYMENT_TEAM_ID, [], undefined, "u1");
		});
	});

	test("missing pin is rejected with 400", async () => {
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(result.body.ok).toBe(false);
		expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
	});

	test("invalid JSON request body is rejected with 400", async () => {
		const ctx = makeContext({ body: {} });
		ctx.req.body = "{not json";

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});

	test("a database error fails closed with 500, not a crash", async () => {
		mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
		expect(result.body.ok).toBe(false);
	});

	describe("IP-based rate limiting on failed attempts", () => {
		// Simulates the `rate_limits` collection as an in-memory store keyed by document id, so a
		// test can make several sequential calls to the handler (each a fresh function invocation
		// in real life) and see the persisted lockout state carry over between them, the same way
		// it would via the real database.
		function makeRateLimitStore() {
			const store = {};
			mockDatabases.getDocument.mockImplementation(async (_dbId, collectionId, docId) => {
				if (collectionId !== "rate_limits") return {};
				if (!(docId in store)) {
					const err = new Error("Document not found");
					err.code = 404;
					throw err;
				}
				return store[docId];
			});
			mockDatabases.createDocument.mockImplementation(async (_dbId, collectionId, docId, data) => {
				if (collectionId === "rate_limits") store[docId] = { ...data, $id: docId };
				return store[docId];
			});
			mockDatabases.updateDocument.mockImplementation(async (_dbId, collectionId, docId, data) => {
				if (collectionId === "rate_limits") store[docId] = { ...(store[docId] || {}), ...data };
				return store[docId];
			});
			return store;
		}

		const wrongPinCtx = () =>
			makeContext({ body: { pin: "9999" }, headers: { "x-forwarded-for": "10.0.0.5" } });

		test("locks out after 5 failed attempts from the same IP within the window", async () => {
			makeRateLimitStore();
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			let lastResult;
			for (let i = 0; i < 5; i++) {
				lastResult = await handler(wrongPinCtx());
			}

			expect(lastResult.statusCode).toBe(429);
			expect(lastResult.body.ok).toBe(false);
			expect(lastResult.body.error).toMatch(/too many incorrect pin attempts/i);
		});

		test("attempts before the 5th are plain wrong-pin responses, not lockout responses", async () => {
			makeRateLimitStore();
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			for (let i = 0; i < 4; i++) {
				const result = await handler(wrongPinCtx());
				expect(result.statusCode).toBe(200);
				expect(result.body).toEqual({ ok: false });
			}
		});

		test("a locked-out caller is rejected before the PIN is even checked, with an error distinct from a wrong PIN", async () => {
			makeRateLimitStore();
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			for (let i = 0; i < 5; i++) {
				await handler(wrongPinCtx());
			}
			mockDatabases.listDocuments.mockClear();

			const result = await handler(wrongPinCtx());

			expect(result.statusCode).toBe(429);
			expect(result.body.error).toMatch(/too many incorrect pin attempts/i);
			// a plain wrong PIN never carries an `error` field -- this is a deliberately different
			// signal from "that PIN was wrong", without confirming which PINs came close
			expect(result.body).not.toEqual({ ok: false });
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
		});

		test("a correct PIN resets the failed-attempt counter for that IP", async () => {
			makeRateLimitStore();
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			for (let i = 0; i < 3; i++) {
				await handler(wrongPinCtx());
			}

			mockDatabases.listDocuments.mockResolvedValueOnce({ documents: [mockPinRow({ pin: "1234" })] });
			const successResult = await handler(
				makeContext({ body: { pin: "1234" }, headers: { "x-forwarded-for": "10.0.0.5" } }),
			);
			expect(successResult.body.ok).toBe(true);

			// Two more wrong attempts after the reset should NOT be locked out (3 pre-reset + 2
			// post-reset = 5 total, but the counter was cleared on success).
			let lastResult;
			for (let i = 0; i < 2; i++) {
				lastResult = await handler(wrongPinCtx());
			}
			expect(lastResult.statusCode).toBe(200);
			expect(lastResult.body).toEqual({ ok: false });
		});

		test("failed attempts from a different IP don't count against this one", async () => {
			makeRateLimitStore();
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			for (let i = 0; i < 5; i++) {
				await handler(makeContext({ body: { pin: "9999" }, headers: { "x-forwarded-for": "10.0.0.9" } }));
			}

			const result = await handler(wrongPinCtx());

			expect(result.statusCode).toBe(200);
			expect(result.body).toEqual({ ok: false });
		});

		test("a rate-limit storage failure fails open (PIN verification still proceeds)", async () => {
			mockDatabases.getDocument.mockRejectedValue(new Error("db unreachable"));
			mockDatabases.listDocuments.mockResolvedValue({ documents: [mockPinRow({ pin: "1234" })] });
			const ctx = makeContext({ body: { pin: "1234" }, headers: { "x-forwarded-for": "10.0.0.5" } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(true);
		});
	});
});
