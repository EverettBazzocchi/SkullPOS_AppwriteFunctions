// Kept in sync by hand with the identical copy in Stripe-RefundPayment/src/paymentLegs.js (also
// duplicated in Admin-RollupEventSales, Sales-Report) -- every
// function that needs to know how a transaction was actually paid carries its own copy since
// Appwrite functions deploy independently.
//
// Returns the list of payment legs for a transaction: {method, amount,
// giftcardId?, stripeId?}[]. New transactions (written by
// Transaction-RecordPayment) carry this directly in `payments`. Older
// transactions predate that and have only the single-method legacy
// fields -- synthesize legs from those instead, so nothing needs a data
// migration.
//
// `transaction.total` is confirmed (by inspecting real pre-migration rows) to already be net of
// `discount` and exclusive of `tip` -- both are tracked/displayed as their own separate receipt
// line items here -- so neither needs subtracting here.
//
// The card/stripe leg used to be derived from `payment_due`, which is 0 on every transaction the
// (now-retired) legacy completion path finished, silently showing "$0.00" for the card leg on an
// old receipt for a real charge. Real legacy rows show `payment_due` reliably held "whatever
// wasn't covered by the giftcard leg" right up until completion, so it's still the most accurate
// source for the card amount *when it's actually populated* -- this only falls back to deriving
// the amount from `total` when `payment_due` looks stale/zeroed (the actual bug), rather than
// discarding it outright. This also naturally supports the legacy system's rare "giftcard + card
// + cash" 3-way split (where the card only covered part of what was left after the giftcard, and
// the remaining balance was cash): whatever isn't accounted for by the giftcard and (if present)
// stripe leg found is synthesized as a cash leg -- not just when NO other leg was found at all,
// which previously dropped that remainder silently.
export function derivePaymentLegs(transaction) {
	if (transaction.payments) {
		try {
			const parsed = JSON.parse(transaction.payments);
			if (Array.isArray(parsed) && parsed.length > 0) return parsed;
		} catch (err) {
			// fall through to legacy derivation
		}
	}

	const legs = [];
	let remaining = parseInt(transaction.total) || 0;

	const giftcardIds = Array.isArray(transaction.giftcards) ? transaction.giftcards : [];
	const giftcardAmount = parseInt(transaction.giftcard_amount) || 0;
	if (giftcardIds.length > 0 && giftcardAmount > 0) {
		const giftcardId = typeof giftcardIds[0] === 'object' ? giftcardIds[0].$id : giftcardIds[0];
		legs.push({ method: 'giftcard', amount: giftcardAmount, giftcardId });
		remaining -= giftcardAmount;
	}

	if (transaction.stripe_id) {
		const recordedDue = parseInt(transaction.payment_due) || 0;
		const stripeAmount = recordedDue > 0 ? Math.min(recordedDue, Math.max(remaining, 0)) : Math.max(remaining, 0);
		legs.push({ method: 'stripe', amount: stripeAmount, stripeId: transaction.stripe_id });
		remaining -= stripeAmount;
	}

	if (remaining > 0) {
		legs.push({ method: 'cash', amount: remaining });
	}

	return legs;
}
