import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { persistZeffyPayment, DATABASE_ID, FAILED_WEBHOOKS_COLLECTION_ID } from './zeffyPersist.js';

// Backstop for Zeffy-Webhook: whenever that function can't persist an order/ticket (a DB hiccup,
// an unexpected payload shape), it dead-letters the already-parsed payload into failed_webhooks
// instead of losing it. This runs every 12 hours, retries every ZEFFY-sourced dead-letter row
// through the exact same idempotent write path the webhook itself uses, and clears any row that
// succeeds -- so a transient failure eventually self-heals without a human replaying it by hand.
const PAGE_SIZE = 100;

async function listZeffyFailedWebhooks(databases) {
	let all = [];
	let lastId = null;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const queries = [Query.equal('source', 'ZEFFY'), Query.orderAsc('$id'), Query.limit(PAGE_SIZE)];
		if (lastId) queries.push(Query.cursorAfter(lastId));

		const page = await databases.listDocuments(DATABASE_ID, FAILED_WEBHOOKS_COLLECTION_ID, queries);
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

	let deadLettered;
	try {
		deadLettered = await listZeffyFailedWebhooks(databases);
	} catch (err) {
		error('Failed to list failed_webhooks: ' + err.message);
		return res.json({ error: 'Failed to list failed_webhooks' }, 500);
	}

	let succeeded = 0;
	const stillFailing = [];

	for (const row of deadLettered) {
		let parsed;
		try {
			parsed = JSON.parse(row.payload || '{}');
		} catch (err) {
			error(`Dead-lettered webhook ${row.$id} has an unparseable payload: ` + err.message);
			stillFailing.push({ id: row.$id, error: 'Unparseable dead-lettered payload: ' + err.message });
			continue;
		}

		try {
			await persistZeffyPayment(databases, parsed, log);
			await databases.deleteDocument(DATABASE_ID, FAILED_WEBHOOKS_COLLECTION_ID, row.$id);
			succeeded++;
		} catch (err) {
			error(`Retry failed for dead-lettered webhook ${row.$id}: ` + err.message);
			stillFailing.push({ id: row.$id, error: err.message });
		}
	}

	log(`Retried ${deadLettered.length} dead-lettered Zeffy webhook(s): ${succeeded} succeeded, ${stillFailing.length} still failing.`);
	return res.json({ retried: deadLettered.length, succeeded, stillFailing });
};
