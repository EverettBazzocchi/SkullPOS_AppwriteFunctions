const crypto = require("crypto");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const hash = (pin) => crypto.createHash("sha256").update(String(pin)).digest("hex");

describe("Verify-Pin", () => {
	const OLD_ENV = process.env;

	beforeEach(() => {
		process.env = { ...OLD_ENV };
	});

	afterAll(() => {
		process.env = OLD_ENV;
	});

	test("correct, active PIN returns ok:true with its label", async () => {
		process.env.PINS_JSON = JSON.stringify([{ hash: hash("1234"), label: "Bartender", active: true }]);
		const ctx = makeContext({ body: { pin: "1234" } });

		const result = await handler(ctx);

		expect(result).toEqual({ statusCode: 200, body: { ok: true, label: "Bartender" } });
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

		expect(result.body).toEqual({ ok: true, label: "Bartender" });
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
