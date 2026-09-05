import { Databases } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Applies a giftcard payment to a pending transaction: re-reads the
// transaction and giftcard fresh (never trusts a client-supplied balance),
// computes the applied/remaining split, writes the transaction fields, and
// decrements the giftcard balance -- all server-side, so the client never
// needs write access to either collection (which would otherwise let any
// session set an arbitrary giftcard balance directly).
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const GIFTCARDS_COLLECTION_ID = 'giftcards';

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const transactionId = body.transactionId;
	const giftcardId = body.giftcardId;
	if (!transactionId || !giftcardId) {
		return res.json({ error: 'Missing transactionId or giftcardId' }, 400);
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

	// Only a fresh, untouched pending transaction can have a giftcard
	// applied -- blocks re-applying against an already-finalized or
	// already-giftcard-paid transaction.
	if (transaction.status !== 'pending') {
		return res.json({ error: `Transaction is not pending (status: ${transaction.status})` }, 400);
	}
	if (Array.isArray(transaction.giftcards) && transaction.giftcards.length > 0) {
		return res.json({ error: 'Transaction already has a giftcard applied' }, 400);
	}

	let giftcard;
	try {
		giftcard = await databases.getDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, giftcardId);
	} catch (err) {
		error('Failed to read giftcard: ' + err.message);
		return res.json({ error: 'Giftcard not found' }, 404);
	}

	const paymentDue = parseInt(transaction.payment_due) || 0;
	const giftBalance = parseInt(giftcard.balance) || 0;
	const applied = Math.min(giftBalance, paymentDue);
	const remaining = paymentDue - applied;
	const newStatus = remaining > 0 ? 'pending' : 'complete';
	const newPaymentMethod = remaining > 0 ? 'giftcard+stripe' : 'giftcard';

	try {
		await databases.updateDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transactionId, {
			giftcards: [giftcardId],
			giftcard_amount: applied,
			payment_due: remaining,
			payment_method: newPaymentMethod,
			status: newStatus,
		});
	} catch (err) {
		error('Failed to update transaction: ' + err.message);
		return res.json({ error: 'Failed to apply giftcard to transaction' }, 500);
	}

	try {
		await databases.updateDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, giftcardId, {
			balance: giftBalance - applied,
		});
	} catch (err) {
		error('Failed to decrement giftcard balance: ' + err.message);
		return res.json(
			{
				error: 'Transaction updated but failed to decrement giftcard balance -- please reconcile manually',
				applied,
				remaining,
			},
			500,
		);
	}

	log(`Applied giftcard ${giftcardId}: ${applied} of ${paymentDue}, ${remaining} remaining`);
	return res.json({ ok: true, applied, remaining, status: newStatus, paymentMethod: newPaymentMethod });
};
