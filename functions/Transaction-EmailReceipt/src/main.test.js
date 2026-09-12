jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const mockFetch = require("node-fetch");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const baseTransaction = (overrides = {}) => ({
	$id: "transaction1234567890",
	$createdAt: "2026-01-01T12:00:00.000Z",
	status: "complete",
	cart: JSON.stringify([{ name: "Beer", quantity: 2, price: 700 }]),
	total: 1400,
	discount: 0,
	tip: 0,
	payments: JSON.stringify([{ method: "cash", amount: 1400 }]),
	...overrides,
});

function mockResendSuccess() {
	mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
}

describe("Transaction-EmailReceipt", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		mockFetch.mockReset();
		process.env.RESEND_API_KEY = "re_test_key";
	});

	test("sends a receipt for a completed transaction", async () => {
		mockDatabases.getDocument.mockResolvedValue(baseTransaction());
		mockResendSuccess();
		const ctx = makeContext({ body: { transactionId: "t1", email: "customer@example.com" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true });
		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.resend.com/emails",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ Authorization: "Bearer re_test_key" }),
			}),
		);
		const [, options] = mockFetch.mock.calls[0];
		const sentBody = JSON.parse(options.body);
		expect(sentBody.from).toBe("SkullPOS <SkullPOS@mail.shotty.tech>");
		expect(sentBody.to).toEqual(["customer@example.com"]);
		expect(sentBody.cc).toEqual(["everett.bazzocchi@skullspace.ca"]);
		expect(sentBody.html).toContain("Beer");
		expect(sentBody.html).toContain("$14.00");
		expect(sentBody.html).toContain("admin@skullspace.ca");
	});

	test("sends a receipt for a refunded transaction, noting the refund", async () => {
		mockDatabases.getDocument.mockResolvedValue(baseTransaction({ status: "refunded" }));
		mockResendSuccess();
		const ctx = makeContext({ body: { transactionId: "t1", email: "customer@example.com" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true });
		const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(sentBody.html).toMatch(/refunded/i);
	});

	test("rejects a pending transaction -- nothing to receipt yet", async () => {
		mockDatabases.getDocument.mockResolvedValue(baseTransaction({ status: "pending" }));
		const ctx = makeContext({ body: { transactionId: "t1", email: "customer@example.com" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(result.body.error).toMatch(/completed or refunded/i);
	});

	test("rejects a cancelled transaction", async () => {
		mockDatabases.getDocument.mockResolvedValue(baseTransaction({ status: "cancelled" }));
		const ctx = makeContext({ body: { transactionId: "t1", email: "customer@example.com" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});

	test("rejects a missing transactionId", async () => {
		const ctx = makeContext({ body: { email: "customer@example.com" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.getDocument).not.toHaveBeenCalled();
	});

	test.each(["", "not-an-email", "missing-at-sign.com", "no-domain@"])(
		"rejects an invalid email (%p)",
		async (email) => {
			const ctx = makeContext({ body: { transactionId: "t1", email } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.getDocument).not.toHaveBeenCalled();
		},
	);

	test("invalid JSON request body is rejected with 400", async () => {
		const ctx = makeContext({ body: {} });
		ctx.req.body = "{not json";

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});

	test("404s when the transaction doesn't exist", async () => {
		mockDatabases.getDocument.mockRejectedValue(new Error("not found"));
		const ctx = makeContext({ body: { transactionId: "missing", email: "customer@example.com" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(404);
	});

	test("surfaces a 500 when Resend rejects the request", async () => {
		mockDatabases.getDocument.mockResolvedValue(baseTransaction());
		mockFetch.mockResolvedValue({ ok: false, status: 422, text: () => Promise.resolve("bad request") });
		const ctx = makeContext({ body: { transactionId: "t1", email: "customer@example.com" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});

	test("surfaces a 500 when the network call itself throws", async () => {
		mockDatabases.getDocument.mockResolvedValue(baseTransaction());
		mockFetch.mockRejectedValue(new Error("network down"));
		const ctx = makeContext({ body: { transactionId: "t1", email: "customer@example.com" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});

	test("a legacy transaction (no payments array) still builds a receipt via the fallback derivation", async () => {
		mockDatabases.getDocument.mockResolvedValue(
			baseTransaction({ payments: null, stripe_id: "pi_legacy", payment_due: 1400 }),
		);
		mockResendSuccess();
		const ctx = makeContext({ body: { transactionId: "t1", email: "customer@example.com" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true });
		const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(sentBody.html).toContain("Card");
	});

	test("malformed cart JSON doesn't crash -- renders with no line items", async () => {
		mockDatabases.getDocument.mockResolvedValue(baseTransaction({ cart: "{not valid json" }));
		mockResendSuccess();
		const ctx = makeContext({ body: { transactionId: "t1", email: "customer@example.com" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true });
	});
});
