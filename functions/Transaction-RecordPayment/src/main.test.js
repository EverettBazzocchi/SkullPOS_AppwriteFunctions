jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const { mockStripe, resetStripeMocks } = require("stripe");
const mockFetch = require("node-fetch");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const baseTransaction = (overrides = {}) => ({
	status: "pending",
	payment_due: 1000,
	testing: true,
	tip: 0,
	payments: null,
	...overrides,
});

describe("Transaction-RecordPayment", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		resetStripeMocks();
		mockFetch.mockReset();
		process.env.testKey = "sk_test_fake";
		process.env.prodKey = "sk_live_fake";
		process.env.RESEND_API_KEY = "re_test_key";
		process.env.FINANCE_NOTIFICATION_EMAIL_TEST = "everett.bazzocchi@skullspace.ca";
		process.env.FINANCE_NOTIFICATION_EMAIL_PROD = "finance@skullspace.ca";
	});

	describe("cash legs", () => {
		test("a full cash payment completes the transaction", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1000 } });

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true, remaining: 0, status: "complete" } });
			const [, , , data] = mockDatabases.updateDocument.mock.calls[0];
			expect(data.status).toBe("complete");
			expect(data.payment_due).toBe(0);
			expect(data.payment_method).toBe("cash");
			expect(JSON.parse(data.payments)).toEqual([{ method: "cash", amount: 1000 }]);
		});

		test("a partial cash payment leaves the transaction pending with the right remainder", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 300 } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 700, status: "pending" });
		});

		test("a second leg on top of an existing one flips payment_method to split", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ payment_due: 700, payments: JSON.stringify([{ method: "cash", amount: 300 }]) }),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 700 } });

			await handler(ctx);

			const [, , , data] = mockDatabases.updateDocument.mock.calls[0];
			expect(data.payment_method).toBe("split");
			expect(JSON.parse(data.payments)).toEqual([
				{ method: "cash", amount: 300 },
				{ method: "cash", amount: 700 },
			]);
		});
	});

	describe("giftcard legs", () => {
		test("applies a giftcard leg and decrements its balance", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction()) // transaction
				.mockResolvedValueOnce({ balance: 5000 }); // giftcard
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "giftcard", amount: 400, giftcardId: "gc1" },
			});

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 600, status: "pending" });
			// first updateDocument call is the giftcard balance decrement
			const giftcardCall = mockDatabases.updateDocument.mock.calls.find((c) => c[2] === "gc1");
			expect(giftcardCall[3]).toEqual({ balance: 4600 });
		});

		test("rejects a giftcard leg exceeding the giftcard's own balance", async () => {
			mockDatabases.getDocument.mockResolvedValueOnce(baseTransaction()).mockResolvedValueOnce({ balance: 100 });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "giftcard", amount: 400, giftcardId: "gc1" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("rejects a giftcard leg with no giftcardId", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			const ctx = makeContext({ body: { transactionId: "t1", method: "giftcard", amount: 400 } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
		});

		test("404s when the giftcard doesn't exist", async () => {
			mockDatabases.getDocument.mockResolvedValueOnce(baseTransaction()).mockRejectedValueOnce(new Error("nope"));
			const ctx = makeContext({
				body: { transactionId: "t1", method: "giftcard", amount: 400, giftcardId: "missing" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(404);
		});
	});

	describe("DJ voucher legs", () => {
		const voucherCtx = () =>
			makeContext({ body: { transactionId: "t1", method: "giftcard", amount: 400, giftcardId: "gc1" } });

		test("rejects a revoked voucher", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce({ balance: 2000, events: "event1", active: false });

			const result = await handler(voucherCtx());

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/revoked/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("rejects a voucher leg when a discount is applied to the sale", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction({ discount: 200 }))
				.mockResolvedValueOnce({ balance: 2000, events: "event1", active: true });

			const result = await handler(voucherCtx());

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/combined with a discount/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("rejects a voucher leg when no event is currently active", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce({ balance: 2000, events: "event1", active: true });
			mockDatabases.listDocuments.mockResolvedValue({ documents: [] });

			const result = await handler(voucherCtx());

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/only valid during its own event/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("rejects a voucher leg when a different event is currently active", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce({ balance: 2000, events: "event1", active: true });
			mockDatabases.listDocuments.mockResolvedValue({ documents: [{ $id: "event2" }] });

			const result = await handler(voucherCtx());

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/only valid during its own event/i);
		});

		test("accepts a voucher leg when active, matching event, and no discount", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce({ balance: 2000, events: "event1", active: true });
			mockDatabases.listDocuments.mockResolvedValue({ documents: [{ $id: "event1" }] });
			mockDatabases.updateDocument.mockResolvedValue({});

			const result = await handler(voucherCtx());

			expect(result.body).toEqual({ ok: true, remaining: 600, status: "pending" });
			const giftcardCall = mockDatabases.updateDocument.mock.calls.find((c) => c[2] === "gc1");
			expect(giftcardCall[3]).toEqual({ balance: 1600 });
		});

		test("a standing giftcard (no events link) is unaffected by the discount rule", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction({ discount: 500 }))
				.mockResolvedValueOnce({ balance: 2000 }); // no `events`, no `active` -- a standard giftcard
			mockDatabases.updateDocument.mockResolvedValue({});

			const result = await handler(voucherCtx());

			expect(result.body).toEqual({ ok: true, remaining: 600, status: "pending" });
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
		});
	});

	describe("stripe legs", () => {
		test("records a verified card charge, including its tip", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1000,
				amount_details: { tip: { amount: 150 } },
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete" });
			const [, , , data] = mockDatabases.updateDocument.mock.calls[0];
			expect(data.tip).toBe(150);
			expect(JSON.parse(data.payments)[0]).toEqual({ method: "stripe", amount: 1000, stripeId: "pi_1", tip: 150 });
		});

		test("uses the test Stripe key for a testing transaction", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ testing: true }));
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1000,
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			await handler(ctx);

			expect(mockStripe.lastConstructedWithKey).toBe("sk_test_fake");
		});

		test("uses the live Stripe key for a real (non-testing) transaction", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ testing: false }));
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1000,
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			await handler(ctx);

			expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
		});

		test("rejects when the PaymentIntent isn't succeeded", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "requires_payment_method", amount: 1000 });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("anti-forgery: rejects when the PaymentIntent amount doesn't match the claimed leg amount", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "succeeded", amount: 99999 });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/does not match/i);
		});

		test("rejects a stripe leg with no paymentIntentId", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			const ctx = makeContext({ body: { transactionId: "t1", method: "stripe", amount: 1000 } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
		});

		test("surfaces a 400 if Stripe verification itself throws", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockStripe.paymentIntents.retrieve.mockRejectedValue(new Error("network error"));
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
		});

		describe("anti-replay: PaymentIntent must belong to this transaction", () => {
			test("rejects a PaymentIntent with no metadata at all", async () => {
				mockDatabases.getDocument.mockResolvedValue(baseTransaction());
				mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: "succeeded", amount: 1000 });
				const ctx = makeContext({
					body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
				});

				const result = await handler(ctx);

				expect(result.statusCode).toBe(400);
				expect(result.body.error).toMatch(/not created for this transaction/i);
				expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
			});

			test("rejects a PaymentIntent whose metadata.transactionId points at a different transaction", async () => {
				mockDatabases.getDocument.mockResolvedValue(baseTransaction());
				mockStripe.paymentIntents.retrieve.mockResolvedValue({
					id: "pi_1",
					status: "succeeded",
					amount: 1000,
					metadata: { transactionId: "some-other-transaction" },
				});
				const ctx = makeContext({
					body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
				});

				const result = await handler(ctx);

				expect(result.statusCode).toBe(400);
				expect(result.body.error).toMatch(/not created for this transaction/i);
				expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
			});

			test("rejects a PaymentIntent already recorded against a different transaction", async () => {
				mockDatabases.getDocument.mockResolvedValue(baseTransaction());
				mockStripe.paymentIntents.retrieve.mockResolvedValue({
					id: "pi_1",
					status: "succeeded",
					amount: 1000,
					metadata: { transactionId: "t1" },
				});
				mockDatabases.listDocuments.mockResolvedValue({ documents: [{ $id: "t-other", stripe_id: "pi_1" }] });
				const ctx = makeContext({
					body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
				});

				const result = await handler(ctx);

				expect(result.statusCode).toBe(400);
				expect(result.body.error).toMatch(/already been used on another transaction/i);
				expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
			});

			test("does not treat this same transaction showing up in the reuse-check results as reuse", async () => {
				mockDatabases.getDocument.mockResolvedValue(baseTransaction());
				mockDatabases.updateDocument.mockResolvedValue({});
				mockStripe.paymentIntents.retrieve.mockResolvedValue({
					id: "pi_1",
					status: "succeeded",
					amount: 1000,
					metadata: { transactionId: "t1" },
				});
				mockDatabases.listDocuments.mockResolvedValue({ documents: [{ $id: "t1", stripe_id: "pi_1" }] });
				const ctx = makeContext({
					body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
				});

				const result = await handler(ctx);

				expect(result.body.ok).toBe(true);
			});

			test("keeps stripe_id in sync on the transaction so a future reuse check can find this leg", async () => {
				mockDatabases.getDocument.mockResolvedValue(baseTransaction());
				mockDatabases.updateDocument.mockResolvedValue({});
				mockStripe.paymentIntents.retrieve.mockResolvedValue({
					id: "pi_1",
					status: "succeeded",
					amount: 1000,
					metadata: { transactionId: "t1" },
				});
				const ctx = makeContext({
					body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
				});

				await handler(ctx);

				const [, , , data] = mockDatabases.updateDocument.mock.calls[0];
				expect(data.stripe_id).toBe("pi_1");
			});
		});
	});

	describe("self-checkout channel enforcement", () => {
		test("rejects a cash leg against a self_checkout transaction", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ channel: "self_checkout" }));
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 500 } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/only be paid by card/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("rejects a giftcard leg against a self_checkout transaction", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ channel: "self_checkout" }));
			const ctx = makeContext({
				body: { transactionId: "t1", method: "giftcard", amount: 500, giftcardId: "gc1" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/only be paid by card/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("allows a stripe leg against a self_checkout transaction", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ channel: "self_checkout" }));
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1000,
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.body.ok).toBe(true);
		});

		test("a transaction with no channel field (pre-migration) or channel:'pos' is unaffected", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1000 } });

			const result = await handler(ctx);

			expect(result.body.ok).toBe(true);
		});
	});

	describe("membership dues channel", () => {
		test("rejects a cash leg against a membership transaction", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ channel: "membership" }));
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1000 } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/only be paid by card/i);
		});

		test("rejects a giftcard leg against a membership transaction", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ channel: "membership" }));
			const ctx = makeContext({
				body: { transactionId: "t1", method: "giftcard", amount: 1000, giftcardId: "gc1" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/only be paid by card/i);
		});

		test("a completed membership stripe leg automatically notifies finance", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({
					channel: "membership",
					total: 4000,
					member_name: "Jane Member",
					member_email: "jane@example.com",
				}),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1000,
				metadata: { transactionId: "t1" },
			});
			mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete" });
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.resend.com/emails",
				expect.objectContaining({ method: "POST" }),
			);
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.to).toEqual(["everett.bazzocchi@skullspace.ca"]);
			expect(sentBody.cc).toEqual(expect.arrayContaining(["everett.bazzocchi@skullspace.ca", "jane@example.com"]));
			expect(sentBody.html).toContain("Jane Member");
			expect(sentBody.html).toContain("jane@example.com");
			expect(sentBody.html).toContain("admin@skullspace.ca");
		});

		test("does not cc the member when no valid member_email is on the transaction", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ channel: "membership", total: 4000 }));
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1000,
				metadata: { transactionId: "t1" },
			});
			mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			await handler(ctx);

			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.cc).toEqual(["everett.bazzocchi@skullspace.ca"]);
		});

		test("a non-testing membership payment notifies finance's real address, not the test one", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ channel: "membership", testing: false, total: 4000 }),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1000,
				metadata: { transactionId: "t1" },
			});
			mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			await handler(ctx);

			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.to).toEqual(["finance@skullspace.ca"]);
		});

		test("a partial membership leg (still pending) does not notify finance yet", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ channel: "membership", payment_due: 4000 }));
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1000,
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.body.status).toBe("pending");
			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("a finance-notification failure does not fail the payment response", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ channel: "membership", total: 1000 }));
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1000,
				metadata: { transactionId: "t1" },
			});
			mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("resend down") });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete" });
		});

		test("a completed non-membership transaction never triggers the finance email", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ channel: "self_checkout" }));
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1000,
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.body.status).toBe("complete");
			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	describe("general validation and idempotency", () => {
		test("rejects an unknown payment method", async () => {
			const ctx = makeContext({ body: { transactionId: "t1", method: "bitcoin", amount: 1000 } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.getDocument).not.toHaveBeenCalled();
		});

		test.each([0, -50, NaN, undefined])("rejects a non-positive amount (%p)", async (amount) => {
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
		});

		test("404s when the transaction doesn't exist", async () => {
			mockDatabases.getDocument.mockRejectedValue(new Error("not found"));
			const ctx = makeContext({ body: { transactionId: "missing", method: "cash", amount: 100 } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(404);
		});

		test("refuses a leg on a transaction that's already complete (retry-safety guard)", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ status: "complete", payment_due: 0 }));
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 100 } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/not pending/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("refuses a leg amount that exceeds the remaining balance", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ payment_due: 500 }));
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 501 } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("surfaces a 500 if the final transaction write fails", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockDatabases.updateDocument.mockRejectedValue(new Error("db down"));
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1000 } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
		});
	});
});
