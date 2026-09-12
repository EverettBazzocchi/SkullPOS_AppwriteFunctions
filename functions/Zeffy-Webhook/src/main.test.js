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
});
