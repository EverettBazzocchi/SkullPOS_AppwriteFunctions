jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const fetchMock = require("node-fetch");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");
const { deriveDeterministicId } = require("./deterministicId.js");

function conflictError() {
	const err = new Error("Document already exists");
	err.code = 409;
	return err;
}

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

const apiPaymentsPage = (data, hasMore = false, nextCursor = null) => ({
	ok: true,
	json: async () => ({ object: "list", data, has_more: hasMore, next_cursor: nextCursor }),
});

const zeffyPayment = (id, overrides = {}) => ({
	id,
	object: "payment",
	created: 1700000000,
	amount: 3000,
	currency: "cad",
	status: "succeeded",
	type: "online",
	description: "Fall Fundraiser",
	buyer: { email: "jane@example.com", first_name: "Jane", last_name: "Doe" },
	payment_method: { type: "card" },
	items: [{ id: `item_${id}`, object: "item", type: "donation", amount: 3000, rate_title: "Standard Ticket" }],
	...overrides,
});

describe("Admin-VerifyZeffyTickets", () => {
	const originalApiKey = process.env.ZEFFY_API_KEY;

	beforeEach(() => {
		resetAppwriteMocks();
		fetchMock.mockReset();
		delete process.env.ZEFFY_API_KEY;
	});

	afterAll(() => {
		process.env.ZEFFY_API_KEY = originalApiKey;
	});

	describe("failed_webhooks retry phase", () => {
		test("nothing to retry when there are no dead-lettered Zeffy webhooks", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body.failedWebhookRetry).toEqual({ retried: 0, succeeded: 0, stillFailing: [] });
		});

		test("only queries failed_webhooks filtered to source ZEFFY", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const ctx = makeContext({ body: {} });

			await handler(ctx);

			const [, collectionId, queries] = mockDatabases.listDocuments.mock.calls[0];
			expect(collectionId).toBe("failed_webhooks");
			expect(queries).toContain('equal("source", "ZEFFY")');
		});

		test("replays a dead-lettered payload and deletes the row once it succeeds", async () => {
			mockDatabases.listDocuments.mockResolvedValueOnce({ documents: [failedWebhookDoc("fw1")] });
			mockDatabases.createDocument.mockResolvedValue({});
			mockDatabases.deleteDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.failedWebhookRetry).toEqual({ retried: 1, succeeded: 1, stillFailing: [] });
			expect(mockDatabases.createDocument).toHaveBeenCalledWith(
				expect.any(String),
				"orders",
				deriveDeterministicId("zfo", "txn_123"),
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

			expect(result.body.failedWebhookRetry.retried).toBe(1);
			expect(result.body.failedWebhookRetry.succeeded).toBe(0);
			expect(result.body.failedWebhookRetry.stillFailing).toEqual([{ id: "fw1", error: "still down" }]);
			expect(mockDatabases.deleteDocument).not.toHaveBeenCalled();
		});

		test("reports an unparseable dead-lettered payload without throwing", async () => {
			mockDatabases.listDocuments.mockResolvedValueOnce({ documents: [{ $id: "fw-bad", source: "ZEFFY", payload: "{not json" }] });
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.failedWebhookRetry.retried).toBe(1);
			expect(result.body.failedWebhookRetry.succeeded).toBe(0);
			expect(result.body.failedWebhookRetry.stillFailing[0].id).toBe("fw-bad");
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

			expect(result.body.failedWebhookRetry).toEqual({ retried: 2, succeeded: 2, stillFailing: [] });
			expect(mockDatabases.deleteDocument).toHaveBeenCalledTimes(2);
		});

		test("reports a list failure without failing the whole run", async () => {
			mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body.failedWebhookRetry).toEqual({ retried: 0, succeeded: 0, stillFailing: [], listError: "Failed to list failed_webhooks" });
		});
	});

	describe("Zeffy API reconciliation phase", () => {
		test("skips the reconciliation pass when ZEFFY_API_KEY isn't configured", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.zeffyApiReconciliation).toEqual({ skipped: true, checked: 0, ordersCreated: 0, ticketsSaved: 0, failures: [] });
			expect(fetchMock).not.toHaveBeenCalled();
		});

		test("creates the missing order and ticket for a payment Zeffy has but this DB doesn't", async () => {
			process.env.ZEFFY_API_KEY = "test_key";
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			mockDatabases.createDocument.mockResolvedValue({});
			fetchMock.mockResolvedValueOnce(apiPaymentsPage([zeffyPayment("pay_1")]));
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.zeffyApiReconciliation).toEqual({ skipped: false, checked: 1, ordersCreated: 1, ticketsSaved: 1, failures: [] });
			expect(fetchMock).toHaveBeenCalledWith(
				expect.stringContaining("https://api.zeffy.com/api/v1/payments"),
				expect.objectContaining({ headers: { Authorization: "Bearer test_key" } })
			);
			expect(mockDatabases.createDocument).toHaveBeenCalledWith(
				expect.any(String),
				"orders",
				deriveDeterministicId("zfo", "pay_1"),
				expect.objectContaining({ orderId: "pay_1", customerEmail: "jane@example.com" })
			);
		});

		test("does not recreate a payment that's already recorded (deterministic id already exists)", async () => {
			process.env.ZEFFY_API_KEY = "test_key";
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			mockDatabases.createDocument.mockRejectedValue(conflictError());
			fetchMock.mockResolvedValueOnce(apiPaymentsPage([zeffyPayment("pay_1")]));
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.zeffyApiReconciliation).toEqual({ skipped: false, checked: 1, ordersCreated: 0, ticketsSaved: 0, failures: [] });
			expect(mockDatabases.createDocument).toHaveBeenCalledWith(
				expect.any(String),
				"orders",
				deriveDeterministicId("zfo", "pay_1"),
				expect.objectContaining({ orderId: "pay_1" })
			);
		});

		test("pages through more than one page of Zeffy payments", async () => {
			process.env.ZEFFY_API_KEY = "test_key";
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			mockDatabases.createDocument.mockResolvedValue({});
			fetchMock
				.mockResolvedValueOnce(apiPaymentsPage([zeffyPayment("pay_1")], true, "pay_1"))
				.mockResolvedValueOnce(apiPaymentsPage([zeffyPayment("pay_2")], false));
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(fetchMock.mock.calls[1][0]).toContain("starting_after=pay_1");
			expect(result.body.zeffyApiReconciliation.checked).toBe(2);
		});

		test("reports a Zeffy API failure without throwing", async () => {
			process.env.ZEFFY_API_KEY = "test_key";
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "invalid api key" });
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body.zeffyApiReconciliation.checked).toBe(0);
			expect(result.body.zeffyApiReconciliation.failures[0].error).toContain("401");
		});

		test("one payment failing to persist doesn't stop the rest from being checked", async () => {
			process.env.ZEFFY_API_KEY = "test_key";
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			mockDatabases.createDocument.mockImplementation((_db, collectionId, _id, data) =>
				data.orderId === "pay_bad" ? Promise.reject(new Error("boom")) : Promise.resolve({})
			);
			fetchMock.mockResolvedValueOnce(apiPaymentsPage([zeffyPayment("pay_bad"), zeffyPayment("pay_good")]));
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.zeffyApiReconciliation.checked).toBe(2);
			expect(result.body.zeffyApiReconciliation.ordersCreated).toBe(1);
			expect(result.body.zeffyApiReconciliation.failures).toEqual([{ id: "pay_bad", error: "boom" }]);
		});
	});
});
