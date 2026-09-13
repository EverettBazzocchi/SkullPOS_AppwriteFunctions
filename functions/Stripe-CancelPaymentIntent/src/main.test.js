const { mockStripe, resetStripeMocks } = require("stripe");
const handler = require("./main.js").default;
const { makeContext: makeRawContext } = require("../../../test/helpers/handlerContext");

// The shared Stripe mock (test/mocks/stripe.js) has no paymentIntents.cancel
// spy -- this is the only function that calls it. Attach it here (and reset it
// alongside the shared spies) rather than leaving the handler calling
// undefined; it should move into the shared mock the next time that file is
// touched.
mockStripe.paymentIntents.cancel = jest.fn();

// Every test below represents a real, session-authenticated caller (this
// function's execute scope is admin/POS/PIN-team-only) unless a test explicitly
// needs to exercise the no-caller-identity rejection path, which uses
// makeRawContext directly.
function makeContext(opts = {}) {
	return makeRawContext({ ...opts, headers: { "x-appwrite-user-id": "pos-user", ...(opts.headers || {}) } });
}

describe("Stripe-CancelPaymentIntent", () => {
	beforeEach(() => {
		resetStripeMocks();
		mockStripe.paymentIntents.cancel.mockReset();
		process.env.testKey = "sk_test_fake";
		process.env.prodKey = "sk_live_fake";
	});

	test("cancels a POS intent and returns the cancelled intent under `data`", async () => {
		mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_payment_method" });
		mockStripe.paymentIntents.cancel.mockResolvedValue({ id: "pi_1", status: "canceled" });
		const ctx = makeContext({ body: { test: "", intent: "pi_1" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body).toEqual({ data: { id: "pi_1", status: "canceled" } });
		expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
		expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
	});

	test("{ test: 'test' } selects the test key", async () => {
		mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_capture" });
		mockStripe.paymentIntents.cancel.mockResolvedValue({ id: "pi_1", status: "canceled" });
		const ctx = makeContext({ body: { test: "test", intent: "pi_1" } });

		await handler(ctx);

		expect(mockStripe.lastConstructedWithKey).toBe("sk_test_fake");
	});

	// P2-19. The live/test decision is the one that picks which Stripe ACCOUNT
	// the call lands on, and it used to be spelled four different ways across the
	// four Stripe functions -- resolving the same body in opposite directions.
	// This table is duplicated verbatim in Stripe-CreatePaymentIntent's test file
	// and must stay identical to it: that is what "converged" means here. The one
	// deliberate difference is the last case, an ABSENT mode, where refusing would
	// strand an uncaptured intent on the reader instead of just declining to mint
	// one -- see the note at the call site.
	describe("live/test mode resolution", () => {
		const cancellable = (mode) => makeContext({ body: { intent: "pi_1", ...mode } });

		beforeEach(() => {
			mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_payment_method" });
			mockStripe.paymentIntents.cancel.mockResolvedValue({ id: "pi_1", status: "canceled" });
		});

		test.each([
			["{ test: 'test' }", { test: "test" }, "sk_test_fake"],
			["{ test: '' }", { test: "" }, "sk_live_fake"],
			["{ isLive: true }", { isLive: true }, "sk_live_fake"],
			["{ isLive: false }", { isLive: false }, "sk_test_fake"],
			["{ environment: 'live' }", { environment: "live" }, "sk_live_fake"],
			["{ environment: 'test' }", { environment: "test" }, "sk_test_fake"],
			["agreeing spellings", { isLive: false, environment: "test" }, "sk_test_fake"],
		])("%s selects the right key", async (_label, mode, expectedKey) => {
			await handler(cancellable(mode));

			expect(mockStripe.lastConstructedWithKey).toBe(expectedKey);
		});

		test.each([
			["a stringified isLive", { isLive: "true" }, /isLive must be true or false/],
			["an unrecognised environment", { environment: "production" }, /environment must be "live" or "test"/],
			["a non-string test flag", { test: true }, /test must be/],
			["two spellings that disagree", { isLive: true, environment: "test" }, /Contradictory Stripe mode/],
		])("%s is refused rather than guessed", async (_label, mode, expectedError) => {
			const result = await handler(cancellable(mode));

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(expectedError);
			expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
		});

		test("an absent mode still cancels -- against live, and says so", async () => {
			const ctx = cancellable({});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
			expect(ctx.error).toHaveBeenCalledWith(expect.stringMatching(/named no Stripe mode -- defaulting to LIVE/));
		});
	});

	describe("input validation", () => {
		test("an unparseable body is a 400, not a thrown execution", async () => {
			const ctx = makeContext({ body: {} });
			ctx.req.body = "not json";

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toBe("Invalid request body");
			expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
		});

		test("an empty body is a 400, not a thrown execution", async () => {
			const ctx = makeContext({ body: {} });
			ctx.req.body = "";

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
		});

		test("a missing intent id is a 400", async () => {
			const ctx = makeContext({ body: { test: "" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
		});

		test("a synthetic pi_tkt_ id is refused without calling Stripe", async () => {
			const ctx = makeContext({ body: { intent: "pi_tkt_abc" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
		});

		test("an id that isn't a payment intent at all is refused", async () => {
			const ctx = makeContext({ body: { intent: "ch_1234" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
		});

		test("a missing Stripe key for the requested mode is a 500 with a reason", async () => {
			delete process.env.prodKey;
			const ctx = makeContext({ body: { intent: "pi_1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(result.body.error).toBe("Stripe live key is not configured");
		});
	});

	describe("caller authorization and ownership", () => {
		test("refuses a call with no user session -- an API-key-only invocation", async () => {
			const ctx = makeRawContext({ body: { intent: "pi_1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(result.body).toEqual({ error: "Unauthorized" });
			expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
		});

		test("refuses to cancel another transaction's intent", async () => {
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_other_till",
				status: "requires_payment_method",
				metadata: { transactionId: "t_other" },
			});
			const ctx = makeContext({ body: { intent: "pi_other_till", transactionId: "t_mine" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
		});

		// This is the deploy-ordering seam, and it is the exact body a POS build that
		// predates transactionId-on-cancel sends: {test, intent}. CreatePaymentIntent
		// now stamps EVERY intent, so refusing an unnamed caller would 403 every cancel
		// from the deployed till -- stranding the amount on the reader with no way to
		// back out. Only a genuine mismatch is refused.
		test("cancels a stamped intent when the caller names no transaction -- the pre-release POS body shape", async () => {
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "requires_payment_method",
				metadata: { transactionId: "t1" },
			});
			mockStripe.paymentIntents.cancel.mockResolvedValue({ id: "pi_1", status: "canceled" });
			const ctx = makeContext({ body: { intent: "pi_1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
		});

		test("cancels when the named transaction matches the intent's metadata", async () => {
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "requires_payment_method",
				metadata: { transactionId: "t1" },
			});
			mockStripe.paymentIntents.cancel.mockResolvedValue({ id: "pi_1", status: "canceled" });
			const ctx = makeContext({ body: { intent: "pi_1", transactionId: "t1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
		});

		test("an unstamped legacy intent is still cancelable -- intents minted before CreatePaymentIntent stamped them", async () => {
			mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_payment_method", metadata: {} });
			mockStripe.paymentIntents.cancel.mockResolvedValue({ id: "pi_1", status: "canceled" });
			const ctx = makeContext({ body: { intent: "pi_1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
		});
	});

	describe("intent state and Stripe failures", () => {
		test("an intent that doesn't exist in the requested mode is a 404 naming the mode", async () => {
			mockStripe.paymentIntents.retrieve.mockRejectedValue(new Error("No such payment_intent: pi_1"));
			const ctx = makeContext({ body: { intent: "pi_1", test: "test" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(404);
			expect(result.body.error).toContain("test-mode");
			expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
		});

		test("cancelling an already-cancelled intent is idempotent, not a 500", async () => {
			mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "canceled" });
			const ctx = makeContext({ body: { intent: "pi_1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body.alreadyCancelled).toBe(true);
			expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
		});

		test("refuses to 'cancel' an intent whose money has already been captured", async () => {
			mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "succeeded" });
			const ctx = makeContext({ body: { intent: "pi_1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toContain("refund it instead");
			expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
		});

		test("a Stripe cancel failure returns a 500 with the reason instead of throwing", async () => {
			mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_payment_method" });
			mockStripe.paymentIntents.cancel.mockRejectedValue(new Error("intent in a non-cancelable state"));
			const ctx = makeContext({ body: { intent: "pi_1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(result.body.error).toBe("intent in a non-cancelable state");
			expect(ctx.error).toHaveBeenCalled();
		});
	});
});
