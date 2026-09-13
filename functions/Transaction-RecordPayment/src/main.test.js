jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const { mockStripe, resetStripeMocks } = require("stripe");
const mockFetch = require("node-fetch");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const EVENTS_COLLECTION_ID = "68e400210008d19bb5c9";
const TRANSACTIONS_COLLECTION_ID = "68e4cd3500179ce661c6";

// The register stores a snapshot of the whole pos_items document per line plus
// a quantity (POS/src/utils/cartUtils.js), so a cart line carries `$id` and the
// price it was rung up at. Two beers at 500 = a 1000 transaction, which is what
// every fixture below is worth.
const DEFAULT_CART = [{ $id: "i1", name: "Beer", price: 500, quantity: 2 }];
const DEFAULT_POS_ITEMS = [{ $id: "i1", sale_price: 500 }];

const baseTransaction = (overrides = {}) => ({
	status: "pending",
	payment_due: 1000,
	testing: true,
	tip: 0,
	payments: null,
	cart: JSON.stringify(DEFAULT_CART),
	...overrides,
});

// listDocuments is one shared spy across every collection the handler reads
// (pos_items and discounts for server-side re-pricing, Events for the DJ
// voucher rule, Transactions for the PaymentIntent reuse guard), so tests
// dispatch on the collection id rather than blanket-mocking a single response.
const mockCollectionReads = ({
	posItems = DEFAULT_POS_ITEMS,
	discounts = [],
	events = [],
	transactions = [],
} = {}) => {
	mockDatabases.listDocuments.mockImplementation((databaseId, collectionId) => {
		if (collectionId === "pos_items") return Promise.resolve({ documents: posItems });
		if (collectionId === "discounts") return Promise.resolve({ documents: discounts });
		if (collectionId === EVENTS_COLLECTION_ID) return Promise.resolve({ documents: events });
		if (collectionId === TRANSACTIONS_COLLECTION_ID) return Promise.resolve({ documents: transactions });
		throw new Error(`unexpected listDocuments against ${collectionId}`);
	});
};

const listDocumentCallsFor = (collectionId) =>
	mockDatabases.listDocuments.mock.calls.filter((call) => call[1] === collectionId);

describe("Transaction-RecordPayment", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		resetStripeMocks();
		mockFetch.mockReset();
		mockCollectionReads();
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
				.mockResolvedValueOnce({ balance: 5000 }) // giftcard
				.mockResolvedValueOnce(baseTransaction()); // pre-commit re-read (P2-4)
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

		test("rejects a revoked card that no longer carries an events link", async () => {
			// P2-5. `giftcards.events` is onDelete:setNull, so deleting an Event
			// strips the link off its vouchers -- and with the revocation check
			// inside the voucher branch, that un-revoked every one of them. Live
			// today, no giftcard row has an events link at all.
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce({ balance: 2000, active: false });

			const result = await handler(voucherCtx());

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/deactivated/i);
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
			mockCollectionReads({ events: [] });

			const result = await handler(voucherCtx());

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/only valid during its own event/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("rejects a voucher leg when a different event is currently active", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce({ balance: 2000, events: "event1", active: true });
			mockCollectionReads({ events: [{ $id: "event2" }] });

			const result = await handler(voucherCtx());

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/only valid during its own event/i);
		});

		test("accepts a voucher leg when active, matching event, and no discount", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce({ balance: 2000, events: "event1", active: true })
				.mockResolvedValueOnce(baseTransaction()); // pre-commit re-read (P2-4)
			mockCollectionReads({ events: [{ $id: "event1" }] });
			mockDatabases.updateDocument.mockResolvedValue({});

			const result = await handler(voucherCtx());

			expect(result.body).toEqual({ ok: true, remaining: 600, status: "pending" });
			const giftcardCall = mockDatabases.updateDocument.mock.calls.find((c) => c[2] === "gc1");
			expect(giftcardCall[3]).toEqual({ balance: 1600 });
		});

		test("a standing giftcard (no events link) is unaffected by the discount rule", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction({ discount: 500 }))
				.mockResolvedValueOnce({ balance: 2000 }) // no `events`, no `active` -- a standard giftcard
				.mockResolvedValueOnce(baseTransaction({ discount: 500 })); // pre-commit re-read (P2-4)
			mockCollectionReads({ discounts: [{ type: "cents", amount: 500 }] });
			mockDatabases.updateDocument.mockResolvedValue({});

			const result = await handler(voucherCtx());

			expect(result.body).toEqual({ ok: true, remaining: 600, status: "pending" });
			// Same assertion as before -- no active-event lookup happens for a standing
			// giftcard -- now scoped to the Events collection, since the handler does
			// read pos_items/discounts on every leg to re-price the cart.
			expect(listDocumentCallsFor(EVENTS_COLLECTION_ID)).toHaveLength(0);
		});
	});

	describe("stripe legs", () => {
		test("records a verified card charge, including its tip", async () => {
			// The real Stripe shape for a reader tip: the reader rewrites the
			// intent (config_override.update_payment_intent), so `amount` is
			// cart total + tip and `amount_details.tip.amount` is the tip. The
			// leg claims the cart total only -- a tip is not payment toward the
			// cart -- so 1150 captured against a 1000 leg is the correct pairing.
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1150,
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
			expect(data.payment_due).toBe(0);
			expect(data.status).toBe("complete");
			expect(JSON.parse(data.payments)[0]).toEqual({ method: "stripe", amount: 1000, stripeId: "pi_1", tip: 150 });
		});

		test("a tip on top of a sale that already has one accumulates onto the transaction", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({
					payment_due: 400,
					tip: 100,
					payments: JSON.stringify([{ method: "cash", amount: 600 }]),
				}),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 475,
				amount_details: { tip: { amount: 75 } },
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 400, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete" });
			const [, , , data] = mockDatabases.updateDocument.mock.calls[0];
			expect(data.tip).toBe(175);
		});

		test("anti-forgery: an overpayment that is NOT a declared tip is still rejected", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1150,
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/does not match/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("anti-forgery: a leg claiming more than was captured is still rejected, tip or no tip", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 500,
				amount_details: { tip: { amount: 150 } },
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/does not match/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("anti-forgery: a nonsense tip can't be used to shrink the amount that has to match", async () => {
			// A tip bigger than the capture, or a negative one, is clamped into
			// [0, captured] before the comparison -- so it can never make a
			// smaller capture satisfy a larger leg.
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 10,
				amount_details: { tip: { amount: -990 } },
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
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
				mockCollectionReads({ transactions: [{ $id: "t-other", stripe_id: "pi_1" }] });
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
				mockCollectionReads({ transactions: [{ $id: "t1", stripe_id: "pi_1" }] });
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
			// Dues are a fixed 4000 -- the amount the server prices this channel at
			// itself, since the kiosk's "Membership Dues" cart line is synthetic.
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({
					channel: "membership",
					payment_due: 4000,
					total: 4000,
					member_name: "Jane Member",
					member_email: "jane@example.com",
				}),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 4000,
				metadata: { transactionId: "t1" },
			});
			mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 4000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete" });
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.resend.com/emails",
				expect.objectContaining({ method: "POST" }),
			);
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			// `to` is the finance recipient -- here the test address, which happens to be the
			// admin's (FINANCE_NOTIFICATION_EMAIL_TEST), not a standing CC.
			expect(sentBody.to).toEqual(["everett.bazzocchi@skullspace.ca"]);
			// the member is CC'd on their own dues receipt: a genuine recipient, so this survives
			expect(sentBody.cc).toEqual(["jane@example.com"]);
			expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
			expect(sentBody.html).toContain("Jane Member");
			expect(sentBody.html).toContain("jane@example.com");
			expect(sentBody.html).toContain("admin@skullspace.ca");
		});

		test("does not cc the member when no valid member_email is on the transaction", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ channel: "membership", payment_due: 4000, total: 4000 }),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 4000,
				metadata: { transactionId: "t1" },
			});
			mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 4000, paymentIntentId: "pi_1" },
			});

			await handler(ctx);

			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			// no member to cc, and no standing admin copy -- so no cc field goes out at all
			expect(sentBody.cc).toBeUndefined();
			expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
		});

		// Guards the deliberate change away from the standing everett CC. The member CC above is
		// a genuine recipient and must keep working; the admin copy must not come back. Uses the
		// non-testing path so the finance `to` is finance's own address, leaving cc unambiguous.
		test("never puts the admin address in cc on the dues notice", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({
					channel: "membership",
					testing: false,
					payment_due: 4000,
					total: 4000,
					member_name: "Jane Member",
					member_email: "jane@example.com",
				}),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 4000,
				metadata: { transactionId: "t1" },
			});
			mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 4000, paymentIntentId: "pi_1" },
			});

			await handler(ctx);

			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.cc || []).not.toContain("everett.bazzocchi@skullspace.ca");
			expect(sentBody.cc).toEqual(["jane@example.com"]);
			expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
		});

		test("a non-testing membership payment notifies finance's real address, not the test one", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ channel: "membership", testing: false, payment_due: 4000, total: 4000 }),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 4000,
				metadata: { transactionId: "t1" },
			});
			mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 4000, paymentIntentId: "pi_1" },
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
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ channel: "membership", payment_due: 4000, total: 4000 }),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 4000,
				metadata: { transactionId: "t1" },
			});
			mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("resend down") });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 4000, paymentIntentId: "pi_1" },
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
			// One beer at 500, 500 outstanding: 501 is more than anyone owes,
			// by the document's reckoning and the server's.
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({
					payment_due: 500,
					cart: JSON.stringify([{ $id: "i1", name: "Beer", price: 500, quantity: 1 }]),
				}),
			);
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

		// The giftcard debit is its own committed write and nothing downstream
		// can undo it: both Transaction-SetStatus and Admin-CancelStaleTransactions
		// reverse from `payments`, which a leg that never got written is not in.
		// So the money has to come back here, or a human has to be told (P0-13).
		describe("a giftcard debit that the leg write then loses", () => {
			const debitThenFailTheLegWrite = () => {
				mockDatabases.getDocument
					.mockResolvedValueOnce(baseTransaction()) // transaction
					.mockResolvedValueOnce({ balance: 5000 }) // giftcard, pre-debit
					.mockResolvedValueOnce(baseTransaction()); // pre-commit re-read (P2-4)
				mockDatabases.updateDocument
					.mockResolvedValueOnce({}) // the debit itself succeeds
					.mockRejectedValueOnce(new Error("db down")); // the leg write does not
			};

			test("is credited back, and the response says so", async () => {
				debitThenFailTheLegWrite();
				// re-read of the giftcard for the compensating credit
				mockDatabases.getDocument.mockResolvedValueOnce({ balance: 4600 });
				mockDatabases.updateDocument.mockResolvedValueOnce({});
				const ctx = makeContext({
					body: { transactionId: "t1", method: "giftcard", amount: 400, giftcardId: "gc1" },
				});

				const result = await handler(ctx);

				expect(result.statusCode).toBe(500);
				expect(result.body.giftcardRestored).toBe(true);
				const creditCall = mockDatabases.updateDocument.mock.calls[2];
				expect(creditCall[1]).toBe("giftcards");
				expect(creditCall[2]).toBe("gc1");
				expect(creditCall[3]).toEqual({ balance: 5000 });
			});

			test("is reported as an orphaned debit when even the credit-back fails", async () => {
				debitThenFailTheLegWrite();
				mockDatabases.getDocument.mockRejectedValueOnce(new Error("still down"));
				const ctx = makeContext({
					body: { transactionId: "t1", method: "giftcard", amount: 400, giftcardId: "gc1" },
				});

				const result = await handler(ctx);

				expect(result.statusCode).toBe(500);
				expect(result.body.giftcardRestored).toBe(false);
				expect(result.body.manualCredit).toEqual({ giftcardId: "gc1", amount: 400 });
				expect(ctx.error).toHaveBeenCalledWith(expect.stringMatching(/ORPHANED GIFTCARD DEBIT/));
			});
		});
	});

	// The transaction document -- cart, total, discount, payment_due -- is
	// written directly by the POS/kiosk client, so `amount <= payment_due` is a
	// client number checked against a client number. These cover the server
	// re-pricing that makes the cart itself the authority.
	describe("server-side re-pricing", () => {
		test("a forged payment_due can't buy a complete sale: the cart's real price still stands", async () => {
			// A $100 cart written with payment_due: 1, paid for a cent.
			const realCart = [{ $id: "i1", name: "Beer", price: 500, quantity: 20 }];
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ payment_due: 1, total: 1, cart: JSON.stringify(realCart) }),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1 } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 9999, status: "pending" });
			const [, , , data] = mockDatabases.updateDocument.mock.calls[0];
			expect(data.status).toBe("pending");
			expect(data.payment_due).toBe(9999);
		});

		test("a forged payment_due can't buy a complete CARD sale either", async () => {
			const realCart = [{ $id: "i1", name: "Beer", price: 500, quantity: 20 }];
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ payment_due: 1, total: 1, cart: JSON.stringify(realCart) }),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1,
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.body.status).toBe("pending");
			expect(result.body.remaining).toBe(9999);
		});

		test("prices off pos_items.sale_price, not the price the cart snapshot claims", async () => {
			// The snapshot says the beers were 1 cent each; pos_items says 500.
			const lyingCart = [{ $id: "i1", name: "Beer", price: 1, quantity: 2 }];
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ payment_due: 2, total: 2, cart: JSON.stringify(lyingCart) }),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 2 } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 998, status: "pending" });
		});

		test("a made-up discount doesn't reduce what the sale costs server-side", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ payment_due: 100, total: 100, discount: 900 }),
			);
			mockCollectionReads({ discounts: [{ type: "percent", amount: 10 }] });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 100 } });

			const result = await handler(ctx);

			// 1000 cart, the claimed 900 discount matches no configured
			// discount, so full price is still owed: 900 left after the 100.
			expect(result.body.ok).toBe(true);
			expect(result.body.remaining).toBe(900);
			expect(result.body.status).toBe("pending");
			// ...and the till is told why it is still 900 rather than 0, instead
			// of that only reaching an execution log nobody reads.
			expect(result.body.warning).toMatch(/discount 900 matches no configured discount/);
		});

		test("a real discount is honoured and the sale completes for the discounted price", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ payment_due: 900, total: 900, discount: 100 }),
			);
			mockCollectionReads({ discounts: [{ type: "percent", amount: 10 }] });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 900 } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete" });
		});

		test("the server price is a floor, not a cap: a price drop can't make a captured leg bounce", async () => {
			// Rung up at 1000, then someone edits sale_price down to 400/ea.
			// The customer still owes (and the reader still captured) 1000.
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockCollectionReads({ posItems: [{ $id: "i1", sale_price: 400 }] });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1000 } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete" });
		});

		test("a cart naming an item that doesn't exist is refused on a leg that hasn't captured yet", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ cart: JSON.stringify([{ $id: "ghost", price: 500, quantity: 2 }]) }),
			);
			mockCollectionReads({ posItems: [] });
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1000 } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/priced server-side/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("the same cart refuses a giftcard leg BEFORE the card is debited", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction({ cart: JSON.stringify([{ $id: "ghost", price: 500, quantity: 2 }]) }))
				.mockResolvedValueOnce({ balance: 5000 });
			mockCollectionReads({ posItems: [] });
			const ctx = makeContext({
				body: { transactionId: "t1", method: "giftcard", amount: 1000, giftcardId: "gc1" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			// The debit is a separate committed write with no transaction around
			// it, so "refuse" only stays safe while it happens first.
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test.each([null, "", "not json", JSON.stringify({ i1: 2 })])(
			"a transaction with no readable cart (%p) is refused rather than priced at zero",
			async (cart) => {
				mockDatabases.getDocument.mockResolvedValue(baseTransaction({ cart }));
				const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1000 } });

				const result = await handler(ctx);

				expect(result.statusCode).toBe(400);
				expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
			},
		);

		test("an unreadable pos_items collection fails closed with a 500, never at zero", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction());
			mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1000 } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("membership dues are priced by the server's own dues amount, not the document", async () => {
			// No pos_items cart exists for dues -- the kiosk rings a synthetic
			// line -- so a membership row claiming it owes 1 cent still can't
			// complete until the real 4000 is covered.
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ channel: "membership", payment_due: 1, total: 1, cart: JSON.stringify([]) }),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1,
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 3999, status: "pending" });
			expect(mockFetch).not.toHaveBeenCalled();
		});

		// The re-price runs AFTER the reader has captured. Every test below is the
		// same property from a different angle: re-pricing may refuse a leg only
		// while refusing costs nothing. Once the money is gone the leg is
		// recorded and the problem is flagged -- the alternative is P0-1 all over
		// again (captured, then refused, sale unrecordable).
		describe("never turns a captured payment into an unrecordable one", () => {
			const succeededIntent = (amount) => ({
				id: "pi_1",
				status: "succeeded",
				amount,
				metadata: { transactionId: "t1" },
			});

			test("an item deleted between ring-up and the tap is recorded, priced at what the cart was rung up at, and flagged", async () => {
				mockDatabases.getDocument.mockResolvedValue(
					baseTransaction({ cart: JSON.stringify([{ $id: "ghost", price: 500, quantity: 2 }]) }),
				);
				mockCollectionReads({ posItems: [] });
				mockDatabases.updateDocument.mockResolvedValue({});
				mockStripe.paymentIntents.retrieve.mockResolvedValue(succeededIntent(1000));
				const ctx = makeContext({
					body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
				});

				const result = await handler(ctx);

				expect(result.statusCode).toBe(200);
				expect(result.body.ok).toBe(true);
				expect(result.body.status).toBe("complete");
				expect(result.body.warning).toMatch(/ghost/);
				const [, , , data] = mockDatabases.updateDocument.mock.calls[0];
				// The flag is persisted on the leg, not just logged, so the sale
				// carries it everywhere `payments` is read.
				expect(JSON.parse(data.payments)[0].priceWarning).toMatch(/ghost/);
				expect(ctx.error).toHaveBeenCalledWith(expect.stringMatching(/not trustworthy/));
			});

			test("a cart that cannot be read at all still records the captured leg against the stored balance", async () => {
				mockDatabases.getDocument.mockResolvedValue(baseTransaction({ cart: "not json" }));
				mockDatabases.updateDocument.mockResolvedValue({});
				mockStripe.paymentIntents.retrieve.mockResolvedValue(succeededIntent(1000));
				const ctx = makeContext({
					body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
				});

				const result = await handler(ctx);

				expect(result.statusCode).toBe(200);
				expect(result.body.status).toBe("complete");
				expect(result.body.warning).toMatch(/cart is missing or unreadable/);
				expect(JSON.parse(mockDatabases.updateDocument.mock.calls[0][3].payments)).toHaveLength(1);
			});

			test("a pos_items outage does not throw away a captured card payment", async () => {
				mockDatabases.getDocument.mockResolvedValue(baseTransaction());
				mockDatabases.listDocuments.mockImplementation((databaseId, collectionId) => {
					if (collectionId === "pos_items") return Promise.reject(new Error("db down"));
					return Promise.resolve({ documents: [] });
				});
				mockDatabases.updateDocument.mockResolvedValue({});
				mockStripe.paymentIntents.retrieve.mockResolvedValue(succeededIntent(1000));
				const ctx = makeContext({
					body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
				});

				const result = await handler(ctx);

				expect(result.statusCode).toBe(200);
				expect(result.body.warning).toMatch(/catalogue could not be read/);
				expect(mockDatabases.updateDocument).toHaveBeenCalled();
			});

			test("a discount edited mid-sale leaves a flagged balance, never a refused capture", async () => {
				mockDatabases.getDocument.mockResolvedValue(
					baseTransaction({ payment_due: 900, total: 900, discount: 100 }),
				);
				// The row that produced the 100 is now a 15% row: the claimed
				// discount matches nothing, so the server wants the full 1000.
				mockCollectionReads({ discounts: [{ type: "percent", amount: 15 }] });
				mockDatabases.updateDocument.mockResolvedValue({});
				mockStripe.paymentIntents.retrieve.mockResolvedValue(succeededIntent(900));
				const ctx = makeContext({
					body: { transactionId: "t1", method: "stripe", amount: 900, paymentIntentId: "pi_1" },
				});

				const result = await handler(ctx);

				expect(result.statusCode).toBe(200);
				expect(result.body.remaining).toBe(100);
				expect(result.body.warning).toMatch(/discount 100 matches no configured discount/);
				expect(JSON.parse(mockDatabases.updateDocument.mock.calls[0][3].payments)).toEqual([
					{ method: "stripe", amount: 900, stripeId: "pi_1", tip: 0, priceWarning: expect.any(String) },
				]);
			});

			test("the snapshot fallback still can't be used to pay less than the sale already says it is owed", async () => {
				// Forged cart line: a ghost id with a 1-cent snapshot price, on a
				// transaction whose own payment_due is the honest 1000.
				mockDatabases.getDocument.mockResolvedValue(
					baseTransaction({ cart: JSON.stringify([{ $id: "ghost", price: 1, quantity: 2 }]) }),
				);
				mockCollectionReads({ posItems: [] });
				mockDatabases.updateDocument.mockResolvedValue({});
				mockStripe.paymentIntents.retrieve.mockResolvedValue(succeededIntent(2));
				const ctx = makeContext({
					body: { transactionId: "t1", method: "stripe", amount: 2, paymentIntentId: "pi_1" },
				});

				const result = await handler(ctx);

				expect(result.body.status).toBe("pending");
				expect(result.body.remaining).toBe(998);
			});
		});

		test("existing legs count toward the server price, so a split sale still completes", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({ payment_due: 400, payments: JSON.stringify([{ method: "cash", amount: 600 }]) }),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 400 } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete" });
		});
	});

	// POS/src/utils/splitPayment.js generates a `legId` per leg and re-sends it
	// unchanged on every retry of that leg, on the documented expectation that
	// this function recognises the replay instead of applying the leg twice.
	describe("leg replay protection", () => {
		test("a replayed leg returns the existing state instead of applying twice", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({
					payment_due: 700,
					payments: JSON.stringify([{ method: "cash", amount: 300, legId: "leg-a" }]),
				}),
			);
			const ctx = makeContext({
				body: { transactionId: "t1", method: "cash", amount: 300, legId: "leg-a" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body).toEqual({ ok: true, remaining: 700, status: "pending", replay: true });
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("a replay of the leg that completed the sale is still idempotent, not 'not pending'", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({
					status: "complete",
					payment_due: 0,
					payments: JSON.stringify([{ method: "cash", amount: 1000, legId: "leg-a" }]),
				}),
			);
			const ctx = makeContext({
				body: { transactionId: "t1", method: "cash", amount: 1000, legId: "leg-a" },
			});

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete", replay: true });
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("a replayed giftcard leg does not debit the card a second time", async () => {
			mockDatabases.getDocument.mockResolvedValueOnce(
				baseTransaction({
					payment_due: 600,
					payments: JSON.stringify([{ method: "giftcard", amount: 400, giftcardId: "gc1", legId: "leg-a" }]),
				}),
			);
			const ctx = makeContext({
				body: { transactionId: "t1", method: "giftcard", amount: 400, giftcardId: "gc1", legId: "leg-a" },
			});

			const result = await handler(ctx);

			expect(result.body.replay).toBe(true);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("a genuinely new leg with a different legId still applies", async () => {
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({
					payment_due: 700,
					payments: JSON.stringify([{ method: "cash", amount: 300, legId: "leg-a" }]),
				}),
			);
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "cash", amount: 700, legId: "leg-b" },
			});

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete" });
			const [, , , data] = mockDatabases.updateDocument.mock.calls[0];
			expect(JSON.parse(data.payments)).toEqual([
				{ method: "cash", amount: 300, legId: "leg-a" },
				{ method: "cash", amount: 700, legId: "leg-b" },
			]);
		});

		test("the same PaymentIntent can't be applied twice to a still-pending transaction", async () => {
			// The replay path above needs a legId; this is the same double-apply
			// attempted without one, which used to sail through every check
			// because the cross-transaction reuse guard only looks at OTHER rows.
			mockDatabases.getDocument.mockResolvedValue(
				baseTransaction({
					payment_due: 600,
					payments: JSON.stringify([{ method: "stripe", amount: 400, stripeId: "pi_1", tip: 0 }]),
				}),
			);
			mockCollectionReads({ transactions: [{ $id: "t1", stripe_id: "pi_1" }] });
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 400,
				metadata: { transactionId: "t1" },
			});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 400, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/already been recorded on this transaction/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});
	});

	describe("giftcard bookkeeping", () => {
		test("a giftcard leg records giftcard_amount on the transaction, not just in payments", async () => {
			// Left unwritten, this column is what makes gift-card redemptions
			// get reported (and refunded) as cash by the legacy leg derivation.
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce({ balance: 5000 })
				.mockResolvedValueOnce(baseTransaction()); // pre-commit re-read (P2-4)
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "giftcard", amount: 400, giftcardId: "gc1" },
			});

			await handler(ctx);

			const transactionCall = mockDatabases.updateDocument.mock.calls.find((c) => c[2] === "t1");
			expect(transactionCall[3].giftcard_amount).toBe(400);
		});

		test("a second giftcard leg adds to the recorded giftcard_amount", async () => {
			const partlyPaid = () =>
				baseTransaction({
					payment_due: 600,
					giftcard_amount: 400,
					payments: JSON.stringify([{ method: "giftcard", amount: 400, giftcardId: "gc1" }]),
				});
			mockDatabases.getDocument
				.mockResolvedValueOnce(partlyPaid())
				.mockResolvedValueOnce({ balance: 5000 })
				.mockResolvedValueOnce(partlyPaid()); // pre-commit re-read (P2-4)
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "giftcard", amount: 600, giftcardId: "gc2" },
			});

			await handler(ctx);

			const transactionCall = mockDatabases.updateDocument.mock.calls.find((c) => c[2] === "t1");
			expect(transactionCall[3].giftcard_amount).toBe(1000);
		});

		test("a cash leg leaves giftcard_amount alone", async () => {
			mockDatabases.getDocument.mockResolvedValue(baseTransaction({ giftcard_amount: 250 }));
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1000 } });

			await handler(ctx);

			const [, , , data] = mockDatabases.updateDocument.mock.calls[0];
			expect(data).not.toHaveProperty("giftcard_amount");
		});
	});

	// P2-4. The transaction is read once at the top of the handler, and up to
	// three network round-trips happen before the write (the Stripe retrieve, the
	// reuse query, the giftcard debit). The write is a read-modify-write of the
	// `payments` blob plus a `status`, so anything that touched the row in that
	// window used to be silently erased. These cover the pre-commit re-read:
	// the first getDocument is the opening snapshot, the LAST one is the state
	// the row is actually in by the time the leg is committed.
	describe("a row that changed while the leg was in flight", () => {
		const transactionWrite = () => mockDatabases.updateDocument.mock.calls.find((c) => c[2] === "t1");

		test("a leg recorded concurrently does not lose the other execution's leg", async () => {
			// The lost update itself: this execution opened on an unpaid sale, a
			// concurrent one recorded 300 of it, and the 700 leg committed here has
			// to land on top of that 300 -- not replace it.
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce(
					baseTransaction({
						payment_due: 700,
						payments: JSON.stringify([{ method: "cash", amount: 300, legId: "leg-other" }]),
					}),
				);
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 700, legId: "leg-mine" } });

			const result = await handler(ctx);

			expect(JSON.parse(transactionWrite()[3].payments)).toEqual([
				{ method: "cash", amount: 300, legId: "leg-other" },
				{ method: "cash", amount: 700, legId: "leg-mine" },
			]);
			expect(transactionWrite()[3].payment_due).toBe(0);
			expect(transactionWrite()[3].status).toBe("complete");
			expect(transactionWrite()[3].payment_method).toBe("split");
			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete" });
		});

		test("this same leg, recorded concurrently, is not appended a second time", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce(
					baseTransaction({
						status: "complete",
						payment_due: 0,
						payments: JSON.stringify([{ method: "cash", amount: 1000, legId: "leg-mine" }]),
					}),
				);
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1000, legId: "leg-mine" } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete", replay: true });
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("a giftcard leg that lost that race has its debit credited back", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce({ balance: 5000 }) // giftcard, pre-debit
				.mockResolvedValueOnce(
					baseTransaction({
						payment_due: 600,
						payments: JSON.stringify([{ method: "giftcard", amount: 400, giftcardId: "gc1", legId: "leg-mine" }]),
					}),
				)
				.mockResolvedValueOnce({ balance: 4600 }); // giftcard, for the credit-back
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "giftcard", amount: 400, giftcardId: "gc1", legId: "leg-mine" },
			});

			const result = await handler(ctx);

			expect(result.body.replay).toBe(true);
			expect(transactionWrite()).toBeUndefined();
			const giftcardWrites = mockDatabases.updateDocument.mock.calls.filter((c) => c[2] === "gc1");
			expect(giftcardWrites.map((c) => c[3])).toEqual([{ balance: 4600 }, { balance: 5000 }]);
		});

		test("a cash leg is refused, not applied, when the sale was cancelled mid-payment", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce(baseTransaction({ status: "cancelled" }));
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1000 } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(409);
			expect(result.body.error).toMatch(/no longer pending \(status: cancelled\)/i);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("a giftcard leg refused for the same reason gets its debit back", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce({ balance: 5000 })
				.mockResolvedValueOnce(baseTransaction({ status: "cancelled" }))
				.mockResolvedValueOnce({ balance: 4600 });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "giftcard", amount: 400, giftcardId: "gc1" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(409);
			expect(result.body.giftcardRestored).toBe(true);
			expect(transactionWrite()).toBeUndefined();
			const giftcardWrites = mockDatabases.updateDocument.mock.calls.filter((c) => c[2] === "gc1");
			expect(giftcardWrites.map((c) => c[3])).toEqual([{ balance: 4600 }, { balance: 5000 }]);
		});

		test("a captured card leg is still recorded on a refunded sale, without resurrecting its status", async () => {
			// The one leg that must never be refused here: Stripe has the money
			// already. Record it so the row someone has to refund shows it, but
			// leave `status`/`payment_due` exactly as the refund left them.
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockResolvedValueOnce(baseTransaction({ status: "refunded", payment_due: 0 }));
			mockStripe.paymentIntents.retrieve.mockResolvedValue({
				id: "pi_1",
				status: "succeeded",
				amount: 1000,
				metadata: { transactionId: "t1" },
			});
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({
				body: { transactionId: "t1", method: "stripe", amount: 1000, paymentIntentId: "pi_1" },
			});

			const result = await handler(ctx);

			const written = transactionWrite()[3];
			expect(written).not.toHaveProperty("status");
			expect(written).not.toHaveProperty("payment_due");
			expect(JSON.parse(written.payments)).toEqual([
				{ method: "stripe", amount: 1000, stripeId: "pi_1", tip: 0, statusAtRecord: "refunded" },
			]);
			expect(result.body.status).toBe("refunded");
			expect(result.body.warning).toMatch(/needs a refund/i);
		});

		test("a re-read that fails still records the leg, from the snapshot already in hand", async () => {
			// Refusing here would be the P0-1 failure all over again: this handler
			// runs after the reader has captured.
			mockDatabases.getDocument
				.mockResolvedValueOnce(baseTransaction())
				.mockRejectedValueOnce(new Error("db blip"));
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = makeContext({ body: { transactionId: "t1", method: "cash", amount: 1000 } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true, remaining: 0, status: "complete" });
			expect(JSON.parse(transactionWrite()[3].payments)).toEqual([{ method: "cash", amount: 1000 }]);
			expect(ctx.error).toHaveBeenCalledWith(expect.stringMatching(/pre-commit re-read did not answer/i));
		});
	});
});
