jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

describe("Admin-GeneratePin", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	describe("create", () => {
		test("creates a pins row with a hashed 4-digit code and returns the raw code once", async () => {
			mockDatabases.createDocument.mockResolvedValue({ $id: "pin1" });
			const ctx = makeContext({ body: { action: "create", system: "pos", label: "Bartender" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body.pinId).toBe("pin1");
			expect(result.body.label).toBe("Bartender");
			expect(result.body.system).toBe("pos");
			expect(result.body.pin).toMatch(/^\d{4}$/);

			const [, , , data] = mockDatabases.createDocument.mock.calls[0];
			expect(data.system).toBe("pos");
			expect(data.label).toBe("Bartender");
			expect(data.active).toBe(true);
			// the raw pin is never persisted, only its hash
			expect(data.hash).not.toBe(result.body.pin);
			expect(data.hash).toMatch(/^[0-9a-f]{64}$/);
		});

		test("rejects an invalid system", async () => {
			const ctx = makeContext({ body: { action: "create", system: "bogus", label: "X" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.createDocument).not.toHaveBeenCalled();
		});

		test("rejects a missing label", async () => {
			const ctx = makeContext({ body: { action: "create", system: "pos" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.createDocument).not.toHaveBeenCalled();
		});
	});

	describe("regenerate", () => {
		test("looks up the existing row, writes a new hash, and returns the new raw code", async () => {
			mockDatabases.getDocument.mockResolvedValue({ $id: "pin1", system: "ticketing", label: "Door Staff" });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { action: "regenerate", pinId: "pin1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body).toEqual({
				pinId: "pin1",
				pin: expect.stringMatching(/^\d{4}$/),
				label: "Door Staff",
				system: "ticketing",
			});
			expect(mockDatabases.updateDocument).toHaveBeenCalledWith(
				expect.any(String),
				"pins",
				"pin1",
				expect.objectContaining({ active: true, hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
			);
		});

		test("404s when the pin doesn't exist", async () => {
			mockDatabases.getDocument.mockRejectedValue(new Error("not found"));
			const ctx = makeContext({ body: { action: "regenerate", pinId: "missing" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(404);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("rejects a missing pinId", async () => {
			const ctx = makeContext({ body: { action: "regenerate" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
		});
	});

	describe("revoke", () => {
		test("sets active:false on the target row", async () => {
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { action: "revoke", pinId: "pin1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body.ok).toBe(true);
			expect(mockDatabases.updateDocument).toHaveBeenCalledWith(expect.any(String), "pins", "pin1", { active: false });
		});

		test("404s when the pin doesn't exist", async () => {
			mockDatabases.updateDocument.mockRejectedValue(new Error("not found"));
			const ctx = makeContext({ body: { action: "revoke", pinId: "missing" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(404);
		});

		test("rejects a missing pinId", async () => {
			const ctx = makeContext({ body: { action: "revoke" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
		});
	});

	test("rejects an invalid action", async () => {
		const ctx = makeContext({ body: { action: "delete" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});

	test("rejects an invalid JSON body", async () => {
		const ctx = makeContext({ body: {} });
		ctx.req.body = "not json";

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});
});
