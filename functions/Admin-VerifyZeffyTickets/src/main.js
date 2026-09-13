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

// Prefix stamped onto a dead-lettered row's errorMessage once this job has established the row can
// never be replayed from its own stored payload (unparseable, or a truncation marker written by
// Zeffy-Webhook because the real payload didn't fit the 5000-char column). Such a row used to be
// re-parsed, re-failed and re-logged on every single run, forever, with nothing reading the
// response that said so. Stamping it means later runs report it once, in its own bucket, instead
// of burying a genuinely retryable failure in noise. The row is deliberately NOT deleted: phase 2
// recovers the payment from Zeffy's own API, and the row is the only record that it needs to.
const UNREPLAYABLE_PREFIX = 'UNREPLAYABLE: ';

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

/** Stamps a row as never-replayable so later runs stop reprocessing it. Never throws. */
async function markUnreplayable(databases, row, reason, error) {
	if (String(row.errorMessage || '').startsWith(UNREPLAYABLE_PREFIX)) return;
	try {
		await databases.updateDocument(DATABASE_ID, FAILED_WEBHOOKS_COLLECTION_ID, row.$id, {
			errorMessage: `${UNREPLAYABLE_PREFIX}${reason}`.slice(0, 999),
		});
	} catch (err) {
		error(`Could not mark dead-lettered webhook ${row.$id} as unreplayable: ` + err.message);
	}
}

async function retryFailedWebhooks(databases, log, error) {
	let deadLettered;
	try {
		deadLettered = await listZeffyFailedWebhooks(databases);
	} catch (err) {
		error('Failed to list failed_webhooks: ' + err.message);
		return { retried: 0, succeeded: 0, stillFailing: [], unreplayable: [], listError: 'Failed to list failed_webhooks' };
	}

	let succeeded = 0;
	const stillFailing = [];
	const unreplayable = [];

	for (const row of deadLettered) {
		if (String(row.errorMessage || '').startsWith(UNREPLAYABLE_PREFIX)) {
			unreplayable.push({ id: row.$id, transactionId: row.transactionId, error: row.errorMessage });
			continue;
		}

		let parsed;
		try {
			parsed = JSON.parse(row.payload || '{}');
		} catch (err) {
			const reason = 'Unparseable dead-lettered payload: ' + err.message;
			error(`Dead-lettered webhook ${row.$id} has an unparseable payload: ` + err.message);
			await markUnreplayable(databases, row, reason, error);
			unreplayable.push({ id: row.$id, transactionId: row.transactionId, error: reason });
			continue;
		}

		// Zeffy-Webhook couldn't fit the real payload in the column and stored a marker instead.
		// There is nothing here to persist -- replaying it would write a ticket-less ghost order.
		// Phase 2 below recovers the payment in full from Zeffy's Payments API.
		if (parsed && parsed.truncated) {
			const reason = `Payload was too large to dead-letter (${parsed.originalLength || 'unknown'} chars); recover transaction ${
				parsed.transactionId || row.transactionId
			} from the Zeffy Payments API`;
			error(`Dead-lettered webhook ${row.$id}: ${reason}.`);
			await markUnreplayable(databases, row, reason, error);
			unreplayable.push({ id: row.$id, transactionId: parsed.transactionId || row.transactionId, error: reason });
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

	log(
		`Retried ${deadLettered.length} dead-lettered Zeffy webhook(s): ${succeeded} succeeded, ${stillFailing.length} still failing, ` +
			`${unreplayable.length} unreplayable (recoverable only via the Zeffy API pass).`,
	);
	return { retried: deadLettered.length, succeeded, stillFailing, unreplayable };
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
	const repairedOrders = [];

	for (const payment of payments) {
		try {
			const parsed = parsedFromZeffyPayment(payment);
			const result = await persistZeffyPayment(databases, parsed, log);
			if (result.orderCreated) ordersCreated++;
			ticketsSaved += result.ticketsSaved || 0;

			// The invariant this pass actually exists to enforce: every succeeded Zeffy payment has
			// one ticket per line item. An order row already being present was never proof of that
			// -- the order and its tickets are written by separate calls, so a run that died between
			// them (or the id-less-line-item bug that made ticket writes non-idempotent) left an
			// order with missing tickets, and every later run then 409'd on the order and reported
			// a clean sweep while the buyer was refused at the door. Creating tickets against an
			// EXISTING order is therefore a repair, and is reported as one rather than folded into
			// the same count as a brand-new order's tickets.
			if (!result.orderCreated && result.ticketsSaved > 0) {
				const detail = `order ${parsed.transactionId} already existed but was missing ${result.ticketsSaved} of its ${result.ticketsExpected} ticket(s) -- created now`;
				error(`Zeffy reconciliation repaired an incomplete order: ${detail}.`);
				repairedOrders.push({
					id: parsed.transactionId,
					ticketsCreated: result.ticketsSaved,
					ticketsExpected: result.ticketsExpected,
				});
			}
		} catch (err) {
			error(`Failed to reconcile Zeffy payment ${payment.id}: ` + err.message);
			failures.push({ id: payment.id, error: err.message });
		}
	}

	log(
		`Checked ${payments.length} succeeded Zeffy payment(s): ${ordersCreated} order(s) and ${ticketsSaved} ticket(s) were missing and have been created.` +
			(repairedOrders.length > 0 ? ` ${repairedOrders.length} already-recorded order(s) were missing tickets and have been repaired.` : ''),
	);
	return { skipped: false, checked: payments.length, ordersCreated, ticketsSaved, repairedOrders, failures };
}

export default async ({ req, res, log, error }) => {
	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	const failedWebhookRetry = await retryFailedWebhooks(databases, log, error);
	const zeffyApiReconciliation = await reconcileAgainstZeffyApi(databases, log, error);

	return res.json({ failedWebhookRetry, zeffyApiReconciliation });
};
