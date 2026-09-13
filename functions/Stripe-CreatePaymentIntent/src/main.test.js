const { mockStripe, resetStripeMocks } = require("stripe");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

describe("Stripe-CreatePaymentIntent", () => {
	beforeEach(() => {
		resetStripeMocks();
		process.env.testKey = "sk_test_fake";
		process.env.prodKey = "sk_live_fake";
	});

	describe("SkullPOS's { test, amount } shape", () => {
		test("creates an intent with the test key and returns it nested under `intent`, unchanged", async () => {
			mockStripe.paymentIntents.create.mockResolvedValue({ id: "pi_1", client_secret: "secret_1" });
			const ctx = makeContext({ body: { test: "test", amount: 500, transactionId: "txn_abc" } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ intent: { id: "pi_1", client_secret: "secret_1" } });
			expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith({
				amount: 500,
				currency: 'cad',
				payment_method_types: ['card_present', 'interac_present'],
				capture_method: 'automatic',
				metadata: { transactionId: "txn_abc" },
			});
			expect(mockStripe.lastConstructedWithKey).toBe("sk_test_fake");
		});

		test("passes transactionId through as PaymentIntent metadata", async () => {
			mockStripe.paymentIntents.create.mockResolvedValue({ id: "pi_1", client_secret: "secret_1" });
			const ctx = makeContext({ body: { test: "test", amount: 500, transactionId: "txn_abc" } });

			await handler(ctx);

			expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
				expect.objectContaining({ metadata: { transactionId: "txn_abc" } }),
			);
		});

		// The server half of P0-1. An unstamped intent is still chargeable and captures
		// immediately, and Transaction-RecordPayment then refuses the leg for want of the stamp:
		// money taken, sale unrecordable. Refusing to mint it is free -- nothing has been captured
		// at this point -- and it is what stops the POS and the server drifting apart again.
		test.each([undefined, "", null, 123])("refuses to mint an intent with no usable transactionId (%p)", async (transactionId) => {
			mockStripe.paymentIntents.create.mockResolvedValue({ id: "pi_1", client_secret: "secret_1" });
			const ctx = makeContext({ body: { test: "test", amount: 500, transactionId } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/transactionId is required/);
			expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
		});

		test("an empty test flag uses the live key", async () => {
			mockStripe.paymentIntents.create.mockResolvedValue({ id: "pi_2", client_secret: "secret_2" });
			const ctx = makeContext({ body: { test: "", amount: 1200, transactionId: "txn_abc" } });

			await handler(ctx);

			expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
		});

		test("a Stripe API failure returns a 500 with the error message", async () => {
			mockStripe.paymentIntents.create.mockRejectedValue(new Error("stripe down"));
			const ctx = makeContext({ body: { test: "test", amount: 500, transactionId: "txn_abc" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(result.body.error).toBe("stripe down");
		});
	});

	describe("ShottyTicketing's { amount, currency, isLive } shape", () => {
		test("creates an intent and returns the flat clientSecret shape instead of `intent`", async () => {
			mockStripe.paymentIntents.create.mockResolvedValue({ client_secret: "pi_secret_123" });
			const ctx = makeContext({ body: { amount: 3000, currency: "cad", isLive: true } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ clientSecret: "pi_secret_123", amount: 3000, currency: "cad", mode: "live" });
			expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
		});

		test("uses the test key when isLive is false", async () => {
			mockStripe.paymentIntents.create.mockResolvedValue({ client_secret: "pi_secret_456" });
			const ctx = makeContext({ body: { amount: 1500, currency: "cad", isLive: false } });

			const result = await handler(ctx);

			expect(result.body.mode).toBe("test");
			expect(mockStripe.lastConstructedWithKey).toBe("sk_test_fake");
		});

		test("{ environment: 'live' } also selects live mode", async () => {
			mockStripe.paymentIntents.create.mockResolvedValue({ client_secret: "pi_secret_789" });
			const ctx = makeContext({ body: { amount: 2000, currency: "cad", environment: "live" } });

			const result = await handler(ctx);

			expect(result.body.mode).toBe("live");
		});

		test("defaults amount to the default door price when omitted/falsy", async () => {
			mockStripe.paymentIntents.create.mockResolvedValue({ client_secret: "pi_secret_000" });
			const ctx = makeContext({ body: { amount: 0, currency: "cad", isLive: true } });

			const result = await handler(ctx);

			expect(result.body.amount).toBe(3000);
		});

		test("a Stripe API failure returns a 500 with the error message", async () => {
			mockStripe.paymentIntents.create.mockRejectedValue(new Error("card declined"));
			const ctx = makeContext({ body: { amount: 3000, currency: "cad", isLive: true } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(result.body.error).toBe("card declined");
		});
	});

	// ShottyTicketing's door sales have no Transactions row, so the requirement above must not
	// reach them -- they are detected by their own fields, not by the absence of a transactionId.
	test("a ticketing-shaped request is not subject to the transactionId requirement", async () => {
		mockStripe.paymentIntents.create.mockResolvedValue({ client_secret: "pi_secret_123" });
		const ctx = makeContext({ body: { amount: 3000, currency: "cad", isLive: true } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body.clientSecret).toBe("pi_secret_123");
	});

	test("an invalid JSON body is rejected with a 400", async () => {
		const ctx = makeContext({ body: {} });
		ctx.req.body = "not json";

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});
});
