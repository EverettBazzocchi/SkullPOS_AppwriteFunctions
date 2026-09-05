import Stripe from 'stripe';
import { Databases } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Records a completed Stripe Terminal card payment on a pending
// transaction. Verifies the PaymentIntent against the real Stripe API
// server-side (status is "succeeded" and the amount matches what this
// transaction actually expects) before writing anything -- the client
// can't just claim a stripe_id succeeded, and can't point a transaction at
// an unrelated PaymentIntent (which would otherwise let a later refund get
// misdirected at someone else's real charge).
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const transactionId = body.transactionId;
	const paymentIntentId = body.paymentIntentId;
	if (!transactionId || !paymentIntentId) {
		return res.json({ error: 'Missing transactionId or paymentIntentId' }, 400);
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
	const expectedAmount = parseInt(transaction.payment_due) || 0;
	if (paymentIntent.amount !== expectedAmount) {
		error(`PaymentIntent amount ${paymentIntent.amount} does not match expected ${expectedAmount}`);
		return res.json({ error: 'PaymentIntent amount does not match the transaction' }, 400);
	}

	const tip = parseInt(paymentIntent.amount_details?.tip?.amount || 0);

	try {
		await databases.updateDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transactionId, {
			status: 'complete',
			tip,
			stripe_id: paymentIntent.id,
			transaction_data: JSON.stringify(paymentIntent),
		});
	} catch (err) {
		error('Failed to update transaction: ' + err.message);
		return res.json({ error: 'Payment verified but failed to update the transaction record' }, 500);
	}

	log(`Transaction ${transactionId} recorded as paid via ${paymentIntent.id}`);
	return res.json({ ok: true, tip });
};
