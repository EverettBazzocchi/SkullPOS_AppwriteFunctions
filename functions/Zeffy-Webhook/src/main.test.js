jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const crypto = require("crypto");
const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");
const { deriveDeterministicId } = require("./deterministicId.js");

function conflictError() {
	const err = new Error("Document already exists");
	err.code = 409;
	return err;
}

const SECRET = "whsec_test_secret_value";

function sign(rawBody, t, secret = SECRET) {
	const v1 = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
	return `t=${t},v1=${v1}`;
}

function signedContext(payload, { secret = SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
	const ctx = makeContext({ body: payload });
	ctx.req.headers["zeffy-signature"] = sign(ctx.req.body, t, secret);
	return ctx;
}

const completedPayload = {
	type: "payment.completed",
	data: {
		id: "txn_123",
		description: "Fall Fundraiser",
		amount: 3000,
		currency: "cad",
		buyer: { first_name: "Jane", last_name: "Doe", email: "jane@example.com" },
		payment_method: { type: "card" },
		items: [{ id: "item_1", amount: 3000, type: "Standard Ticket" }],
	},
};

describe("Zeffy-Webhook", () => {
	const originalSecret = process.env.ZEFFY_WEBHOOK_SIGNING_SECRET;

	beforeEach(() => {
		resetAppwriteMocks();
		process.env.ZEFFY_WEBHOOK_SIGNING_SECRET = SECRET;
		mockDatabases.createDocument.mockResolvedValue({});
	});

	afterAll(() => {
		process.env.ZEFFY_WEBHOOK_SIGNING_SECRET = originalSecret;
	});

	test("rejects a request with a missing signature", async () => {
		const ctx = makeContext({ body: completedPayload });
		const result = await handler(ctx);
		expect(result.statusCode).toBe(401);
		expect(mockDatabases.createDocument).not.toHaveBeenCalled();
	});

	test("rejects a request with an invalid signature", async () => {
		const ctx = signedContext(completedPayload, { secret: "wrong_secret" });
		const result = await handler(ctx);
		expect(result.statusCode).toBe(401);
	});

	test("fails closed with a 500 when no signing secret is configured, even with no signature header at all", async () => {
		delete process.env.ZEFFY_WEBHOOK_SIGNING_SECRET;
		const ctx = makeContext({ body: completedPayload });
		const result = await handler(ctx);
		expect(result.statusCode).toBe(500);
		expect(result.body.success).toBe(false);
		expect(mockDatabases.createDocument).not.toHaveBeenCalled();
	});

	test("fails closed with a 500 when no signing secret is configured, even if a signature header is present", async () => {
		delete process.env.ZEFFY_WEBHOOK_SIGNING_SECRET;
		// Signed against some secret the (unset) env var can never match -- must still be
		// rejected up front rather than accepted because "a signature was present".
		const ctx = signedContext(completedPayload, { secret: "whatever_secret" });
		const result = await handler(ctx);
		expect(result.statusCode).toBe(500);
		expect(result.body.success).toBe(false);
	});

	test("creates one order and one ticket per line item for a fresh payment.completed event", async () => {
		const ctx = signedContext(completedPayload);
		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body).toMatchObject({ success: true, transactionId: "txn_123", orderCreated: true, ticketsSaved: 1 });

		expect(mockDatabases.createDocument).toHaveBeenCalledWith(
			expect.any(String),
			"orders",
			deriveDeterministicId("zfo", "txn_123"),
			expect.objectContaining({ orderId: "txn_123", source: "ZEFFY", customerEmail: "jane@example.com" })
		);
		expect(mockDatabases.createDocument).toHaveBeenCalledWith(
			expect.any(String),
			"tickets",
			deriveDeterministicId("zft", "item_1"),
			expect.objectContaining({ ticketId: "item_1", orderId: "txn_123", source: "ZEFFY", status: "VALID" })
		);
	});

	test("skips creating a duplicate order and ticket on a retried delivery (deterministic id already exists)", async () => {
		mockDatabases.createDocument.mockRejectedValue(conflictError());
		const ctx = signedContext(completedPayload);

		const result = await handler(ctx);

		expect(result.body).toMatchObject({ orderCreated: false, ticketsSaved: 0 });
	});

	test("does not persist a non-payment.completed event", async () => {
		const ctx = signedContext({ type: "payment.refunded", data: { id: "txn_999" } });
		const result = await handler(ctx);

		expect(result.body).toMatchObject({ success: true, skipped: true });
		expect(mockDatabases.createDocument).not.toHaveBeenCalled();
	});

	describe("a payload whose line items carry no id of their own", () => {
		// Zeffy sends these: parseZeffyPayload synthesizes a single `{ name, amount }` line item
		// for a body with no `items` array at all, and real `items` entries can arrive without an
		// `id`. The ticket code -- and therefore the ticket DOCUMENT id -- is derived from it, so
		// anything random there means a redelivery can never collide and every delivery mints a
		// brand new duplicate paid ticket.
		const noItemsPayload = {
			type: "payment.completed",
			data: {
				id: "txn_noitems",
				description: "Fall Fundraiser",
				amount: 2500,
				currency: "cad",
				buyer: { first_name: "Jane", last_name: "Doe", email: "jane@example.com" },
			},
		};

		/** createDocument mock that enforces Appwrite's own document-id uniqueness, like the real DB. */
		function statefulCreateDocument() {
			const created = new Set();
			return jest.fn((_db, collectionId, id) => {
				const key = `${collectionId}/${id}`;
				if (created.has(key)) return Promise.reject(conflictError());
				created.add(key);
				return Promise.resolve({});
			});
		}

		test("a redelivered id-less payload is recognised as a duplicate instead of minting new tickets", async () => {
			mockDatabases.createDocument.mockImplementation(statefulCreateDocument());

			const first = await handler(signedContext(noItemsPayload));
			const second = await handler(signedContext(noItemsPayload));

			expect(first.body).toMatchObject({ orderCreated: true, ticketsSaved: 1 });
			expect(second.body).toMatchObject({ orderCreated: false, ticketsSaved: 0, ticketsAlreadyPresent: 1 });
			const ticketCreates = mockDatabases.createDocument.mock.calls.filter((c) => c[1] === "tickets");
			expect(ticketCreates).toHaveLength(2);
			expect(ticketCreates[0][2]).toBe(ticketCreates[1][2]); // same derived document id both times
		});

		test("derives a different ticket code per line item, stable across deliveries", async () => {
			const threeItems = {
				type: "payment.completed",
				data: { ...noItemsPayload.data, id: "txn_three", items: [{ amount: 1000 }, { amount: 1000 }, { amount: 500 }] },
			};
			mockDatabases.createDocument.mockImplementation(statefulCreateDocument());

			const first = await handler(signedContext(threeItems));
			const second = await handler(signedContext(threeItems));

			expect(first.body).toMatchObject({ ticketsSaved: 3 });
			expect(second.body).toMatchObject({ ticketsSaved: 0, ticketsAlreadyPresent: 3 });
			const codes = mockDatabases.createDocument.mock.calls.filter((c) => c[1] === "tickets").map((c) => c[3].ticketId);
			expect(new Set(codes.slice(0, 3)).size).toBe(3);
			expect(codes.slice(0, 3)).toEqual(codes.slice(3, 6));
		});

		test("two different transactions never derive the same fallback ticket code", async () => {
			mockDatabases.createDocument.mockImplementation(statefulCreateDocument());

			await handler(signedContext(noItemsPayload));
			await handler(signedContext({ ...noItemsPayload, data: { ...noItemsPayload.data, id: "other_txn_noitems" } }));

			const codes = mockDatabases.createDocument.mock.calls.filter((c) => c[1] === "tickets").map((c) => c[3].ticketId);
			expect(new Set(codes).size).toBe(2);
		});

		test("prices an amount-less line item at 0, not at the whole order total", async () => {
			const mixed = {
				type: "payment.completed",
				data: { ...noItemsPayload.data, id: "txn_mixed", amount: 9000, items: [{ id: "i1", amount: 3000 }, { id: "i2" }] },
			};
			const ctx = signedContext(mixed);

			await handler(ctx);

			const prices = mockDatabases.createDocument.mock.calls.filter((c) => c[1] === "tickets").map((c) => c[3].price);
			expect(prices).toEqual([3000, 0]);
		});

		test("an EMPTY items array falls back to one ticket, the same as a missing one", async () => {
			// `[] || fallback` keeps the empty array, so this wrote the order and zero tickets --
			// a paid buyer with nothing to scan, and an order row that made every later
			// reconciliation run 409 and report the payment as healthy.
			const ctx = signedContext({
				type: "payment.completed",
				data: { ...noItemsPayload.data, id: "txn_emptyitems", amount: 4500, items: [] },
			});

			const result = await handler(ctx);

			expect(result.body).toMatchObject({ orderCreated: true, ticketsSaved: 1 });
			const ticketCreate = mockDatabases.createDocument.mock.calls.find((c) => c[1] === "tickets");
			expect(ticketCreate[3]).toMatchObject({ orderId: "txn_emptyitems", price: 4500, status: "VALID" });
		});

		test("still prices a payload with no items array at all at the order total", async () => {
			const ctx = signedContext(noItemsPayload);

			await handler(ctx);

			const ticketCreate = mockDatabases.createDocument.mock.calls.find((c) => c[1] === "tickets");
			expect(ticketCreate[3].price).toBe(2500);
		});
	});

	test("dead-letters the payload to failed_webhooks when persistence fails, without throwing", async () => {
		mockDatabases.createDocument.mockImplementation((_db, collectionId) => {
			if (collectionId === "orders") return Promise.reject(new Error("db unavailable"));
			return Promise.resolve({});
		});
		const ctx = signedContext(completedPayload);

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body.success).toBe(false);
		expect(mockDatabases.createDocument).toHaveBeenCalledWith(
			expect.any(String),
			"failed_webhooks",
			"unique()",
			expect.objectContaining({ source: "ZEFFY", transactionId: "txn_123" })
		);
	});

	describe("dead-lettering a payload too large for the failed_webhooks column", () => {
		// A big group order -- exactly the kind worth recovering. Cutting the JSON at 4999 chars
		// produced a row that could never be parsed again, so the retry job re-failed it on every
		// 12-hourly run forever.
		const bigOrder = {
			type: "payment.completed",
			data: {
				id: "txn_big",
				description: "Fall Fundraiser",
				amount: 120000,
				currency: "cad",
				buyer: { first_name: "Jane", last_name: "Doe", email: "jane@example.com" },
				items: Array.from({ length: 40 }, (_, i) => ({
					id: `item_${i}_0123456789abcdef0123456789abcdef`,
					amount: 3000,
					type: "General Admission -- Fall Fundraiser 2026",
					rate_title: "General Admission -- Fall Fundraiser 2026",
				})),
			},
		};

		function deadLetteredPayload() {
			const call = mockDatabases.createDocument.mock.calls.find((c) => c[1] === "failed_webhooks");
			return call[3].payload;
		}

		beforeEach(() => {
			mockDatabases.createDocument.mockImplementation((_db, collectionId) => {
				if (collectionId === "orders") return Promise.reject(new Error("db unavailable"));
				return Promise.resolve({});
			});
		});

		test("stores valid, parseable JSON rather than a payload cut mid-document", async () => {
			await handler(signedContext(bigOrder));

			const payload = deadLetteredPayload();
			expect(payload.length).toBeLessThanOrEqual(4999);
			expect(() => JSON.parse(payload)).not.toThrow();
		});

		test("the stored marker says it is truncated and keeps the transaction id for API recovery", async () => {
			await handler(signedContext(bigOrder));

			const marker = JSON.parse(deadLetteredPayload());
			expect(marker).toMatchObject({ truncated: true, transactionId: "txn_big", itemCount: 40 });
			expect(marker.originalLength).toBeGreaterThan(4999);
		});

		test("a payload that fits is still dead-lettered verbatim", async () => {
			await handler(signedContext(completedPayload));

			const parsed = JSON.parse(deadLetteredPayload());
			expect(parsed.truncated).toBeUndefined();
			expect(parsed).toMatchObject({ transactionId: "txn_123", items: [{ id: "item_1", amount: 3000 }] });
		});
	});
});
