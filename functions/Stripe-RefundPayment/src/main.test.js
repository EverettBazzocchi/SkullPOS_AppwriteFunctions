jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const { mockStripe, resetStripeMocks } = require("stripe");
const handler = require("./main.js").default;
const { makeContext: makeRawContext } = require("../../../test/helpers/handlerContext");

// Every test below represents a real, session-authenticated caller (this function's execute
// scope is admin-team-only) unless a test explicitly needs to exercise the no-caller-identity
// rejection path itself -- that one test uses makeRawContext directly instead.
function makeContext(opts = {}) {
	return makeRawContext({ ...opts, headers: { "x-appwrite-user-id": "admin-caller", ...(opts.headers || {}) } });
}

describe("Stripe-RefundPayment", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		resetStripeMocks();
		process.env.testKey = "sk_test_fake";
		process.env.prodKey = "sk_live_fake";
	});

	test("refunds every leg of a giftcard+card split and marks the transaction refunded first", async () => {
		const transaction = {
			status: "complete",
			testing: true,
			payments: JSON.stringify([
				{ method: "giftcard", amount: 400, giftcardId: "gc1" },
				{ method: "stripe", amount: 600, stripeId: "pi_1" },
			]),
		};
		mockDatabases.getDocument
			.mockResolvedValueOnce(transaction) // read the transaction
			.mockResolvedValueOnce({ balance: 100 }); // read the giftcard before crediting it back
		mockDatabases.updateDocument.mockResolvedValue({});
		mockStripe.refunds.create.mockResolvedValue({ id: "re_1" });
		const ctx = makeContext({ body: { transactionId: "t1" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body.ok).toBe(true);
		expect(result.body.legs.every((l) => l.reversed)).toBe(true);

		// status=refunded must be the FIRST write, before any leg reversal
		const statusCallIndex = mockDatabases.updateDocument.mock.calls.findIndex(
			(c) => c[3] && c[3].status === "refunded",
		);
		expect(statusCallIndex).toBe(0);

		// giftcard credited back by exactly its leg amount
		const giftcardCall = mockDatabases.updateDocument.mock.calls.find((c) => c[2] === "gc1");
		expect(giftcardCall[3]).toEqual({ balance: 500 });

		// stripe refunded for exactly its leg amount
		expect(mockStripe.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_1", amount: 600 });
	});

	test("a cash leg is a no-op -- no external call, just marked reversed", async () => {
		const transaction = { status: "complete", testing: true, payments: JSON.stringify([{ method: "cash", amount: 500 }]) };
		mockDatabases.getDocument.mockResolvedValue(transaction);
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: { transactionId: "t1" } });

		const result = await handler(ctx);

		expect(result.body.legs).toEqual([{ method: "cash", amount: 500, reversed: true }]);
		expect(mockStripe.refunds.create).not.toHaveBeenCalled();
	});

	test("refuses to refund an already-refunded transaction", async () => {
		mockDatabases.getDocument.mockResolvedValue({ status: "refunded" });
		const ctx = makeContext({ body: { transactionId: "t1" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("refuses to refund a transaction that was never completed", async () => {
		mockDatabases.getDocument.mockResolvedValue({ status: "pending" });
		const ctx = makeContext({ body: { transactionId: "t1" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("404s when the transaction doesn't exist", async () => {
		mockDatabases.getDocument.mockRejectedValue(new Error("not found"));
		const ctx = makeContext({ body: { transactionId: "missing" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(404);
	});

	test("if marking the transaction refunded fails, no leg is ever touched", async () => {
		mockDatabases.getDocument.mockResolvedValue({
			status: "complete",
			payments: JSON.stringify([{ method: "stripe", amount: 500, stripeId: "pi_1" }]),
		});
		mockDatabases.updateDocument.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: { transactionId: "t1" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
		expect(mockStripe.refunds.create).not.toHaveBeenCalled();
	});

	test("a partial failure (one leg fails) still reports which legs succeeded and which didn't", async () => {
		const transaction = {
			status: "complete",
			testing: true,
			payments: JSON.stringify([
				{ method: "stripe", amount: 600, stripeId: "pi_1" },
				{ method: "giftcard", amount: 400, giftcardId: "gc1" },
			]),
		};
		mockDatabases.getDocument
			.mockResolvedValueOnce(transaction)
			.mockRejectedValueOnce(new Error("giftcard vanished")); // reading gc1 to credit it fails
		mockDatabases.updateDocument.mockResolvedValue({});
		mockStripe.refunds.create.mockResolvedValue({ id: "re_1" });
		const ctx = makeContext({ body: { transactionId: "t1" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
		const stripeLeg = result.body.legs.find((l) => l.method === "stripe");
		const giftcardLeg = result.body.legs.find((l) => l.method === "giftcard");
		expect(stripeLeg.reversed).toBe(true);
		expect(giftcardLeg.reversed).toBe(false);
		// the transaction was still marked refunded (idempotency guard already ran)
		expect(mockDatabases.updateDocument.mock.calls.some((c) => c[3] && c[3].status === "refunded")).toBe(true);
	});

	test("retrying an already-refunded transaction is safely rejected, not double-processed", async () => {
		// Simulates calling the function again after a prior call already
		// succeeded in flipping status (the idempotency guard doing its job).
		mockDatabases.getDocument.mockResolvedValue({ status: "refunded" });
		const ctx = makeContext({ body: { transactionId: "t1" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockStripe.refunds.create).not.toHaveBeenCalled();
	});

	test("uses the test Stripe key for a testing transaction's refund", async () => {
		mockDatabases.getDocument.mockResolvedValue({
			status: "complete",
			testing: true,
			payments: JSON.stringify([{ method: "stripe", amount: 500, stripeId: "pi_1" }]),
		});
		mockDatabases.updateDocument.mockResolvedValue({});
		mockStripe.refunds.create.mockResolvedValue({ id: "re_1" });
		const ctx = makeContext({ body: { transactionId: "t1" } });

		await handler(ctx);

		expect(mockStripe.lastConstructedWithKey).toBe("sk_test_fake");
	});

	test("uses the live Stripe key for a real transaction's refund", async () => {
		mockDatabases.getDocument.mockResolvedValue({
			status: "complete",
			testing: false,
			payments: JSON.stringify([{ method: "stripe", amount: 500, stripeId: "pi_1" }]),
		});
		mockDatabases.updateDocument.mockResolvedValue({});
		mockStripe.refunds.create.mockResolvedValue({ id: "re_1" });
		const ctx = makeContext({ body: { transactionId: "t1" } });

		await handler(ctx);

		expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
	});

	test("refunds a legacy-shaped transaction (no payments array) via the fallback derivation", async () => {
		mockDatabases.getDocument.mockResolvedValue({
			status: "complete",
			testing: true,
			payments: null,
			stripe_id: "pi_legacy",
			total: 800,
			payment_due: 800,
		});
		mockDatabases.updateDocument.mockResolvedValue({});
		mockStripe.refunds.create.mockResolvedValue({ id: "re_1" });
		const ctx = makeContext({ body: { transactionId: "t1" } });

		const result = await handler(ctx);

		expect(result.body.ok).toBe(true);
		expect(mockStripe.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_legacy", amount: 800 });
	});

	test("rejects a missing transactionId", async () => {
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.getDocument).not.toHaveBeenCalled();
	});

	describe("ShottyTicketing's paymentIntentId-shaped refunds", () => {
		test("refunds a real PaymentIntent in test mode, without touching the transactions database", async () => {
			mockStripe.refunds.create.mockResolvedValue({ id: "re_tkt_1", status: "succeeded" });
			const ctx = makeContext({ body: { paymentIntentId: "pi_real123" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body).toEqual({ refundId: "re_tkt_1", status: "succeeded", mode: "test" });
			expect(mockStripe.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_real123" });
			expect(mockStripe.lastConstructedWithKey).toBe("sk_test_fake");
			expect(mockDatabases.getDocument).not.toHaveBeenCalled();
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("refunds in live mode when isLive is true", async () => {
			mockStripe.refunds.create.mockResolvedValue({ id: "re_tkt_2", status: "succeeded" });
			const ctx = makeContext({ body: { paymentIntentId: "pi_real456", isLive: true } });

			const result = await handler(ctx);

			expect(result.body.mode).toBe("live");
			expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
		});

		test("refunds in live mode when environment is 'live'", async () => {
			mockStripe.refunds.create.mockResolvedValue({ id: "re_tkt_3", status: "succeeded" });
			const ctx = makeContext({ body: { paymentIntentId: "pi_real789", environment: "live" } });

			const result = await handler(ctx);

			expect(result.body.mode).toBe("live");
			expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
		});

		test("rejects a synthetic pi_tkt_ placeholder id instead of calling Stripe", async () => {
			const ctx = makeContext({ body: { paymentIntentId: "pi_tkt_offline1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/cannot refund automatically/);
			expect(mockStripe.refunds.create).not.toHaveBeenCalled();
		});

		test("rejects a missing paymentIntentId", async () => {
			const ctx = makeContext({ body: { paymentIntentId: undefined, isLive: true } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockStripe.refunds.create).not.toHaveBeenCalled();
		});

		test("a Stripe API failure returns a 500 with the error message", async () => {
			mockStripe.refunds.create.mockRejectedValue(new Error("card network down"));
			const ctx = makeContext({ body: { paymentIntentId: "pi_real999" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(result.body.error).toBe("card network down");
		});
	});

	describe("caller identity (defense-in-depth)", () => {
		test("rejects a call with no x-appwrite-user-id header, even with an otherwise-valid body", async () => {
			const ctx = makeRawContext({ body: { paymentIntentId: "pi_real999" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(mockStripe.refunds.create).not.toHaveBeenCalled();
		});
	});
});
