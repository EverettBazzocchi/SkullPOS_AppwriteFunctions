const { derivePaymentLegs } = require("./paymentLegs.js");

describe("derivePaymentLegs", () => {
	test("uses the payments array directly when present", () => {
		const legs = [
			{ method: "giftcard", amount: 400, giftcardId: "gc1" },
			{ method: "cash", amount: 600 },
		];
		const transaction = { payments: JSON.stringify(legs) };

		expect(derivePaymentLegs(transaction)).toEqual(legs);
	});

	test("legacy fallback: giftcard + stripe transaction with no payments array", () => {
		const transaction = {
			payments: null,
			giftcards: ["gc1"],
			giftcard_amount: 400,
			stripe_id: "pi_1",
			payment_due: 600,
		};

		expect(derivePaymentLegs(transaction)).toEqual([
			{ method: "giftcard", amount: 400, giftcardId: "gc1" },
			{ method: "stripe", amount: 600, stripeId: "pi_1" },
		]);
	});

	test("legacy fallback: giftcard relationship stored as an expanded object, not a bare id", () => {
		const transaction = {
			giftcards: [{ $id: "gc1", balance: 999 }],
			giftcard_amount: 400,
			payment_due: 0,
		};

		expect(derivePaymentLegs(transaction)).toEqual([{ method: "giftcard", amount: 400, giftcardId: "gc1" }]);
	});

	test("legacy fallback: giftcard-only transaction (no stripe_id)", () => {
		const transaction = { giftcards: ["gc1"], giftcard_amount: 1000, payment_due: 0 };

		expect(derivePaymentLegs(transaction)).toEqual([{ method: "giftcard", amount: 1000, giftcardId: "gc1" }]);
	});

	test("legacy fallback: card-only transaction (no giftcard)", () => {
		const transaction = { stripe_id: "pi_1", payment_due: 1200 };

		expect(derivePaymentLegs(transaction)).toEqual([{ method: "stripe", amount: 1200, stripeId: "pi_1" }]);
	});

	test("legacy fallback: cash-only transaction (no giftcard, no stripe_id)", () => {
		const transaction = { payment_due: 500 };

		expect(derivePaymentLegs(transaction)).toEqual([{ method: "cash", amount: 500 }]);
	});

	test("malformed payments JSON falls back to legacy derivation instead of throwing", () => {
		const transaction = { payments: "{not valid json", payment_due: 500 };

		expect(derivePaymentLegs(transaction)).toEqual([{ method: "cash", amount: 500 }]);
	});

	test("an empty payments array also falls back to legacy derivation", () => {
		const transaction = { payments: "[]", payment_due: 500 };

		expect(derivePaymentLegs(transaction)).toEqual([{ method: "cash", amount: 500 }]);
	});
});
