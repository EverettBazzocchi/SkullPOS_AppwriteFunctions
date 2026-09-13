import { Query } from 'node-appwrite';

/**
 * Kept in sync by hand with the identical copy in
 * functions/Admin-VerifyZeffyTickets/src/eventLookup.js, for the same reason zeffyPersist.js is:
 * the 12h verify job replays dead-lettered payloads through the same write path, so if the two
 * copies resolved events differently a replayed ticket could end up attached to a different event
 * than the live webhook would have attached it to.
 *
 * WHY THIS EXISTS
 *
 * `tickets.eventName` is free text, and every reader re-matches it against `Events.name` on every
 * read (the rollup's ticketRevenue.js, the admin app's event detail page, the Ticketing Report's
 * event filter). Rename an event and all of them orphan its tickets at once.
 *
 * `tickets.eventId` (string 255, optional) and its `idx_event_id` key index already exist live and
 * are empty on all 204 rows. Writing it here resolves the event by name ONCE, at the moment the
 * ticket is created, and stores the answer -- so a later rename cannot break the join. The name is
 * still written unchanged alongside it, because every reader today keys off the name and nothing
 * reads the id yet.
 *
 * Be honest about what this does and does not buy: resolution is still BY NAME, it just happens
 * once instead of on every read. A ticket that arrives before its event record exists, or under a
 * name that matches nothing, still gets no id -- and Zeffy structurally cannot help, because its
 * webhook payload carries no campaign or occurrence id at all (see zeffyPayload.js).
 *
 * `Events.$id` is the id written, NOT `Events.eventId` -- the latter is Zeffy's own occurrence UUID
 * and is null for anything created in the admin app, whereas `$id` is the internal event key used
 * everywhere else (giftcards join to Events on it, and Giftcard-Lookup already returns it to the
 * POS under the name `eventId`). So `tickets.eventId` holds an Appwrite `$id` while
 * `Events.eventId` holds a Zeffy UUID. Ugly, consistent with the giftcard precedent, documented here.
 */
export const EVENTS_COLLECTION_ID = '68e400210008d19bb5c9';

/**
 * Builds a per-invocation, memoised `eventName -> Events.$id | null` resolver.
 *
 * The cache matters for Admin-VerifyZeffyTickets, which calls the write path once per Zeffy
 * payment: without it, reconciling 200 payments for one event would issue 200 identical Events
 * queries. It is deliberately per-invocation rather than module-level -- a warm container would
 * otherwise keep serving a pre-rename answer indefinitely.
 *
 * NEVER THROWS, and never returns a guess. Contract, in order of importance:
 *
 *  - Any failure at all (most likely a 403: `zeffy-webhook`'s declared scopes are `documents.write`
 *    only, so until `documents.read` is added to appwrite.config.json its dynamic key cannot read
 *    Events) resolves to null and is logged. A ticket with no eventId is exactly what gets written
 *    today; a live Zeffy ticket purchase must never fail because a convenience lookup did.
 *  - Exactly one name match -> that event's $id.
 *  - Zero matches, or two or more -> null. Two events sharing a name is the one case where a guess
 *    would silently re-attribute real ticket revenue between events, so it is refused and logged.
 */
export function createEventIdResolver(databases, databaseId, log, error) {
	const cache = new Map();

	return async function resolveEventId(eventName) {
		const name = typeof eventName === 'string' ? eventName.trim() : '';
		if (!name) return null;
		if (cache.has(name)) return cache.get(name);

		let resolved = null;
		try {
			// limit(2) is enough to tell "exactly one" from "more than one" without paging.
			const result = await databases.listDocuments(databaseId, EVENTS_COLLECTION_ID, [Query.equal('name', name), Query.limit(2)]);
			const matches = (result && result.documents) || [];

			if (matches.length === 1) {
				resolved = matches[0].$id;
				if (log) log(`Resolved event "${name}" to ${resolved}; writing it onto the ticket alongside the name.`);
			} else if (matches.length === 0) {
				if (log) log(`No event is named "${name}" -- writing the ticket with its name only (eventId left empty).`);
			} else if (error) {
				error(`More than one event is named "${name}" -- refusing to guess which one these tickets belong to; eventId left empty.`);
			}
		} catch (err) {
			if (error) error(`Could not look up event "${name}" (${err.message}) -- writing the ticket with its name only.`);
		}

		cache.set(name, resolved);
		return resolved;
	};
}
