import { Databases } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Sets a pending transaction's status to "cancelled" -- staff cancelling
// an in-progress card attempt. "complete" is no longer reached here: a
// sale (cash, card, giftcard, or any split of those) is completed by
// Transaction-RecordPayment once its payment_due reaches 0. Never accepts
// "refunded" -- that's exclusively Stripe-RefundPayment's job -- and only
// transitions out of "pending", so this can't be replayed against an
// already-finalized transaction. The client has no write access to
// Transactions at all (see the POS PIN-system security plan), which is
// what makes "no refunds in quick-access PIN mode" a real restriction
// rather than a client-side flag: a cash-paid transaction can't be marked
// refunded except through Stripe-RefundPayment, whose execute permission
// is staff-team-only.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const GIFTCARDS_COLLECTION_ID = 'giftcards';
const ALLOWED_STATUSES = ['cancelled'];

// A split-tender sale can have one or more legs already recorded (by
// Transaction-RecordPayment) against a transaction that's STILL "pending"
// (e.g. giftcard covered part of the total, the card portion never
// finished) -- cancelling it outright would silently strand whatever those
// legs already moved. Only the modern `payments` JSON array can hold a leg
// on a still-pending transaction: transactions from before the split-
// payment migration never supported partial/split tender, so there's
// nothing legacy to derive here (contrast Stripe-RefundPayment's
// derivePaymentLegs, which also synthesizes a leg from legacy single-method
// fields -- only relevant for already-*complete* transactions).
function getRecordedLegs(transaction) {
	if (!transaction.payments) return [];
	try {
		const parsed = JSON.parse(transaction.payments);
		return Array.isArray(parsed) ? parsed : [];
	} catch (err) {
		return [];
	}
}

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const transactionId = body.transactionId;
	const status = body.status;
	if (!transactionId || !ALLOWED_STATUSES.includes(status)) {
		return res.json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` }, 400);
	}

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	let transaction;
	try {
		transaction = await databases.getDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transactionId);
	} catch (err) {
		error('Failed to read transaction: ' + err.message);
		return res.json({ error: 'Transaction not found' }, 404);
	}

	if (transaction.status !== 'pending') {
		return res.json({ error: `Transaction is not pending (status: ${transaction.status})` }, 400);
	}

	const legs = getRecordedLegs(transaction);

	// A stripe leg means real money was already captured by Stripe -- reversing that is a real
	// refund, not just a ledger fix, and belongs exclusively to Stripe-RefundPayment (staff-team
	// gated) rather than being silently triggered as a side effect of a status change here. Cash
	// legs need no code-level reversal: same as Stripe-RefundPayment's own cash handling, staff
	// hand the cash back physically -- there's no digital balance to restore.
	const stripeLegs = legs.filter((leg) => leg.method === 'stripe');
	if (stripeLegs.length > 0) {
		error(
			`Refusing to cancel ${transactionId}: it already has a captured card payment leg (${stripeLegs
				.map((leg) => leg.stripeId)
				.join(', ')}) that needs a real Stripe refund, not just a status change.`,
		);
		return res.json(
			{ error: 'This transaction already has a captured card payment on it -- refund it first (Stripe-RefundPayment) instead of cancelling.' },
			409,
		);
	}

	// Flip status FIRST, before reversing any giftcard leg below -- this is the idempotency
	// guard (mirrors Stripe-RefundPayment). If a reversal fails and this gets retried, the
	// status !== 'pending' check above stops it from re-running an already-succeeded reversal
	// (crediting a giftcard twice).
	try {
		await databases.updateDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transactionId, { status });
	} catch (err) {
		error('Failed to update transaction status: ' + err.message);
		return res.json({ error: 'Failed to update transaction status' }, 500);
	}

	const giftcardLegs = legs.filter((leg) => leg.method === 'giftcard' && leg.giftcardId);
	const reversedGiftcards = [];
	for (const leg of giftcardLegs) {
		try {
			const giftcard = await databases.getDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, leg.giftcardId);
			const newBalance = (parseInt(giftcard.balance) || 0) + (parseInt(leg.amount) || 0);
			await databases.updateDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, leg.giftcardId, { balance: newBalance });
			log(`Giftcard ${leg.giftcardId} credited back ${leg.amount} (transaction ${transactionId} cancelled)`);
			reversedGiftcards.push({ giftcardId: leg.giftcardId, amount: leg.amount });
		} catch (err) {
			error(`Transaction ${transactionId} was cancelled, but failed to reverse its giftcard leg ${leg.giftcardId}: ` + err.message);
			return res.json(
				{
					error: `Transaction cancelled, but failed to restore giftcard ${leg.giftcardId}'s balance -- please handle manually: ${err.message}`,
				},
				500,
			);
		}
	}

	log(`Transaction ${transactionId} set to ${status}`);
	return res.json({ ok: true, status, ...(giftcardLegs.length > 0 ? { reversedGiftcards } : {}) });
};
