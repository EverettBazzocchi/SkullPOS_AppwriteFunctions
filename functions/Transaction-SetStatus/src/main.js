import { Databases } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Sets a pending transaction's status to "complete" (cash payment
// confirmed) or "cancelled" (staff cancelled an in-progress card attempt).
// Never accepts "refunded" -- that's exclusively Stripe-RefundPayment's job
// -- and only transitions out of "pending", so this can't be replayed
// against an already-finalized transaction. The client has no write access
// to Transactions at all (see the POS PIN-system security plan), which is
// what makes "no refunds in quick-access PIN mode" a real restriction
// rather than a client-side flag: a cash-paid transaction can't be marked
// refunded except through Stripe-RefundPayment, whose execute permission
// is staff-team-only.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const ALLOWED_STATUSES = ['complete', 'cancelled'];

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

	try {
		await databases.updateDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transactionId, { status });
	} catch (err) {
		error('Failed to update transaction status: ' + err.message);
		return res.json({ error: 'Failed to update transaction status' }, 500);
	}

	log(`Transaction ${transactionId} set to ${status}`);
	return res.json({ ok: true, status });
};
