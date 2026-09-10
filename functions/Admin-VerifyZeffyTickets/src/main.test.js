jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const parsedPayload = {
	eventType: "payment.completed",
	transactionId: "txn_123",
	eventName: "Fall Fundraiser",
	amount: 3000,
	currency: "CAD",
	buyerName: "Jane Doe",
	email: "jane@example.com",
	paymentMethodType: "card",
	items: [{ id: "item_1", amount: 3000, type: "Standard Ticket" }],
};

const failedWebhookDoc = (id, payload = parsedPayload) => ({ $id: id, source: "ZEFFY", payload: JSON.stringify(payload) });

describe("Admin-VerifyZeffyTickets", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	test("nothing to retry when there are no dead-lettered Zeffy webhooks", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body).toEqual({ retried: 0, succeeded: 0, stillFailing: [] });
	});

	test("only queries failed_webhooks filtered to source ZEFFY", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: {} });

		await handler(ctx);

		const [dbId, collectionId, queries] = mockDatabases.listDocuments.mock.calls[0];
		expect(collectionId).toBe("failed_webhooks");
		expect(queries).toContain('equal("source", "ZEFFY")');
	});

	test("replays a dead-lettered payload and deletes the row once it succeeds", async () => {
		mockDatabases.listDocuments
			.mockResolvedValueOnce({ documents: [failedWebhookDoc("fw1")] })
			// persistZeffyPayment's own internal listDocuments calls (orders, tickets existence checks)
			.mockResolvedValue({ documents: [] });
		mockDatabases.createDocument.mockResolvedValue({});
		mockDatabases.deleteDocument.mockResolvedValue({});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body).toEqual({ retried: 1, succeeded: 1, stillFailing: [] });
		expect(mockDatabases.createDocument).toHaveBeenCalledWith(
			expect.any(String),
			"orders",
			"unique()",
			expect.objectContaining({ orderId: "txn_123" })
		);
		expect(mockDatabases.deleteDocument).toHaveBeenCalledWith(expect.any(String), "failed_webhooks", "fw1");
	});

	test("leaves the row in place and reports it when the retry still fails", async () => {
		mockDatabases.listDocuments
			.mockResolvedValueOnce({ documents: [failedWebhookDoc("fw1")] })
			.mockResolvedValue({ documents: [] });
		mockDatabases.createDocument.mockRejectedValue(new Error("still down"));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.retried).toBe(1);
		expect(result.body.succeeded).toBe(0);
		expect(result.body.stillFailing).toEqual([{ id: "fw1", error: "still down" }]);
		expect(mockDatabases.deleteDocument).not.toHaveBeenCalled();
	});

	test("reports an unparseable dead-lettered payload without throwing", async () => {
		mockDatabases.listDocuments.mockResolvedValueOnce({ documents: [{ $id: "fw-bad", source: "ZEFFY", payload: "{not json" }] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.retried).toBe(1);
		expect(result.body.succeeded).toBe(0);
		expect(result.body.stillFailing[0].id).toBe("fw-bad");
		expect(mockDatabases.createDocument).not.toHaveBeenCalled();
	});

	test("processes multiple dead-lettered rows independently", async () => {
		mockDatabases.listDocuments
			.mockResolvedValueOnce({ documents: [failedWebhookDoc("fw1"), failedWebhookDoc("fw2", { ...parsedPayload, transactionId: "txn_456" })] })
			.mockResolvedValue({ documents: [] });
		mockDatabases.createDocument.mockResolvedValue({});
		mockDatabases.deleteDocument.mockResolvedValue({});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body).toEqual({ retried: 2, succeeded: 2, stillFailing: [] });
		expect(mockDatabases.deleteDocument).toHaveBeenCalledTimes(2);
	});

	test("surfaces a 500 if listing failed_webhooks fails", async () => {
		mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});
});
