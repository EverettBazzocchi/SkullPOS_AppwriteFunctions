jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const crypto = require("crypto");
const { mockDatabases, mockTeams, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { IP_MAX_ATTEMPTS } = require("./rateLimit.js");
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
		// The live `rate_limits` collection has exactly these three attributes. Appwrite's structure
		// validator 400s a payload carrying anything else, so the mock does too -- without this the
		// store accepted any shape, which is exactly how the limiter shipped passing `justLocked`
		// (a control flag, not an attribute) as a document field and silently persisting NOTHING
		// for its entire life (P0-4a).
		const RATE_LIMIT_ATTRIBUTES = ["attempts", "windowStart", "lockedUntil"];

		function assertRateLimitSchema(data) {
			const unknown = Object.keys(data || {}).filter((key) => !RATE_LIMIT_ATTRIBUTES.includes(key));
			if (unknown.length > 0) {
				const err = new Error(`Invalid document structure: Unknown attribute: "${unknown[0]}"`);
				err.code = 400;
				err.type = "document_invalid_structure";
				throw err;
			}
		}

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
				if (collectionId !== "rate_limits") return {};
				assertRateLimitSchema(data);
				store[docId] = { ...data, $id: docId };
				return store[docId];
			});
			mockDatabases.updateDocument.mockImplementation(async (_dbId, collectionId, docId, data) => {
				if (collectionId !== "rate_limits") return {};
				assertRateLimitSchema(data);
				store[docId] = { ...(store[docId] || {}), ...data };
				return store[docId];
			});
			return store;
		}

		const wrongPinCtx = (headers = {}) =>
			makeContext({ body: { pin: "9999" }, headers: { "x-forwarded-for": "10.0.0.5", ...headers } });

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

		test("a rate-limit lookup failure fails open (PIN verification still proceeds)", async () => {
			mockDatabases.getDocument.mockRejectedValue(new Error("db unreachable"));
			mockDatabases.listDocuments.mockResolvedValue({ documents: [mockPinRow({ pin: "1234" })] });
			const ctx = makeContext({ body: { pin: "1234" }, headers: { "x-forwarded-for": "10.0.0.5" } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(true);
		});

		// P0-4a: the counter document is written with EXACTLY the three attributes the collection
		// has. Before this, `justLocked` rode along in the payload, Appwrite 400'd every write, the
		// error was downgraded to a log line, and `rate_limits` stayed empty forever -- so the
		// endpoint had no brute-force protection at all despite a fully green suite.
		test("persists only the three attributes `rate_limits` actually has", async () => {
			makeRateLimitStore();
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			await handler(wrongPinCtx());

			expect(mockDatabases.createDocument).toHaveBeenCalled();
			for (const [, collectionId, , data] of mockDatabases.createDocument.mock.calls) {
				expect(collectionId).toBe("rate_limits");
				expect(Object.keys(data).sort()).toEqual(["attempts", "lockedUntil", "windowStart"]);
			}
		});

		test("the counter actually reaches the database (a failed attempt is stored, not just computed)", async () => {
			const store = makeRateLimitStore();
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			await handler(wrongPinCtx());
			await handler(wrongPinCtx());

			const rows = Object.values(store);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.some((row) => row.attempts === 2)).toBe(true);
		});

		// P0-4b: x-forwarded-for is a chain each proxy appends to, and Appwrite's createExecution
		// API lets a caller supply headers outright -- so the LEFTMOST element is attacker-authored.
		// Keying on it meant every attempt landed in a brand-new bucket.
		test("a spoofed leftmost x-forwarded-for cannot buy fresh attempts", async () => {
			makeRateLimitStore();
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			let lastResult;
			for (let i = 0; i < 5; i++) {
				lastResult = await handler(wrongPinCtx({ "x-forwarded-for": `1.2.3.${i}, 10.0.0.5` }));
			}

			expect(lastResult.statusCode).toBe(429);
		});

		test("a chosen leftmost element cannot pin a lockout on somebody else's bucket", async () => {
			makeRateLimitStore();
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			// Attacker (real address 203.0.113.9) claims to be the venue's address.
			for (let i = 0; i < 5; i++) {
				await handler(wrongPinCtx({ "x-forwarded-for": "10.0.0.5, 203.0.113.9" }));
			}

			// The venue itself, arriving through the same trusted proxy, is unaffected.
			const result = await handler(wrongPinCtx({ "x-forwarded-for": "10.0.0.5" }));

			expect(result.statusCode).toBe(200);
			expect(result.body).toEqual({ ok: false });
		});

		// Fail CLOSED: an unrecordable attempt means the endpoint has no throttle, which for an
		// unauthenticated PIN endpoint is worse than being briefly unavailable.
		test("a rate-limit WRITE failure fails closed (503), never a plain wrong-pin answer", async () => {
			mockDatabases.getDocument.mockImplementation(async () => {
				const err = new Error("Document not found");
				err.code = 404;
				throw err;
			});
			mockDatabases.createDocument.mockRejectedValue(new Error("documents.write denied"));
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			const result = await handler(wrongPinCtx());

			expect(result.statusCode).toBe(503);
			expect(result.body.ok).toBe(false);
			expect(result.body).not.toEqual({ ok: false });
		});

		test("an unknown attribute in the payload would fail closed rather than pass silently", async () => {
			// Guards the guard: the store rejects off-schema writes the way the real collection
			// does, so a future payload regression surfaces as a 503 here instead of nothing.
			makeRateLimitStore();
			mockDatabases.createDocument.mockImplementation(async () => {
				const err = new Error('Invalid document structure: Unknown attribute: "justLocked"');
				err.code = 400;
				throw err;
			});
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			const result = await handler(wrongPinCtx());

			expect(result.statusCode).toBe(503);
		});

		describe("per-caller buckets and the shared-IP backstop (P1-14)", () => {
			test("one device's five typos do not lock out another device behind the same IP", async () => {
				makeRateLimitStore();
				mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

				let tillOne;
				for (let i = 0; i < 5; i++) {
					tillOne = await handler(wrongPinCtx({ "x-appwrite-user-id": "till-1" }));
				}
				expect(tillOne.statusCode).toBe(429);

				const tillTwo = await handler(wrongPinCtx({ "x-appwrite-user-id": "till-2" }));

				expect(tillTwo.statusCode).toBe(200);
				expect(tillTwo.body).toEqual({ ok: false });
			});

			test("rotating session ids from one IP still hits the shared-IP ceiling", async () => {
				makeRateLimitStore();
				mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

				let result;
				for (let i = 0; i < IP_MAX_ATTEMPTS; i++) {
					result = await handler(wrongPinCtx({ "x-appwrite-user-id": `throwaway-${i}` }));
					if (i < IP_MAX_ATTEMPTS - 1) expect(result.statusCode).toBe(200);
				}

				expect(result.statusCode).toBe(429);
			});

			test("a correct bartender pin presented outside its window burns no attempts", async () => {
				makeRateLimitStore();
				const eventDate = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
				const earlyBartenderCtx = () => {
					mockDatabases.listDocuments
						.mockResolvedValueOnce({ documents: [] })
						.mockResolvedValueOnce({
							documents: [{ $id: "bt1", name: "Alex", hash: hash("5678"), active: true, events: [{ date: eventDate }] }],
						});
					return makeContext({ body: { pin: "5678" }, headers: { "x-forwarded-for": "10.0.0.5", "x-appwrite-user-id": "till-1" } });
				};

				let result;
				for (let i = 0; i < 5; i++) {
					result = await handler(earlyBartenderCtx());
				}

				// Still the window message, never a lockout -- and nothing was written to the counter.
				expect(result.statusCode).toBe(200);
				expect(result.body.error).toMatch(/only valid within 1 hour/i);
				expect(mockDatabases.createDocument).not.toHaveBeenCalled();
				expect(mockDatabases.updateDocument).not.toHaveBeenCalled();

				// A cashier on the same till/IP is unaffected.
				mockDatabases.listDocuments.mockResolvedValue({ documents: [mockPinRow({ pin: "1234" })] });
				const cashier = await handler(
					makeContext({ body: { pin: "1234" }, headers: { "x-forwarded-for": "10.0.0.5", "x-appwrite-user-id": "till-1" } }),
				);
				expect(cashier.body.ok).toBe(true);
			});
		});
	});
});
