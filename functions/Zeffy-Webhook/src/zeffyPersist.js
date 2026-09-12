import { ID } from 'node-appwrite';
import { generateFallbackTicketCode } from './ticketId.js';
import { deriveDeterministicId } from './deterministicId.js';

/**
 * Kept in sync by hand with the identical copy in
 * functions/Admin-VerifyZeffyTickets/src/zeffyPersist.js -- the 12h verify job reprocesses
 * dead-lettered payloads (rows in the failed_webhooks collection) through this exact same idempotent
 * write path so a payload retried later can never diverge from what the live webhook would have
 * written.
 */
export const DATABASE_ID = '67c9ffd9003d68236514';
export const ORDERS_COLLECTION_ID = 'orders';
export const TICKETS_COLLECTION_ID = 'tickets';
export const FAILED_WEBHOOKS_COLLECTION_ID = 'failed_webhooks';

// Appwrite's own document-uniqueness constraint reports a conflict as a 409. Treating that as
// "already recorded" (rather than only ever checking-then-creating) is what makes a genuine
// duplicate webhook delivery -- which Zeffy's own retry policy can produce -- land on the same
// document instead of racing a separate existence check.
function isConflict(err) {
	return err && (err.code === 409 || err.type === 'document_already_exists');
}

/**
 * Idempotently writes one `orders` document and one `tickets` document per line item for a
 * parsed Zeffy `payment.completed` payload -- safe to call more than once for the same
 * transaction. Each document's id is deterministically derived from the Zeffy transaction/ticket
 * id (see deterministicId.js), so a duplicate `createDocument` call fails atomically on
 * Appwrite's own uniqueness constraint instead of racing a separate `listDocuments` check.
 */
export async function persistZeffyPayment(databases, parsed, log) {
	if (parsed.eventType !== 'payment.completed') {
		return { skipped: true, reason: `event type "${parsed.eventType}" is not persisted` };
	}

	const { eventName, amount, currency, buyerName, email, paymentMethodType, items } = parsed;
	const transactionId = String(parsed.transactionId);

	let orderCreated = false;
	try {
		await databases.createDocument(DATABASE_ID, ORDERS_COLLECTION_ID, ID.custom(deriveDeterministicId('zfo', transactionId)), {
			orderId: transactionId,
			source: 'ZEFFY',
			customerName: buyerName,
			customerEmail: email,
			totalAmount: amount,
			currency,
			paymentStatus: 'COMPLETED',
			paymentMode: 'LIVE',
			paymentMethod: paymentMethodType,
			createdAt: new Date().toISOString(),
		});
		orderCreated = true;
	} catch (err) {
		if (!isConflict(err)) throw err;
		if (log) log(`Order ${transactionId} already recorded -- skipping duplicate.`);
	}

	let ticketsSaved = 0;
	for (const item of items) {
		const ticketCode = String(item.id || generateFallbackTicketCode(transactionId));

		try {
			await databases.createDocument(DATABASE_ID, TICKETS_COLLECTION_ID, ID.custom(deriveDeterministicId('zft', ticketCode)), {
				ticketId: ticketCode,
				orderId: transactionId,
				source: 'ZEFFY',
				eventName,
				ticketType: item.type || 'Standard Ticket',
				attendeeName: buyerName,
				attendeeEmail: email,
				price: parseInt(item.amount || amount, 10),
				currency,
				status: 'VALID',
				paymentMode: 'LIVE',
				createdAt: new Date().toISOString(),
			});
			ticketsSaved++;
		} catch (err) {
			if (!isConflict(err)) throw err;
			if (log) log(`Ticket ${ticketCode} already recorded -- skipping.`);
		}
	}

	return { orderCreated, ticketsSaved };
}
