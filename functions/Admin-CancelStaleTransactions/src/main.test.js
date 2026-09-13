jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const doc = (id, status) => ({ $id: id, status });

describe("Admin-CancelStaleTransactions", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	test("cancels every stale pending transaction returned by the query", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [doc("t1", "pending"), doc("t2", "pending")] });
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body.staleFound).toBe(2);
		expect(result.body.cancelled).toBe(2);
		expect(mockDatabases.updateDocument).toHaveBeenCalledWith(expect.any(String), expect.any(String), "t1", { status: "cancelled" });
		expect(mockDatabases.updateDocument).toHaveBeenCalledWith(expect.any(String), expect.any(String), "t2", { status: "cancelled" });
	});

	test("queries only status:pending, created at or before the 1-hour cutoff", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: {} });

		await handler(ctx);

		const queries = mockDatabases.listDocuments.mock.calls[0][2];
		expect(queries).toContain('equal("status", "pending")');
		expect(queries.some((q) => q.startsWith('lessThanEqual("$createdAt"'))).toBe(true);
	});

	test("nothing to cancel when there are no stale pending transactions", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.staleFound).toBe(0);
		expect(result.body.cancelled).toBe(0);
		expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
	});

	test("pages through more than one page of results", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => doc(`p1-${i}`, "pending"));
		const page2 = [doc("p2-0", "pending")];
		mockDatabases.listDocuments.mockResolvedValueOnce({ documents: page1 }).mockResolvedValueOnce({ documents: page2 });
		mockDatabases.updateDocument.mockResolvedValue({});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(mockDatabases.listDocuments).toHaveBeenCalledTimes(2);
		expect(result.body.staleFound).toBe(101);
		expect(result.body.cancelled).toBe(101);
	});

	test("a failed cancel is reported but doesn't stop the run", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [doc("bad", "pending"), doc("good", "pending")] });
		mockDatabases.updateDocument.mockImplementation((_db, _col, id) =>
			id === "bad" ? Promise.reject(new Error("locked")) : Promise.resolve({})
		);
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.cancelled).toBe(1);
		expect(result.body.failures).toEqual([{ transactionId: "bad", error: "locked" }]);
	});

	test("surfaces a 500 if listing transactions fails", async () => {
		mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});

	describe("reversing already-recorded payment legs on auto-cancel", () => {
		function docWithLegs(id, payments) {
			return { $id: id, status: "pending", payments: JSON.stringify(payments) };
		}

		test("a transaction with no recorded legs is a plain no-op cancel", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ documents: [doc("t1", "pending")] });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.cancelled).toBe(1);
			expect(result.body.needsManualReview).toEqual([]);
			// only the transaction's own status update -- no giftcards collection touched
			expect(mockDatabases.updateDocument).toHaveBeenCalledTimes(1);
			expect(mockDatabases.getDocument).not.toHaveBeenCalled();
		});

		test("restores a recorded giftcard leg's balance when auto-cancelling", async () => {
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [docWithLegs("t1", [{ method: "giftcard", amount: 400, giftcardId: "gc1" }])],
			});
			mockDatabases.updateDocument.mockResolvedValue({});
			mockDatabases.getDocument.mockResolvedValue({ balance: 100 });
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.cancelled).toBe(1);
			const giftcardCall = mockDatabases.updateDocument.mock.calls.find((c) => c[2] === "gc1");
			expect(giftcardCall[3]).toEqual({ balance: 500 });
		});

		test("skips auto-cancelling a transaction with an already-captured stripe leg, reporting it for manual review", async () => {
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [docWithLegs("t1", [{ method: "stripe", amount: 1000, stripeId: "pi_1" }])],
			});
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.cancelled).toBe(0);
			expect(result.body.needsManualReview).toEqual([
				{ transactionId: "t1", reason: expect.stringMatching(/stripe 1000 \(pi_1\)/i) },
			]);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("skips auto-cancelling a transaction with a recorded CASH leg instead of silently cancelling it", async () => {
			// The money is already in the drawer: cancelling the row outright leaves that cash
			// corresponding to no recorded sale, and (before this) it wasn't even reported.
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [docWithLegs("t1", [{ method: "cash", amount: 2000 }])],
			});
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.cancelled).toBe(0);
			expect(result.body.needsManualReview).toEqual([{ transactionId: "t1", reason: expect.stringMatching(/cash 2000/i) }]);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("skips a part-cash/part-giftcard split rather than cancelling and reversing half of it", async () => {
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [
					docWithLegs("t1", [
						{ method: "giftcard", amount: 500, giftcardId: "gc1" },
						{ method: "cash", amount: 2000 },
					]),
				],
			});
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.cancelled).toBe(0);
			expect(result.body.needsManualReview).toHaveLength(1);
			// the giftcard leg must NOT be credited back on its own -- a human settles the whole row
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("skips a leg whose method this sweep has never heard of", async () => {
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [docWithLegs("t1", [{ method: "interac", amount: 900 }])],
			});
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.cancelled).toBe(0);
			expect(result.body.needsManualReview).toHaveLength(1);
		});

		test("skips a transaction carrying a stripe_id even with no recorded legs at all", async () => {
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [{ $id: "t1", status: "pending", stripe_id: "pi_legacy" }],
			});
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.cancelled).toBe(0);
			expect(result.body.needsManualReview).toEqual([{ transactionId: "t1", reason: expect.stringMatching(/pi_legacy/) }]);
		});

		describe("flagging cancellations that may already have been charged", () => {
			test("a card sale with no recorded leg is still cancelled, but reported as possibly charged", async () => {
				// Exactly the shape a captured card that failed to record leaves behind: the charge
				// went through Stripe, no leg was ever written, payment_due is still the full amount.
				mockDatabases.listDocuments.mockResolvedValue({
					documents: [{ $id: "t1", status: "pending", payment_method: "stripe", payment_due: 1200 }],
				});
				mockDatabases.updateDocument.mockResolvedValue({});
				const ctx = makeContext({ body: {} });

				const result = await handler(ctx);

				expect(result.body.cancelled).toBe(1);
				expect(result.body.cancelledPossiblyCharged).toEqual([
					{ transactionId: "t1", paymentMethod: "stripe", amount: 1200, reason: expect.stringMatching(/reconcile against Stripe/i) },
				]);
			});

			test("flags a split and a giftcard+stripe sale the same way", async () => {
				mockDatabases.listDocuments.mockResolvedValue({
					documents: [
						{ $id: "split-tx", status: "pending", payment_method: "split", payment_due: 4000 },
						{ $id: "gc-card-tx", status: "pending", payment_method: "giftcard+stripe", payment_due: 1500 },
					],
				});
				mockDatabases.updateDocument.mockResolvedValue({});
				const ctx = makeContext({ body: {} });

				const result = await handler(ctx);

				expect(result.body.cancelled).toBe(2);
				expect(result.body.cancelledPossiblyCharged.map((f) => f.transactionId)).toEqual(["split-tx", "gc-card-tx"]);
			});

			test("a plain cash sale that never took any money is cancelled with no flag", async () => {
				mockDatabases.listDocuments.mockResolvedValue({
					documents: [{ $id: "t1", status: "pending", payment_method: "cash", payment_due: 800 }],
				});
				mockDatabases.updateDocument.mockResolvedValue({});
				const ctx = makeContext({ body: {} });

				const result = await handler(ctx);

				expect(result.body.cancelled).toBe(1);
				expect(result.body.cancelledPossiblyCharged).toEqual([]);
			});

			test("a card-intent transaction that failed to cancel isn't reported as a cancellation", async () => {
				mockDatabases.listDocuments.mockResolvedValue({
					documents: [{ $id: "t1", status: "pending", payment_method: "stripe", payment_due: 1200 }],
				});
				mockDatabases.updateDocument.mockRejectedValue(new Error("locked"));
				const ctx = makeContext({ body: {} });

				const result = await handler(ctx);

				expect(result.body.cancelled).toBe(0);
				expect(result.body.cancelledPossiblyCharged).toEqual([]);
				expect(result.body.failures).toEqual([{ transactionId: "t1", error: "locked" }]);
			});
		});

		test("a mixed run: one plain cancel, one giftcard reversal, one skipped stripe leg", async () => {
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [
					doc("plain", "pending"),
					docWithLegs("giftcard-tx", [{ method: "giftcard", amount: 250, giftcardId: "gc1" }]),
					docWithLegs("stripe-tx", [{ method: "stripe", amount: 1000, stripeId: "pi_1" }]),
				],
			});
			mockDatabases.updateDocument.mockResolvedValue({});
			mockDatabases.getDocument.mockResolvedValue({ balance: 0 });
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.staleFound).toBe(3);
			expect(result.body.cancelled).toBe(2);
			expect(result.body.needsManualReview).toEqual([{ transactionId: "stripe-tx", reason: expect.any(String) }]);
			expect(mockDatabases.updateDocument.mock.calls.find((c) => c[2] === "gc1")[3]).toEqual({ balance: 250 });
		});

		test("reports a failed giftcard reversal in `failures` (transaction is still cancelled)", async () => {
			mockDatabases.listDocuments.mockResolvedValue({
				documents: [docWithLegs("t1", [{ method: "giftcard", amount: 400, giftcardId: "gc1" }])],
			});
			mockDatabases.updateDocument.mockResolvedValue({});
			mockDatabases.getDocument.mockRejectedValue(new Error("giftcard read failed"));
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.body.cancelled).toBe(1);
			expect(result.body.failures).toEqual([
				{ transactionId: "t1", error: expect.stringContaining("giftcard read failed") },
			]);
		});
	});
});
