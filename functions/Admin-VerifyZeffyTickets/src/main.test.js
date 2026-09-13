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
			expect(result.body.failedWebhookRetry).toEqual({ retried: 0, succeeded: 0, stillFailing: [], unreplayable: [] });
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

			expect(result.body.failedWebhookRetry).toEqual({ retried: 1, succeeded: 1, stillFailing: [], unreplayable: [] });
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

		// Previously this row landed in `stillFailing` and was re-parsed, re-failed and re-logged on
		// every run forever. It is reported under `unreplayable` now and stamped so later runs skip
		// it -- the assertion moved buckets, it wasn't weakened.
		test("reports an unparseable dead-lettered payload as unreplayable, without throwing", async () => {
			mockDatabases.listDocuments.mockResolvedValueOnce({ documents: [{ $id: "fw-bad", source: "ZEFFY", payload: "{not json" }] });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.failedWebhookRetry.retried).toBe(1);
			expect(result.body.failedWebhookRetry.succeeded).toBe(0);
			expect(result.body.failedWebhookRetry.stillFailing).toEqual([]);
			expect(result.body.failedWebhookRetry.unreplayable[0].id).toBe("fw-bad");
			expect(mockDatabases.createDocument).not.toHaveBeenCalled();
			expect(mockDatabases.deleteDocument).not.toHaveBeenCalled();
			expect(mockDatabases.updateDocument).toHaveBeenCalledWith(expect.any(String), "failed_webhooks", "fw-bad", {
				errorMessage: expect.stringMatching(/^UNREPLAYABLE: /),
			});
		});

		test("an already-stamped unreplayable row is reported but not reprocessed on later runs", async () => {
			mockDatabases.listDocuments.mockResolvedValueOnce({
				documents: [
					{ $id: "fw-bad", source: "ZEFFY", transactionId: "txn_bad", payload: "{not json", errorMessage: "UNREPLAYABLE: Unparseable dead-lettered payload: x" },
				],
			});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.failedWebhookRetry.unreplayable).toEqual([
				{ id: "fw-bad", transactionId: "txn_bad", error: expect.stringMatching(/^UNREPLAYABLE: /) },
			]);
			expect(result.body.failedWebhookRetry.stillFailing).toEqual([]);
			// no re-parse, no re-persist, and no second stamp write
			expect(mockDatabases.createDocument).not.toHaveBeenCalled();
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("a truncation marker is never replayed as if it were a payload", async () => {
			// Zeffy-Webhook writes this when the real payload doesn't fit failed_webhooks.payload.
			// Persisting it would write an order with no tickets; phase 2 recovers it properly.
			mockDatabases.listDocuments.mockResolvedValueOnce({
				documents: [
					{
						$id: "fw-big",
						source: "ZEFFY",
						transactionId: "txn_big",
						payload: JSON.stringify({ truncated: true, transactionId: "txn_big", itemCount: 40, originalLength: 8123 }),
					},
				],
			});
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(mockDatabases.createDocument).not.toHaveBeenCalled();
			expect(mockDatabases.deleteDocument).not.toHaveBeenCalled();
			expect(result.body.failedWebhookRetry.succeeded).toBe(0);
			expect(result.body.failedWebhookRetry.unreplayable).toEqual([
				{ id: "fw-big", transactionId: "txn_big", error: expect.stringMatching(/Zeffy Payments API/) },
			]);
			expect(mockDatabases.updateDocument).toHaveBeenCalledWith(expect.any(String), "failed_webhooks", "fw-big", {
				errorMessage: expect.stringMatching(/^UNREPLAYABLE: /),
			});
		});

		test("a genuinely retryable row is still retried alongside an unreplayable one", async () => {
			mockDatabases.listDocuments
				.mockResolvedValueOnce({
					documents: [{ $id: "fw-bad", source: "ZEFFY", payload: "{not json" }, failedWebhookDoc("fw-ok")],
				})
				.mockResolvedValue({ documents: [] });
			mockDatabases.createDocument.mockResolvedValue({});
			mockDatabases.updateDocument.mockResolvedValue({});
			mockDatabases.deleteDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.failedWebhookRetry.succeeded).toBe(1);
			expect(result.body.failedWebhookRetry.unreplayable).toHaveLength(1);
			expect(mockDatabases.deleteDocument).toHaveBeenCalledWith(expect.any(String), "failed_webhooks", "fw-ok");
		});

		test("processes multiple dead-lettered rows independently", async () => {
			mockDatabases.listDocuments
				.mockResolvedValueOnce({ documents: [failedWebhookDoc("fw1"), failedWebhookDoc("fw2", { ...parsedPayload, transactionId: "txn_456" })] })
				.mockResolvedValue({ documents: [] });
			mockDatabases.createDocument.mockResolvedValue({});
			mockDatabases.deleteDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.failedWebhookRetry).toEqual({ retried: 2, succeeded: 2, stillFailing: [], unreplayable: [] });
			expect(mockDatabases.deleteDocument).toHaveBeenCalledTimes(2);
		});

		test("reports a list failure without failing the whole run", async () => {
			mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body.failedWebhookRetry).toEqual({
				retried: 0,
				succeeded: 0,
				stillFailing: [],
				unreplayable: [],
				listError: "Failed to list failed_webhooks",
			});
		});
	});

	describe("Zeffy API reconciliation phase", () => {
		test("skips the reconciliation pass when ZEFFY_API_KEY isn't configured", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.zeffyApiReconciliation).toEqual({ skipped: true, checked: 0, ordersCreated: 0, ticketsSaved: 0, failures: [] });
			// no repairedOrders key at all -- the pass never ran, so it has nothing to say about it
			expect(fetchMock).not.toHaveBeenCalled();
		});

		test("creates the missing order and ticket for a payment Zeffy has but this DB doesn't", async () => {
			process.env.ZEFFY_API_KEY = "test_key";
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			mockDatabases.createDocument.mockResolvedValue({});
			fetchMock.mockResolvedValueOnce(apiPaymentsPage([zeffyPayment("pay_1")]));
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.zeffyApiReconciliation).toEqual({
				skipped: false,
				checked: 1,
				ordersCreated: 1,
				ticketsSaved: 1,
				repairedOrders: [],
				failures: [],
			});
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

			expect(result.body.zeffyApiReconciliation).toEqual({
				skipped: false,
				checked: 1,
				ordersCreated: 0,
				ticketsSaved: 0,
				// nothing to repair: the order existed AND every one of its tickets did too
				repairedOrders: [],
				failures: [],
			});
			expect(mockDatabases.createDocument).toHaveBeenCalledWith(
				expect.any(String),
				"orders",
				deriveDeterministicId("zfo", "pay_1"),
				expect.objectContaining({ orderId: "pay_1" })
			);
		});

		test("a payment with no line items still yields one ticket, like the webhook path does", async () => {
			// The webhook parser synthesizes a single line item for an item-less payload; this
			// parser didn't, so the same payment wrote an order and ZERO tickets here -- and every
			// later run then 409'd on that order and reported nothing wrong while the buyer had no
			// ticket to scan at the door.
			process.env.ZEFFY_API_KEY = "test_key";
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			mockDatabases.createDocument.mockResolvedValue({});
			fetchMock.mockResolvedValueOnce(apiPaymentsPage([zeffyPayment("pay_noitems", { items: [], amount: 4500 })]));
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.zeffyApiReconciliation).toMatchObject({ checked: 1, ordersCreated: 1, ticketsSaved: 1 });
			const ticketCreate = mockDatabases.createDocument.mock.calls.find((c) => c[1] === "tickets");
			expect(ticketCreate[3]).toMatchObject({ orderId: "pay_noitems", price: 4500, status: "VALID" });
		});

		test("re-reconciling an item-less payment does not mint a second ticket", async () => {
			process.env.ZEFFY_API_KEY = "test_key";
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			const created = new Set();
			mockDatabases.createDocument.mockImplementation((_db, collectionId, id) => {
				const key = `${collectionId}/${id}`;
				if (created.has(key)) return Promise.reject(conflictError());
				created.add(key);
				return Promise.resolve({});
			});
			fetchMock
				.mockResolvedValueOnce(apiPaymentsPage([zeffyPayment("pay_noitems", { items: [], amount: 4500 })]))
				.mockResolvedValueOnce(apiPaymentsPage([zeffyPayment("pay_noitems", { items: [], amount: 4500 })]));

			const first = await handler(makeContext({ body: {} }));
			const second = await handler(makeContext({ body: {} }));

			expect(first.body.zeffyApiReconciliation).toMatchObject({ ordersCreated: 1, ticketsSaved: 1 });
			expect(second.body.zeffyApiReconciliation).toMatchObject({ ordersCreated: 0, ticketsSaved: 0 });
		});

		test("an existing order that is missing tickets is repaired and reported, not passed over as healthy", async () => {
			// The case an order row alone could never rule out: the order was written, its tickets
			// were not (a run that died between the two writes, or the id-less-line-item bug that
			// made the ticket writes non-idempotent). Every previous run 409'd on the order and
			// reported a clean sweep while the buyer had nothing to scan.
			process.env.ZEFFY_API_KEY = "test_key";
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			mockDatabases.createDocument.mockImplementation((_db, collectionId) =>
				collectionId === "orders" ? Promise.reject(conflictError()) : Promise.resolve({})
			);
			fetchMock.mockResolvedValueOnce(
				apiPaymentsPage([
					zeffyPayment("pay_partial", {
						items: [
							{ id: "i1", amount: 1500, rate_title: "Standard Ticket" },
							{ id: "i2", amount: 1500, rate_title: "Standard Ticket" },
						],
					}),
				])
			);
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.zeffyApiReconciliation).toMatchObject({
				ordersCreated: 0,
				ticketsSaved: 2,
				repairedOrders: [{ id: "pay_partial", ticketsCreated: 2, ticketsExpected: 2 }],
			});
		});

		test("an order and tickets that are all already present reports no repair", async () => {
			process.env.ZEFFY_API_KEY = "test_key";
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
			mockDatabases.createDocument.mockRejectedValue(conflictError());
			fetchMock.mockResolvedValueOnce(apiPaymentsPage([zeffyPayment("pay_complete")]));
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.zeffyApiReconciliation.repairedOrders).toEqual([]);
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
