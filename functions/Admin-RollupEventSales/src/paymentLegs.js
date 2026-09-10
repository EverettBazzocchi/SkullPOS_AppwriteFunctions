// Kept in sync by hand with the identical copy in Sales-Report/src/paymentLegs.js (also
// duplicated in Transaction-RecordPayment, Stripe-RefundPayment, Transaction-EmailReceipt) --
// every function that needs to know how a transaction was actually paid carries its own copy
// since Appwrite functions deploy independently.
//
// Returns the list of payment legs for a transaction: {method, amount,
// giftcardId?, stripeId?}[]. New transactions (written by
// Transaction-RecordPayment) carry this directly in `payments`. Older
// transactions predate that and have only the single-method legacy
// fields -- synthesize one leg from those instead, so nothing needs a
// data migration.
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

	const giftcardIds = Array.isArray(transaction.giftcards) ? transaction.giftcards : [];
	const giftcardAmount = parseInt(transaction.giftcard_amount) || 0;
	if (giftcardIds.length > 0 && giftcardAmount > 0) {
		const giftcardId = typeof giftcardIds[0] === 'object' ? giftcardIds[0].$id : giftcardIds[0];
		legs.push({ method: 'giftcard', amount: giftcardAmount, giftcardId });
	}

	if (transaction.stripe_id) {
		legs.push({ method: 'stripe', amount: parseInt(transaction.payment_due) || 0, stripeId: transaction.stripe_id });
	}

	if (legs.length === 0) {
		legs.push({ method: 'cash', amount: parseInt(transaction.payment_due) || 0 });
	}

	return legs;
}
