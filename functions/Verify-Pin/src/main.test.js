jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const crypto = require("crypto");
const { mockDatabases, mockTeams, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
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

		expect(result).toEqual({ statusCode: 200, body: { ok: true, label: "Bartender", selfCheckout: false } });
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

		expect(result.body).toEqual({ ok: true, label: "Self-Checkout Kiosk 1", selfCheckout: true });
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

			expect(result.body).toEqual({ ok: true, label: "Bartender", selfCheckout: false });
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
});
