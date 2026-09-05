import Stripe from 'stripe';
import { Databases } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Refunds a whole transaction: reads it server-side (never trusts client
// input for what to refund), refunds the card portion via Stripe if paid,
// credits back the giftcard portion if applied, and marks the transaction
// refunded -- all in one place, so the client never needs write access to
// Transactions/giftcards to do any of this (which would otherwise let any
// session flip a transaction's status directly, cash-paid ones especially,
// since there's no external payment step to gate a cash refund).
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const GIFTCARDS_COLLECTION_ID = 'giftcards';

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		error('Invalid JSON body: ' + err.message);
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const transactionId = body.transactionId;
	if (!transactionId) {
		return res.json({ error: 'Missing transactionId' }, 400);
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

	if (transaction.status === 'refunded') {
		return res.json({ error: 'Transaction has already been refunded' }, 400);
	}
	if (transaction.status !== 'complete') {
		return res.json({ error: `Only completed transactions can be refunded (current status: ${transaction.status})` }, 400);
	}

	// Flip status to "refunded" FIRST, before the Stripe/giftcard side
	// effects below -- this is the idempotency guard. If a later step
	// fails and this gets retried, the status===refunded check above stops
	// it from re-running an already-succeeded side effect (e.g. crediting
	// a giftcard twice). A failure after this point means a human needs to
	// finish the Stripe/giftcard side manually -- safer than silently
	// double-refunding/double-crediting on retry.
	try {
		await databases.updateDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transactionId, {
			status: 'refunded',
		});
	} catch (err) {
		error('Failed to mark transaction refunded: ' + err.message);
		return res.json({ error: `Failed to mark transaction refunded: ${err.message}` }, 500);
	}

	// Card portion -- keyed off the transaction's own testing flag, not
	// a client-asserted one, so a refund always uses the same Stripe mode
	// the original charge was made in.
	if (transaction.stripe_id) {
		const key = transaction.testing ? process.env.testKey : process.env.prodKey;
		const stripe = new Stripe(key);
		try {
			await stripe.refunds.create({
				payment_intent: transaction.stripe_id,
				...(transaction.payment_due ? { amount: parseInt(transaction.payment_due) } : {}),
			});
			log('Stripe refund created for ' + transaction.stripe_id);
		} catch (err) {
			error('Stripe refund failed: ' + err.message);
			return res.json({ error: `Stripe refund failed: ${err.message}` }, 400);
		}
	}

	// Giftcard portion
	const giftcardIds = Array.isArray(transaction.giftcards) ? transaction.giftcards : [];
	const giftcardAmount = parseInt(transaction.giftcard_amount) || 0;
	if (giftcardIds.length > 0 && giftcardAmount > 0) {
		const giftcardId = typeof giftcardIds[0] === 'object' ? giftcardIds[0].$id : giftcardIds[0];
		try {
			const giftcard = await databases.getDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, giftcardId);
			await databases.updateDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, giftcardId, {
				balance: (parseInt(giftcard.balance) || 0) + giftcardAmount,
			});
			log('Giftcard ' + giftcardId + ' credited back ' + giftcardAmount);
		} catch (err) {
			error('Giftcard credit-back failed: ' + err.message);
			return res.json(
				{
					error:
						(transaction.stripe_id ? 'Card refunded, but t' : 'T') +
						`he gift card balance failed to update -- please credit it back manually. (${err.message})`,
				},
				500,
			);
		}
	}

	log('Transaction refunded: ' + transactionId);
	return res.json({ ok: true });
};
