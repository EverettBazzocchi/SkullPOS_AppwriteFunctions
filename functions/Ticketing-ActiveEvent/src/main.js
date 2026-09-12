import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Returns the currently-active event, reduced to the handful of fields a door-ticketing client
// legitimately needs to sell a ticket (name, price, currency, date/location for display).
//
// Why this exists at all rather than the client querying `Events` directly: ShottyTicketing's
// door sessions authenticate as a single shared Quick Access account that belongs to no team,
// while the Events collection is read-restricted to the admin team -- so the client's own read
// 401s and the app silently falls back to a generic "Standard Entry Pass" label. The obvious
// shortcut (granting that account read on Events) would hand a device sitting on the bar full
// read access to every event's sales rollup -- revenue, profit, cogs, tips, cash/card splits --
// since Appwrite permissions are per-collection, never per-field. This function is the field
// filter that Appwrite itself can't express: it reads as the server, returns only what the door
// needs, and never lets the financial columns off the box.
const DATABASE_ID = '67c9ffd9003d68236514';
const EVENTS_COLLECTION_ID = '68e400210008d19bb5c9';

// Matches the door client's own fallback when an event carries no explicit price (see
// ShottyTicketing's fetchActiveEvent/EventItem) so the two can't disagree about what a ticket
// costs when the field is unset.
const DEFAULT_TICKET_PRICE_CENTS = 3000;
const DEFAULT_CURRENCY = 'CAD';

// Deliberately an allowlist, not a denylist: a new financial column added to Events later must
// not start leaking just because nobody remembered to exclude it here.
function toPublicEvent(doc) {
	return {
		$id: doc.$id,
		eventId: doc.eventId ?? null,
		name: doc.name,
		description: doc.description ?? null,
		date: doc.date ?? null,
		location: doc.location ?? null,
		standardTicketPrice: parseInt(doc.standardTicketPrice) || DEFAULT_TICKET_PRICE_CENTS,
		currency: doc.currency || DEFAULT_CURRENCY,
		isActive: doc.isActive === true,
	};
}

export default async ({ req, res, log, error }) => {
	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	let documents;
	try {
		const result = await databases.listDocuments(DATABASE_ID, EVENTS_COLLECTION_ID, [
			Query.equal('isActive', true),
			Query.limit(1),
		]);
		documents = result.documents || [];
	} catch (err) {
		error('Failed to query the active event: ' + err.message);
		return res.json({ error: 'Failed to load the active event' }, 500);
	}

	if (documents.length === 0) {
		// Not an error: no event is running right now. The client shows its own generic entry-pass
		// label in this case, which is the correct thing to do -- distinguishing it from the 401
		// case this function exists to fix.
		log('No active event');
		return res.json({ event: null });
	}

	const event = toPublicEvent(documents[0]);
	log(`Active event: ${event.name} (${event.$id})`);
	return res.json({ event });
};
