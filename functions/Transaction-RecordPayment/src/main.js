import Stripe from 'stripe';
import { Databases } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Records one payment leg (cash amount, verified card charge, or giftcard
// redemption) against a pending transaction, appending it to the
// transaction's `payments` array -- this is what makes a split sale
// (multiple cards, cash+card, giftcard+cash, giftcard+card, etc.)
// possible: call this once per leg until payment_due reaches 0. Replaces
// the old single-method Transaction-ApplyGiftcard / Transaction-
// RecordCardPayment functions, and the cash-completion half of
// Transaction-SetStatus (which now only handles "cancelled").
//
// Every leg is validated the same way the single-method functions already
// did -- a card leg is independently verified against the real Stripe API
// (status + amount), a giftcard leg re-reads the actual current balance --
// never trusting client-supplied amounts for anything but the split itself.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const GIFTCARDS_COLLECTION_ID = 'giftcards';
const ALLOWED_METHODS = ['cash', 'stripe', 'giftcard'];

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const transactionId = body.transactionId;
	const method = body.method;
	const amount = parseInt(body.amount);

	if (!transactionId || !ALLOWED_METHODS.includes(method)) {
		return res.json({ error: `method must be one of: ${ALLOWED_METHODS.join(', ')}` }, 400);
	}
	if (!Number.isFinite(amount) || amount <= 0) {
		return res.json({ error: 'amount must be a positive integer (cents)' }, 400);
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

	const paymentDue = parseInt(transaction.payment_due) || 0;
	if (amount > paymentDue) {
		return res.json({ error: `Amount ${amount} exceeds remaining balance ${paymentDue}` }, 400);
	}

	const leg = { method, amount };
	let tipDelta = 0;

	if (method === 'giftcard') {
		const giftcardId = body.giftcardId;
		if (!giftcardId) return res.json({ error: 'Missing giftcardId' }, 400);

		let giftcard;
		try {
			giftcard = await databases.getDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, giftcardId);
		} catch (err) {
			error('Failed to read giftcard: ' + err.message);
			return res.json({ error: 'Giftcard not found' }, 404);
		}

		const balance = parseInt(giftcard.balance) || 0;
		if (amount > balance) {
			return res.json({ error: `Amount ${amount} exceeds giftcard balance ${balance}` }, 400);
		}

		try {
			await databases.updateDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, giftcardId, {
				balance: balance - amount,
			});
		} catch (err) {
			error('Failed to decrement giftcard balance: ' + err.message);
			return res.json({ error: 'Failed to update giftcard balance' }, 500);
		}

		leg.giftcardId = giftcardId;
	}

	if (method === 'stripe') {
		const paymentIntentId = body.paymentIntentId;
		if (!paymentIntentId) return res.json({ error: 'Missing paymentIntentId' }, 400);

		const key = transaction.testing ? process.env.testKey : process.env.prodKey;
		const stripe = new Stripe(key);

		let paymentIntent;
		try {
			paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
		} catch (err) {
			error('Failed to retrieve PaymentIntent: ' + err.message);
			return res.json({ error: `Failed to verify payment: ${err.message}` }, 400);
		}

		if (paymentIntent.status !== 'succeeded') {
			return res.json({ error: `PaymentIntent is not succeeded (status: ${paymentIntent.status})` }, 400);
		}
		if (paymentIntent.amount !== amount) {
			error(`PaymentIntent amount ${paymentIntent.amount} does not match leg amount ${amount}`);
			return res.json({ error: 'PaymentIntent amount does not match this payment leg' }, 400);
		}

		tipDelta = parseInt(paymentIntent.amount_details?.tip?.amount || 0);
		leg.stripeId = paymentIntent.id;
		leg.tip = tipDelta;
	}

	let payments;
	try {
		payments = JSON.parse(transaction.payments || '[]');
	} catch (err) {
		payments = [];
	}
	payments.push(leg);

	const newPaymentDue = Math.max(paymentDue - amount, 0);
	const newStatus = newPaymentDue <= 0 ? 'complete' : 'pending';
	// Only one leg so far -> keep the legacy single-method label for
	// backward-compatible display; more than one -> "split". Purely
	// cosmetic (the real breakdown lives in `payments`).
	const newPaymentMethod = payments.length > 1 ? 'split' : method;

	try {
		await databases.updateDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transactionId, {
			payments: JSON.stringify(payments),
			payment_due: newPaymentDue,
			status: newStatus,
			payment_method: newPaymentMethod,
			tip: (parseInt(transaction.tip) || 0) + tipDelta,
		});
	} catch (err) {
		error('Failed to record payment leg: ' + err.message);
		return res.json({ error: 'Failed to update transaction' }, 500);
	}

	log(`Recorded ${method} leg of ${amount} on ${transactionId}: ${newPaymentDue} remaining, status ${newStatus}`);
	return res.json({ ok: true, remaining: newPaymentDue, status: newStatus });
};
