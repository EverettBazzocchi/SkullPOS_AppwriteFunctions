import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Returns the currently-active event, reduced to the handful of fields a front-of-house client
// legitimately needs: the door needs name/price/currency/date/location to sell a ticket, and the
// register and menu boards need the alcohol gate (sellsAlcohol + the barOpenTime/barCloseTime
// window) to decide whether the alcohol categories may be displayed and rung up.
//
// Why this exists at all rather than the client querying `Events` directly: every one of those
// surfaces authenticates as an anonymous or shared session that belongs to no team, while the
// Events collection is read-restricted to the admin team -- so the client's own read 401s. The
// door app then silently falls back to a generic "Standard Entry Pass" label; the register and
// the menu board silently treat the alcohol gate as closed and drop every alcohol item. The
// obvious shortcut (granting those sessions read on Events) would hand a device sitting on the
// bar -- or a menu board facing the room -- full read access to every event's sales rollup:
// revenue, profit, cogs, tips, cash/card splits. Appwrite permissions are per-collection, never
// per-field. This function is the field filter Appwrite itself can't express: it reads as the
// server, returns only what the floor needs, and never lets the financial columns off the box.
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
		standardTicketPrice: normalizeTicketPrice(doc.standardTicketPrice),
		currency: doc.currency || DEFAULT_CURRENCY,
		isActive: doc.isActive === true,
		// The alcohol gate. `sellsAlcohol` mirrors the column's own `false` default, and the two
		// window strings stay raw "HH:mm" -- the clients already own the parsing (POS's
		// isWithinBarHours) and all fail closed on null, so an unset window hides alcohol rather
		// than opening the bar. None of these three carry any financial meaning.
		sellsAlcohol: doc.sellsAlcohol === true,
		barOpenTime: doc.barOpenTime ?? null,
		barCloseTime: doc.barCloseTime ?? null,
	};
}

// `|| DEFAULT` would rewrite a legitimately free (0-cent) event into a CA$30 charge, so the
// fallback has to fire on "no usable number" only, not on falsiness.
function normalizeTicketPrice(value) {
	const price = parseInt(value, 10);
	return Number.isFinite(price) ? price : DEFAULT_TICKET_PRICE_CENTS;
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
