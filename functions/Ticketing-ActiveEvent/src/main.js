import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Returns the currently-active event, reduced to the handful of fields a front-of-house client
// legitimately needs: the door needs name/price/currency/date/location to sell a ticket, and the
// register and menu boards need the alcohol gate (sellsAlcohol + the bar window -- the
// barOpensAt/barClosesAt instants, with the legacy barOpenTime/barCloseTime strings still carried
// alongside them) to decide whether the alcohol categories may be displayed and rung up.
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

// More than one event carrying `isActive` is operator error, not a supported state -- nothing in
// the schema or the admin app prevents it (Events.isActive is a plain optional boolean, and the
// admin app writes the collection directly). It therefore has to be handled here, because this is
// the single choke point every floor surface reads through: POS, the menu boards and the door app.
//
// Two things were wrong with the previous `Query.equal('isActive', true) + Query.limit(1)`:
//
//  1. It had NO order clause, so which of several active events won was whatever the database
//     happened to return first -- and that is not arbitrary in practice, it is the OLDEST row.
//     Verified read-only against this live instance (Appwrite 1.9.0) rather than assumed: an
//     unordered `limit(3)` over the 95 tickets named "Everetts Test event ignopre" returns
//     sequences 1, 16, 17 -- byte-identical to the same query with `orderAsc('$createdAt')`, and
//     the exact reverse of `orderDesc('$updatedAt')`, which returns sequence 219 (a row created
//     2026-09-12T18:40 and updated at 18:46) first. So the default order follows creation and is
//     completely insensitive to updates: ticking Active on a NEW event does not promote it, and
//     the stale event somebody forgot to untick keeps winning. That is the opposite of what the
//     operator just did, which is why the floor "silently follows the wrong event".
//
//     `orderDesc('$updatedAt')` inverts that into the only defensible rule available here: the
//     most recently touched active event wins, i.e. the one the operator just saved. It needs no
//     index in Appwrite and cannot fail closed.
//
//  2. It fetched exactly one row, so this function could not even SEE that the situation existed,
//     let alone report it. Pulling a handful lets it say so in the execution log and in its own
//     response, and lets it step past an event left active with `testing: true` instead of
//     serving a test event to the live floor as the door's price source and the bar's alcohol gate.
//
// Five is a deliberate over-fetch of a collection that holds three rows: the `total` the API
// returns alongside them is the true count, so the log is accurate even in the (absurd) case that
// more than five are active at once -- only the test-event step-past is limited to these five.
//
// DO NOT "TIDY UP" THE ORDER CLAUSE OR THE TEST-EVENT STEP-PAST. Another function's safety is
// coupled to both of them. Admin-SetActiveEvent maintains `isActive` on a schedule and writes its
// changeover as ACTIVATE-FIRST, DEACTIVATE-SECOND, deliberately, so that the transient between its
// two writes is "two rows active" rather than "zero rows active" -- zero active mid-event hides
// every alcohol item on the register and both boards and drops the door to the CA$30 default. That
// transient is only harmless because the row it just wrote is the most recently updated one, so
// `orderDesc('$updatedAt')` here serves it; and because pickActiveEvent below independently steps
// past `testing === true`. Remove either and a crash between those two writes -- or the sub-second
// gap between them -- starts serving the OLD event. The coupling is written out from the other side
// in functions/Admin-SetActiveEvent/src/main.js and its README.
const ACTIVE_EVENT_FETCH_LIMIT = 5;

// Prefers the first non-test active event, but FALLS BACK to serving a test event rather than
// returning null. That fallback is load-bearing: returning null closes the alcohol gate on the
// register and both menu boards and drops the door back to its CA$30 default price, so "every
// active event is flagged testing" must stay no worse than today's behaviour (which serves the
// test event) instead of becoming a dark floor. `testing` is also only checked for an explicit
// `true` -- it was added 2026-09-12 and is absent entirely on two of the three live rows, so
// anything stricter (or a server-side `Query.notEqual('testing', true)`, which drops NULLs in SQL)
// would discard real events.
function pickActiveEvent(documents) {
	return documents.find((doc) => doc.testing !== true) || documents[0];
}

// Deliberately an allowlist, not a denylist: a new financial column added to Events later must
// not start leaking just because nobody remembered to exclude it here. Everything added below is a
// time or a label; not one financial column is projected, and the test suite pins the key set
// closed so growing this list stays a deliberate edit.
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
		// STILL PROJECTED ON PURPOSE, even though `barOpenTime`/`barCloseTime` are being retired
		// from the Events schema and every server-side reader has already stopped using them. The
		// register and both menu boards still read them as their fallback, and each of those ships
		// on its own cycle: a build sitting on the bar, or on a board facing the room, does not
		// update because this function was redeployed. Dropping a key here is instant and reaches
		// every client at once, so it must come LAST -- after each one has shipped its own removal
		// AND is confirmed running on the device. An extra projected field costs nothing; a missing
		// one closes the alcohol gate on an open floor. `?? null` needs no change when the
		// attributes are deleted either -- a missing attribute simply reads as undefined.
		barOpenTime: doc.barOpenTime ?? null,
		barCloseTime: doc.barCloseTime ?? null,
		// The same four instants every server-side reader now prefers, projected through to the
		// floor so the register and the menu boards can gate on a real timestamp instead of
		// recombining `date`'s calendar day with an "HH:mm" string -- the recombination that lets
		// the menu board (which accepts a bare "1800") and the register (which does not) disagree
		// about the very same event. They are projected ALONGSIDE the legacy strings, never instead
		// of them: a client that has not migrated yet, and a row that has not been backfilled yet,
		// both keep working, in any deploy order.
		//
		// Normalized to an ISO instant or null -- never an empty string or an unparseable value --
		// because every client fails the gate closed on null, and that is the safe direction.
		startsAt: normalizeInstant(doc.startsAt),
		endsAt: normalizeInstant(doc.endsAt),
		barOpensAt: normalizeInstant(doc.barOpensAt),
		barClosesAt: normalizeInstant(doc.barClosesAt),
	};
}

// Appwrite hands a datetime attribute back as an ISO string; a Date is accepted too. Anything
// absent, blank or unparseable becomes null rather than riding through as junk a client would have
// to defend against on its own.
function normalizeInstant(value) {
	if (value === null || value === undefined || value === '') return null;
	const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
	return Number.isNaN(ms) ? null : new Date(ms).toISOString();
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
	let activeCount;
	try {
		const result = await databases.listDocuments(DATABASE_ID, EVENTS_COLLECTION_ID, [
			Query.equal('isActive', true),
			Query.orderDesc('$updatedAt'),
			Query.limit(ACTIVE_EVENT_FETCH_LIMIT),
		]);
		documents = result.documents || [];
		// `total` is the count of ALL matching rows, not just the page -- so the warning below is
		// honest even past the fetch limit. Falls back to the page length if it is ever absent.
		activeCount = Number.isFinite(result.total) ? result.total : documents.length;
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

	const chosen = pickActiveEvent(documents);
	const event = toPublicEvent(chosen);

	// Reported on BOTH channels on purpose. `error()` puts it in the function's Errors view, which
	// is where somebody looks after the floor behaves oddly; `multipleActive`/`activeCount` put it
	// in the response, so the admin app (or a curl) can surface it without console access. The
	// response stays a 200 with a usable event either way -- this is a warning about the data, not
	// a failure of the request.
	if (activeCount > 1) {
		// Says which rule actually picked this row -- "most recently updated" is a lie when a test
		// event was skipped over, and a wrong explanation here sends whoever reads it to the wrong row.
		const why = chosen === documents[0] ? 'the most recently updated' : 'the most recently updated non-test event';
		error(
			`${activeCount} events are marked active at once. Serving "${event.name}" (${event.$id}), ${why}. ` +
				'Untick "Active event" on the others -- the floor follows exactly one.',
		);
	}
	if (chosen.testing === true) {
		error(
			`The active event "${event.name}" (${event.$id}) is flagged as a TEST event and is being served to the live floor ` +
				'(no non-test event is active). Door prices and the alcohol gate are coming from a test record.',
		);
	}

	log(`Active event: ${event.name} (${event.$id})`);
	// Deliberately left as exactly `{ event: null }` above rather than carrying these two keys
	// through the no-active branch: that response shape is what every client already fails closed
	// on, and there is nothing to warn about when nothing is active.
	return res.json({ event, multipleActive: activeCount > 1, activeCount });
};
