import Stripe from 'stripe';
import { Databases } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { derivePaymentLegs } from './paymentLegs.js';

// Refunds a whole transaction: reads it server-side (never trusts client
// input for what to refund), reverses every payment leg (any mix of
// cash/card/giftcard, including multiple separate cards on a split sale),
// and marks the transaction refunded -- all in one place, so the client
// never needs write access to Transactions/giftcards to do any of this
// (which would otherwise let any session flip a transaction's status
// directly, cash-paid ones especially, since there's no external payment
// step to gate a cash refund).
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

	const legs = derivePaymentLegs(transaction);

	// Flip status to "refunded" FIRST, before reversing any leg below --
	// this is the idempotency guard. If a leg's reversal fails and this
	// gets retried, the status===refunded check above stops it from
	// re-running an already-succeeded reversal (e.g. crediting a giftcard
	// twice). A failure after this point means a human needs to finish the
	// remaining leg(s) manually -- safer than silently double-refunding/
	// double-crediting on retry.
	try {
		await databases.updateDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transactionId, {
			status: 'refunded',
		});
	} catch (err) {
		error('Failed to mark transaction refunded: ' + err.message);
		return res.json({ error: `Failed to mark transaction refunded: ${err.message}` }, 500);
	}

	const stripeKey = transaction.testing ? process.env.testKey : process.env.prodKey;
	const results = [];

	for (const leg of legs) {
		try {
			if (leg.method === 'stripe') {
				const stripe = new Stripe(stripeKey);
				await stripe.refunds.create({
					payment_intent: leg.stripeId,
					...(leg.amount ? { amount: parseInt(leg.amount) } : {}),
				});
				log(`Stripe refund created for ${leg.stripeId} (${leg.amount})`);
			} else if (leg.method === 'giftcard') {
				const giftcard = await databases.getDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, leg.giftcardId);
				await databases.updateDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, leg.giftcardId, {
					balance: (parseInt(giftcard.balance) || 0) + leg.amount,
				});
				log(`Giftcard ${leg.giftcardId} credited back ${leg.amount}`);
			}
			// cash legs: no external action, staff hands the cash back physically
			results.push({ ...leg, reversed: true });
		} catch (err) {
			error(`Failed to reverse ${leg.method} leg (${leg.amount}): ` + err.message);
			results.push({ ...leg, reversed: false, error: err.message });
		}
	}

	const failed = results.filter((r) => !r.reversed);
	if (failed.length > 0) {
		return res.json(
			{
				error:
					'Transaction marked refunded, but some payment legs failed to reverse -- please handle these manually: ' +
					failed.map((f) => `${f.method} ${f.amount} (${f.error})`).join('; '),
				legs: results,
			},
			500,
		);
	}

	log('Transaction refunded: ' + transactionId);
	return res.json({ ok: true, legs: results });
};
