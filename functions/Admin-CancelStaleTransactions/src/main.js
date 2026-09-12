import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Runs daily (see appwrite.config.json's schedule) to cancel transactions that have been
// stuck in "pending" for 1+ hour -- a real card payment resolves in seconds/minutes, so a
// pending transaction that old is almost certainly abandoned (customer walked away, terminal
// disconnected, etc.), not one still genuinely in progress. Uses the exact same status
// transition Transaction-SetStatus already allows a staff member to do manually
// (pending -> cancelled only) -- this just does it automatically, on staleness instead of an
// explicit staff action.
//
// Also callable directly (admin-team execute permission) for manual/testing runs, but the
// primary trigger is the schedule.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const GIFTCARDS_COLLECTION_ID = 'giftcards';
const STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour
const PAGE_SIZE = 100;

// A split-tender sale can have one or more legs already recorded (by
// Transaction-RecordPayment) against a transaction that's STILL "pending"
// (e.g. giftcard covered part of the total, the card portion never
// finished) -- auto-cancelling it outright would silently strand whatever
// those legs already moved. Only the modern `payments` JSON array can hold
// a leg on a still-pending transaction: transactions from before the
// split-payment migration never supported partial/split tender, so
// there's nothing legacy to derive here (contrast Stripe-RefundPayment's
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

async function listStalePendingTransactions(databases, cutoffIso) {
	let all = [];
	let lastId = null;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const queries = [
			Query.equal('status', 'pending'),
			Query.lessThanEqual('$createdAt', cutoffIso),
			Query.orderAsc('$id'),
			Query.limit(PAGE_SIZE),
		];
		if (lastId) queries.push(Query.cursorAfter(lastId));

		const page = await databases.listDocuments(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, queries);
		const batch = page.documents || [];
		all = all.concat(batch);

		if (batch.length < PAGE_SIZE) break;
		lastId = batch[batch.length - 1].$id;
	}

	return all;
}

export default async ({ req, res, log, error }) => {
	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	const cutoff = new Date(Date.now() - STALE_AFTER_MS);

	let staleTransactions;
	try {
		staleTransactions = await listStalePendingTransactions(databases, cutoff.toISOString());
	} catch (err) {
		error('Failed to list pending transactions: ' + err.message);
		return res.json({ error: 'Failed to list pending transactions' }, 500);
	}

	let cancelled = 0;
	const failures = [];
	const needsManualReview = [];

	for (const transaction of staleTransactions) {
		const legs = getRecordedLegs(transaction);

		// A stripe leg means real money was already captured -- reversing that is a real Stripe
		// refund, not just a ledger fix, and this unattended daily sweep must never trigger one
		// on its own. Skip it (not a "failure") and surface it so a human decides: refund it
		// properly, or leave the sale as-is.
		const stripeLegs = legs.filter((leg) => leg.method === 'stripe');
		if (stripeLegs.length > 0) {
			error(
				`Skipping auto-cancel of ${transaction.$id}: it already has a captured card payment leg (${stripeLegs
					.map((leg) => leg.stripeId)
					.join(', ')}) that needs a real Stripe refund, not just a status change.`,
			);
			needsManualReview.push({ transactionId: transaction.$id, reason: 'has a captured stripe leg -- refund it manually first' });
			continue;
		}

		// Flip status FIRST, before reversing any giftcard leg below -- this is the idempotency
		// guard (mirrors Stripe-RefundPayment/Transaction-SetStatus). If a reversal fails and
		// this transaction is picked up again on a future run, it's no longer "pending" so it
		// won't be re-selected in the first place.
		try {
			await databases.updateDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transaction.$id, { status: 'cancelled' });
			cancelled++;
		} catch (err) {
			error(`Failed to cancel transaction ${transaction.$id}: ` + err.message);
			failures.push({ transactionId: transaction.$id, error: err.message });
			continue;
		}

		const giftcardLegs = legs.filter((leg) => leg.method === 'giftcard' && leg.giftcardId);
		for (const leg of giftcardLegs) {
			try {
				const giftcard = await databases.getDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, leg.giftcardId);
				const newBalance = (parseInt(giftcard.balance) || 0) + (parseInt(leg.amount) || 0);
				await databases.updateDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, leg.giftcardId, { balance: newBalance });
				log(`Giftcard ${leg.giftcardId} credited back ${leg.amount} (transaction ${transaction.$id} auto-cancelled)`);
			} catch (err) {
				error(`Transaction ${transaction.$id} was cancelled, but failed to reverse its giftcard leg ${leg.giftcardId}: ` + err.message);
				failures.push({
					transactionId: transaction.$id,
					error: `cancelled, but failed to restore giftcard ${leg.giftcardId}'s balance: ${err.message}`,
				});
			}
		}
	}

	log(
		`Cancelled ${cancelled}/${staleTransactions.length} stale pending transaction(s) (pending 1+ hour, cutoff ${cutoff.toISOString()}).` +
			(needsManualReview.length > 0 ? ` ${needsManualReview.length} skipped for manual review (captured card leg).` : ''),
	);

	return res.json({
		cutoff: cutoff.toISOString(),
		staleFound: staleTransactions.length,
		cancelled,
		failures,
		needsManualReview,
	});
};
