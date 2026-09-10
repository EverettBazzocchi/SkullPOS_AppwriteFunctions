import { Query } from 'node-appwrite';
import { generateFallbackTicketCode } from './ticketId.js';

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

/**
 * Idempotently writes one `orders` document and one `tickets` document per line item for a
 * parsed Zeffy `payment.completed` payload -- safe to call more than once for the same
 * transaction (checks `orderId`/`ticketId` before creating either).
 */
export async function persistZeffyPayment(databases, parsed, log) {
	if (parsed.eventType !== 'payment.completed') {
		return { skipped: true, reason: `event type "${parsed.eventType}" is not persisted` };
	}

	const { eventName, amount, currency, buyerName, email, paymentMethodType, items } = parsed;
	const transactionId = String(parsed.transactionId);

	const existingOrders = await databases.listDocuments(DATABASE_ID, ORDERS_COLLECTION_ID, [
		Query.equal('orderId', transactionId),
		Query.limit(1),
	]);

	let orderCreated = false;
	if (existingOrders.documents.length === 0) {
		await databases.createDocument(DATABASE_ID, ORDERS_COLLECTION_ID, 'unique()', {
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
	} else if (log) {
		log(`Order ${transactionId} already recorded -- skipping duplicate.`);
	}

	let ticketsSaved = 0;
	for (const item of items) {
		const ticketCode = String(item.id || generateFallbackTicketCode(transactionId));

		const existingTickets = await databases.listDocuments(DATABASE_ID, TICKETS_COLLECTION_ID, [
			Query.equal('ticketId', ticketCode),
			Query.limit(1),
		]);
		if (existingTickets.documents.length > 0) {
			if (log) log(`Ticket ${ticketCode} already recorded -- skipping.`);
			continue;
		}

		await databases.createDocument(DATABASE_ID, TICKETS_COLLECTION_ID, 'unique()', {
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
	}

	return { orderCreated, ticketsSaved };
}
