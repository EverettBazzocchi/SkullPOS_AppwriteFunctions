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
const STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour
const PAGE_SIZE = 100;

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

	for (const transaction of staleTransactions) {
		try {
			await databases.updateDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transaction.$id, { status: 'cancelled' });
			cancelled++;
		} catch (err) {
			error(`Failed to cancel transaction ${transaction.$id}: ` + err.message);
			failures.push({ transactionId: transaction.$id, error: err.message });
		}
	}

	log(`Cancelled ${cancelled}/${staleTransactions.length} stale pending transaction(s) (pending 1+ hour, cutoff ${cutoff.toISOString()}).`);

	return res.json({
		cutoff: cutoff.toISOString(),
		staleFound: staleTransactions.length,
		cancelled,
		failures,
	});
};
