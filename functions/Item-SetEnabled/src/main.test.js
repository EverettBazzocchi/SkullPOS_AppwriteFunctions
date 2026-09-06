jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

describe("Item-SetEnabled", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	test("enables an item and writes only enabled_menu", async () => {
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: { itemId: "item-1", enabled: true } });

		const result = await handler(ctx);

		expect(result).toEqual({ statusCode: 200, body: { ok: true, enabled: true } });
		expect(mockDatabases.updateDocument).toHaveBeenCalledTimes(1);
		const [, , itemId, data] = mockDatabases.updateDocument.mock.calls[0];
		expect(itemId).toBe("item-1");
		expect(data).toEqual({ enabled_menu: true });
	});

	test("disables an item", async () => {
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: { itemId: "item-1", enabled: false } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true, enabled: false });
	});

	test("writes enabled_pos when field is given", async () => {
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: { itemId: "item-1", enabled: true, field: "enabled_pos" } });

		await handler(ctx);

		const [, , , data] = mockDatabases.updateDocument.mock.calls[0];
		expect(data).toEqual({ enabled_pos: true });
	});

	test("rejects an unrecognized field", async () => {
		const ctx = makeContext({ body: { itemId: "item-1", enabled: true, field: "price" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("rejects a missing itemId", async () => {
		const ctx = makeContext({ body: { enabled: true } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("rejects a non-boolean enabled value", async () => {
		const ctx = makeContext({ body: { itemId: "item-1", enabled: "true" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("returns 404 when the item doesn't exist / update fails", async () => {
		mockDatabases.updateDocument.mockRejectedValue(new Error("document_not_found"));
		const ctx = makeContext({ body: { itemId: "missing-item", enabled: true } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(404);
	});
});
