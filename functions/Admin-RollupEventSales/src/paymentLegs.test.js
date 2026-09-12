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
			total: 1000,
			payment_due: 600,
		};

		expect(derivePaymentLegs(transaction)).toEqual([
			{ method: "giftcard", amount: 400, giftcardId: "gc1" },
			{ method: "stripe", amount: 600, stripeId: "pi_1" },
		]);
	});

	test("legacy fallback: card revenue is no longer understated when payment_due was zeroed out on completion", () => {
		// This is the actual bug: a completed legacy transaction whose (now-retired) completion
		// path left payment_due at 0 despite a real card charge on file -- the card amount must
		// be derived from `total` instead of trusting the stale payment_due.
		const transaction = { stripe_id: "pi_1", total: 1200, payment_due: 0 };

		expect(derivePaymentLegs(transaction)).toEqual([{ method: "stripe", amount: 1200, stripeId: "pi_1" }]);
	});

	test("legacy fallback: card revenue is correctly reduced by an already-applied giftcard leg", () => {
		const transaction = {
			giftcards: ["gc1"],
			giftcard_amount: 300,
			stripe_id: "pi_1",
			total: 1000,
			payment_due: 0, // stale/zeroed, same as above -- must still net out correctly
		};

		expect(derivePaymentLegs(transaction)).toEqual([
			{ method: "giftcard", amount: 300, giftcardId: "gc1" },
			{ method: "stripe", amount: 700, stripeId: "pi_1" },
		]);
	});

	test("legacy fallback: a genuine giftcard + card + cash 3-way split reconstructs all three legs", () => {
		// payment_due here reflects only the CARD portion of what was left after the giftcard --
		// the gap between that and the true remainder is the cash portion, previously dropped
		// entirely since a cash leg was only ever synthesized when NO other leg had been found.
		const transaction = {
			giftcards: ["gc1"],
			giftcard_amount: 300,
			stripe_id: "pi_1",
			total: 1000,
			payment_due: 400,
		};

		expect(derivePaymentLegs(transaction)).toEqual([
			{ method: "giftcard", amount: 300, giftcardId: "gc1" },
			{ method: "stripe", amount: 400, stripeId: "pi_1" },
			{ method: "cash", amount: 300 },
		]);
	});

	test("legacy fallback: a partial giftcard with the rest in cash (no card at all) no longer drops the cash leg", () => {
		const transaction = { giftcards: ["gc1"], giftcard_amount: 300, total: 1000, payment_due: 0 };

		expect(derivePaymentLegs(transaction)).toEqual([
			{ method: "giftcard", amount: 300, giftcardId: "gc1" },
			{ method: "cash", amount: 700 },
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

	test("legacy fallback: card-only transaction (no giftcard) reports the correct non-zero amount", () => {
		const transaction = { stripe_id: "pi_1", total: 1200, payment_due: 1200 };

		expect(derivePaymentLegs(transaction)).toEqual([{ method: "stripe", amount: 1200, stripeId: "pi_1" }]);
	});

	test("legacy fallback: cash-only transaction (no giftcard, no stripe_id)", () => {
		const transaction = { total: 500, payment_due: 500 };

		expect(derivePaymentLegs(transaction)).toEqual([{ method: "cash", amount: 500 }]);
	});

	test("malformed payments JSON falls back to legacy derivation instead of throwing", () => {
		const transaction = { payments: "{not valid json", total: 500, payment_due: 500 };

		expect(derivePaymentLegs(transaction)).toEqual([{ method: "cash", amount: 500 }]);
	});

	test("an empty payments array also falls back to legacy derivation", () => {
		const transaction = { payments: "[]", total: 500, payment_due: 500 };

		expect(derivePaymentLegs(transaction)).toEqual([{ method: "cash", amount: 500 }]);
	});
});
