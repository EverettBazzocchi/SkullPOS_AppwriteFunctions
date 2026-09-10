import { Query } from 'node-appwrite';

export const TICKETS_COLLECTION_ID = 'tickets';

// A cancelled/refunded ticket was never actually attended and its revenue was reversed -- kept
// in sync by hand with the identical set in SkullAdminApp/src/services/ticketingService.ts.
const VOID_TICKET_STATUSES = new Set(['CANCELLED', 'REFUNDED']);

/**
 * Sums the price of every sold (non-cancelled/refunded), live (non-test) ticket for an event,
 * matched by exact event name -- tickets carry no eventId foreign key, so this is the same
 * correlation the admin app's Ticketing Report and event detail view already rely on.
 *
 * paymentMode is filtered in JS rather than via a Query.notEqual('paymentMode', 'TEST') clause:
 * it's an optional attribute, and some tickets predate it being set at all, so a server-side
 * inequality filter risks excluding them under SQL-style NULL comparison semantics. Filtering
 * "TEST" out in JS (treating anything else, including missing, as live) avoids that entirely.
 */
export async function fetchEventTicketRevenue(databases, databaseId, eventName, fetchAllDocuments) {
	const tickets = await fetchAllDocuments(databases, databaseId, TICKETS_COLLECTION_ID, [Query.equal('eventName', eventName)]);
	return tickets.reduce((sum, ticket) => {
		if (VOID_TICKET_STATUSES.has(ticket.status)) return sum;
		if (ticket.paymentMode === 'TEST') return sum;
		return sum + (ticket.price || 0);
	}, 0);
}
