jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const crypto = require("crypto");
const { mockTeams, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const hash = (pin) => crypto.createHash("sha256").update(String(pin)).digest("hex");
const PIN_PAYMENT_TEAM_ID = "6a9cbb1c95ea7d59dd8c";

describe("Verify-Pin", () => {
	const OLD_ENV = process.env;

	beforeEach(() => {
		process.env = { ...OLD_ENV };
		resetAppwriteMocks();
		mockTeams.createMembership.mockResolvedValue({});
	});

	afterAll(() => {
		process.env = OLD_ENV;
	});

	test("correct, active PIN returns ok:true with its label", async () => {
		process.env.PINS_JSON = JSON.stringify([{ hash: hash("1234"), label: "Bartender", active: true }]);
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result).toEqual({ statusCode: 200, body: { ok: true, label: "Bartender", selfCheckout: false } });
	});

	test("wrong PIN returns ok:false and never reveals why", async () => {
		process.env.PINS_JSON = JSON.stringify([{ hash: hash("1234"), label: "Bartender", active: true }]);
		const ctx = makeContext({ body: { pin: "9999" } });

		const result = await handler(ctx);

		expect(result).toEqual({ statusCode: 200, body: { ok: false } });
	});

	test("a PIN marked inactive is treated as no match", async () => {
		process.env.PINS_JSON = JSON.stringify([{ hash: hash("1234"), label: "Bartender", active: false }]);
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: false });
	});

	test("a PIN with no active field defaults to active", async () => {
		process.env.PINS_JSON = JSON.stringify([{ hash: hash("1234"), label: "Bartender" }]);
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true, label: "Bartender", selfCheckout: false });
	});

	test("a PIN flagged selfCheckout:true reports it in the response", async () => {
		process.env.PINS_JSON = JSON.stringify([
			{ hash: hash("1234"), label: "Self-Checkout Kiosk 1", active: true, selfCheckout: true },
		]);
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true, label: "Self-Checkout Kiosk 1", selfCheckout: true });
	});

	test("a PIN with no selfCheckout field reports selfCheckout:false (ordinary staff PIN)", async () => {
		process.env.PINS_JSON = JSON.stringify([{ hash: hash("1234"), label: "Bartender", active: true }]);
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result.body.selfCheckout).toBe(false);
	});

	describe("payment-team membership grant", () => {
		test("grants payment-team membership to the caller on a successful match", async () => {
			process.env.PINS_JSON = JSON.stringify([{ hash: hash("1234"), label: "Bartender", active: true }]);
			const ctx = makeContext({ body: { pin: "1234" }, headers: { "x-appwrite-user-id": "u1" } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(true);
			expect(mockTeams.createMembership).toHaveBeenCalledWith(PIN_PAYMENT_TEAM_ID, [], undefined, "u1");
		});

		test("still succeeds even if granting membership fails", async () => {
			process.env.PINS_JSON = JSON.stringify([{ hash: hash("1234"), label: "Bartender", active: true }]);
			mockTeams.createMembership.mockRejectedValue(new Error("team API down"));
			const ctx = makeContext({ body: { pin: "1234" }, headers: { "x-appwrite-user-id": "u1" } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, label: "Bartender", selfCheckout: false });
		});

		test("does not attempt to grant membership when no caller id is present", async () => {
			process.env.PINS_JSON = JSON.stringify([{ hash: hash("1234"), label: "Bartender", active: true }]);
			const ctx = makeContext({ body: { pin: "1234" } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(true);
			expect(mockTeams.createMembership).not.toHaveBeenCalled();
		});

		test("does not attempt to grant membership when the PIN doesn't match", async () => {
			process.env.PINS_JSON = JSON.stringify([{ hash: hash("1234"), label: "Bartender", active: true }]);
			const ctx = makeContext({ body: { pin: "9999" }, headers: { "x-appwrite-user-id": "u1" } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: false });
			expect(mockTeams.createMembership).not.toHaveBeenCalled();
		});
	});

	test("missing pin is rejected with 400", async () => {
		process.env.PINS_JSON = "[]";
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(result.body.ok).toBe(false);
	});

	test("invalid JSON request body is rejected with 400", async () => {
		const ctx = makeContext({ body: {} });
		ctx.req.body = "{not json";

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});

	test("malformed PINS_JSON env var fails closed with 500, not a crash", async () => {
		process.env.PINS_JSON = "{not valid json";
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
		expect(result.body.ok).toBe(false);
	});

	test("missing PINS_JSON env var (unset) behaves as no PINs configured", async () => {
		delete process.env.PINS_JSON;
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: false });
	});
});
