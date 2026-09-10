import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { persistZeffyPayment, DATABASE_ID, FAILED_WEBHOOKS_COLLECTION_ID } from './zeffyPersist.js';
import { fetchAllZeffySucceededPayments, parsedFromZeffyPayment } from './zeffyApi.js';

// Runs every 12 hours in two phases, both against the exact same idempotent write path
// (zeffyPersist.js) Zeffy-Webhook itself uses:
//
// 1. Retries every dead-lettered ZEFFY row in failed_webhooks (populated when the live webhook
//    couldn't persist an order/ticket -- a DB hiccup, an unexpected payload shape) and clears any
//    row that succeeds.
// 2. A full reconciliation against Zeffy's own Payments API
//    (https://www.zeffy.com/api/docs#tag/payments/GET/api/v1/payments) -- every succeeded
//    payment Zeffy has on record, not just what a webhook happened to deliver here. This is what
//    actually verifies every Zeffy ticket is in the database, independent of whether the webhook
//    ever fired at all (e.g. an outage on Zeffy's side, a misconfigured/undelivered webhook,
//    Zeffy's own retry window expiring).
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

async function retryFailedWebhooks(databases, log, error) {
	let deadLettered;
	try {
		deadLettered = await listZeffyFailedWebhooks(databases);
	} catch (err) {
		error('Failed to list failed_webhooks: ' + err.message);
		return { retried: 0, succeeded: 0, stillFailing: [], listError: 'Failed to list failed_webhooks' };
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
	return { retried: deadLettered.length, succeeded, stillFailing };
}

async function reconcileAgainstZeffyApi(databases, log, error) {
	const apiKey = process.env.ZEFFY_API_KEY;
	if (!apiKey) {
		log('ZEFFY_API_KEY is not configured -- skipping the full Zeffy API reconciliation pass.');
		return { skipped: true, checked: 0, ordersCreated: 0, ticketsSaved: 0, failures: [] };
	}

	let payments;
	try {
		payments = await fetchAllZeffySucceededPayments(apiKey, log);
	} catch (err) {
		error('Failed to fetch payments from the Zeffy API: ' + err.message);
		return { skipped: false, checked: 0, ordersCreated: 0, ticketsSaved: 0, failures: [{ error: 'Failed to fetch Zeffy payments: ' + err.message }] };
	}

	let ordersCreated = 0;
	let ticketsSaved = 0;
	const failures = [];

	for (const payment of payments) {
		try {
			const parsed = parsedFromZeffyPayment(payment);
			const result = await persistZeffyPayment(databases, parsed, log);
			if (result.orderCreated) ordersCreated++;
			ticketsSaved += result.ticketsSaved || 0;
		} catch (err) {
			error(`Failed to reconcile Zeffy payment ${payment.id}: ` + err.message);
			failures.push({ id: payment.id, error: err.message });
		}
	}

	log(`Checked ${payments.length} succeeded Zeffy payment(s): ${ordersCreated} order(s) and ${ticketsSaved} ticket(s) were missing and have been created.`);
	return { skipped: false, checked: payments.length, ordersCreated, ticketsSaved, failures };
}

export default async ({ req, res, log, error }) => {
	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	const failedWebhookRetry = await retryFailedWebhooks(databases, log, error);
	const zeffyApiReconciliation = await reconcileAgainstZeffyApi(databases, log, error);

	return res.json({ failedWebhookRetry, zeffyApiReconciliation });
};
