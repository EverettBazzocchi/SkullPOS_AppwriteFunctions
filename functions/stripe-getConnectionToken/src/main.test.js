const { mockStripe, resetStripeMocks } = require("stripe");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

describe("stripe-getConnectionToken", () => {
	beforeEach(() => {
		resetStripeMocks();
		process.env.testKey = "sk_test_fake";
		process.env.prodKey = "sk_live_fake";
	});

	test("SkullPOS's empty body defaults to live mode", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body).toEqual({ secret: "tok_live", mode: "live" });
		expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
	});

	test("SkullPOS's { test: 'test' } shape selects test mode", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_test" });
		const ctx = makeContext({ body: { test: "test" } });

		const result = await handler(ctx);

		expect(result.body.mode).toBe("test");
		expect(mockStripe.lastConstructedWithKey).toBe("sk_test_fake");
	});

	test("SkullPOS's omitted test flag selects live mode", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
		const ctx = makeContext({ body: { register: "reader-1" } });

		const result = await handler(ctx);

		expect(result.body.mode).toBe("live");
		expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
	});

	test("Ticketing's { isLive: true } shape selects live mode", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
		const ctx = makeContext({ body: { isLive: true } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ secret: "tok_live", mode: "live" });
		expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
	});

	test("Ticketing's { isLive: false } shape selects test mode", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_test" });
		const ctx = makeContext({ body: { isLive: false } });

		const result = await handler(ctx);

		expect(result.body.mode).toBe("test");
		expect(mockStripe.lastConstructedWithKey).toBe("sk_test_fake");
	});

	test("Ticketing's { environment: 'live' } shape selects live mode", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
		const ctx = makeContext({ body: { environment: "live" } });

		const result = await handler(ctx);

		expect(result.body.mode).toBe("live");
		expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
	});

	test("an unparseable body falls back to live mode instead of throwing", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
		const ctx = makeContext({ body: {} });
		ctx.req.body = "not json";

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body.mode).toBe("live");
	});

	test("a Stripe API failure returns a 500 with the error message", async () => {
		mockStripe.terminal.connectionTokens.create.mockRejectedValue(new Error("stripe down"));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
		expect(result.body.error).toBe("stripe down");
	});
});
