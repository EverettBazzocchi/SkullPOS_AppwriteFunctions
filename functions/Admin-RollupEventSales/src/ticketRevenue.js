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
 *
 * `bounds` ({ from, to }, either side optional, both Dates) scopes the match to one occurrence of a
 * REPEATING event name. Zeffy's own eventName comes from the payment description, which repeats
 * across a campaign's occurrences, so a venue that runs the same night twice had every occurrence
 * match every occurrence's tickets -- each one counting the others' sales, permanently, with no way
 * to tell from the data. Only the caller knows whether a name repeats, so it passes no bounds at
 * all for a name that occurs once (the overwhelming majority): an unbounded match is what keeps a
 * ticket written LATE -- a door sale rung up after close, or a payment recovered days afterwards by
 * Admin-VerifyZeffyTickets -- counted, and that must not regress just to disambiguate the rare
 * repeating name.
 */
export async function fetchEventTicketRevenue(databases, databaseId, eventName, fetchAllDocuments, bounds = null) {
	const queries = [Query.equal('eventName', eventName)];
	if (bounds && bounds.from) queries.push(Query.greaterThanEqual('$createdAt', bounds.from.toISOString()));
	if (bounds && bounds.to) queries.push(Query.lessThanEqual('$createdAt', bounds.to.toISOString()));

	const tickets = await fetchAllDocuments(databases, databaseId, TICKETS_COLLECTION_ID, queries);
	return tickets.reduce((sum, ticket) => {
		if (VOID_TICKET_STATUSES.has(ticket.status)) return sum;
		if (ticket.paymentMode === 'TEST') return sum;
		return sum + (ticket.price || 0);
	}, 0);
}

/**
 * For each event, the window its tickets may have been bought in -- keyed by event $id.
 *
 * Only events whose `name` is shared with another event get bounds: consecutive occurrences of the
 * same name split the timeline at the midpoint between one's end and the next one's start, so every
 * ticket is attributed to the nearest occurrence and none is counted twice. An event whose name is
 * unique gets `null`, i.e. today's unbounded behaviour, unchanged.
 */
export function buildTicketBoundsByEventId(eventsWithWindows) {
	const byName = new Map();
	for (const entry of eventsWithWindows) {
		const name = entry.event.name;
		if (!name) continue;
		if (!byName.has(name)) byName.set(name, []);
		byName.get(name).push(entry);
	}

	const bounds = {};
	for (const occurrences of byName.values()) {
		if (occurrences.length < 2) continue;
		const sorted = [...occurrences].sort((a, b) => a.window.start - b.window.start);

		sorted.forEach((entry, i) => {
			const previous = sorted[i - 1];
			const next = sorted[i + 1];
			const splitBefore = previous ? Math.floor((previous.window.end.getTime() + entry.window.start.getTime()) / 2) : null;
			const splitAfter = next ? Math.floor((entry.window.end.getTime() + next.window.start.getTime()) / 2) : null;
			bounds[entry.event.$id] = {
				// The split instant itself belongs to the EARLIER occurrence (its bound is
				// inclusive), so +1ms here keeps a ticket written exactly on it from being counted
				// by both.
				from: splitBefore === null ? null : new Date(splitBefore + 1),
				to: splitAfter === null ? null : new Date(splitAfter),
			};
		});
	}

	return bounds;
}
