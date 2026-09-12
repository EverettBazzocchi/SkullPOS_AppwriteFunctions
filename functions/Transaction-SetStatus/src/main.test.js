jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

describe("Transaction-SetStatus", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	test("cancels a pending transaction", async () => {
		mockDatabases.getDocument.mockResolvedValue({ status: "pending" });
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

		const result = await handler(ctx);

		expect(result).toEqual({ statusCode: 200, body: { ok: true, status: "cancelled" } });
		expect(mockDatabases.updateDocument).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			"t1",
			{ status: "cancelled" },
		);
	});

	test.each(["complete", "refunded", "pending", "anything-else"])(
		"rejects %s -- only cancelled is ever allowed here",
		async (status) => {
			const ctx = makeContext({ body: { transactionId: "t1", status } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.getDocument).not.toHaveBeenCalled();
		},
	);

	test("rejects a missing transactionId", async () => {
		const ctx = makeContext({ body: { status: "cancelled" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});

	test("404s when the transaction doesn't exist", async () => {
		mockDatabases.getDocument.mockRejectedValue(new Error("not found"));
		const ctx = makeContext({ body: { transactionId: "missing", status: "cancelled" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(404);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("refuses to cancel a transaction that's already complete", async () => {
		mockDatabases.getDocument.mockResolvedValue({ status: "complete" });
		const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(result.body.error).toMatch(/not pending/i);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("refuses to re-cancel an already-cancelled transaction (no-op replay protection)", async () => {
		mockDatabases.getDocument.mockResolvedValue({ status: "cancelled" });
		const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("surfaces a 500 if the update itself fails", async () => {
		mockDatabases.getDocument.mockResolvedValue({ status: "pending" });
		mockDatabases.updateDocument.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});

	describe("reversing already-recorded payment legs on cancel", () => {
		test("cancelling a transaction with no recorded legs is a no-op besides the status change", async () => {
			mockDatabases.getDocument.mockResolvedValue({ status: "pending" });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true, status: "cancelled" } });
			// only the transaction's own status update -- no giftcards collection touched
			expect(mockDatabases.updateDocument).toHaveBeenCalledTimes(1);
			expect(mockDatabases.getDocument).toHaveBeenCalledTimes(1);
		});

		test("restores a recorded giftcard leg's balance when cancelling", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({
					status: "pending",
					payments: JSON.stringify([{ method: "giftcard", amount: 400, giftcardId: "gc1" }]),
				})
				.mockResolvedValueOnce({ balance: 100 }); // giftcard, read during reversal
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

			const result = await handler(ctx);

			expect(result.body).toEqual({
				ok: true,
				status: "cancelled",
				reversedGiftcards: [{ giftcardId: "gc1", amount: 400 }],
			});
			const giftcardCall = mockDatabases.updateDocument.mock.calls.find((c) => c[2] === "gc1");
			expect(giftcardCall[3]).toEqual({ balance: 500 });
		});

		test("restores every giftcard leg on a legacy 2-giftcard split", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({
					status: "pending",
					payments: JSON.stringify([
						{ method: "giftcard", amount: 200, giftcardId: "gc1" },
						{ method: "giftcard", amount: 300, giftcardId: "gc2" },
					]),
				})
				.mockResolvedValueOnce({ balance: 0 })
				.mockResolvedValueOnce({ balance: 50 });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

			const result = await handler(ctx);

			expect(result.body.reversedGiftcards).toEqual([
				{ giftcardId: "gc1", amount: 200 },
				{ giftcardId: "gc2", amount: 300 },
			]);
			expect(mockDatabases.updateDocument.mock.calls.find((c) => c[2] === "gc1")[3]).toEqual({ balance: 200 });
			expect(mockDatabases.updateDocument.mock.calls.find((c) => c[2] === "gc2")[3]).toEqual({ balance: 350 });
		});

		test("refuses to cancel a transaction with an already-captured stripe leg", async () => {
			mockDatabases.getDocument.mockResolvedValue({
				status: "pending",
				payments: JSON.stringify([{ method: "stripe", amount: 1000, stripeId: "pi_1" }]),
			});
			const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(409);
			expect(result.body.error).toMatch(/captured card payment/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("a mixed cash+giftcard split reverses only the giftcard leg", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({
					status: "pending",
					payments: JSON.stringify([
						{ method: "cash", amount: 200 },
						{ method: "giftcard", amount: 300, giftcardId: "gc1" },
					]),
				})
				.mockResolvedValueOnce({ balance: 0 });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(true);
			expect(result.body.reversedGiftcards).toEqual([{ giftcardId: "gc1", amount: 300 }]);
		});

		test("surfaces a 500 (transaction already cancelled) if the giftcard reversal fails", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({
					status: "pending",
					payments: JSON.stringify([{ method: "giftcard", amount: 400, giftcardId: "gc1" }]),
				})
				.mockRejectedValueOnce(new Error("giftcard read failed"));
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", status: "cancelled" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(result.body.error).toMatch(/handle manually/i);
			// the transaction status update itself already happened (idempotency guard) --
			// only the giftcard-collection read/write is what failed
			expect(mockDatabases.updateDocument).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				"t1",
				{ status: "cancelled" },
			);
		});
	});
});
