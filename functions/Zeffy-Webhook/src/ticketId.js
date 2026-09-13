import { createHash } from 'crypto';

/**
 * Kept in sync by hand with the identical copy in
 * functions/Admin-VerifyZeffyTickets/src/ticketId.js (same convention as zeffyPersist.js).
 *
 * Derives a fallback ticket code for a Zeffy line item that has no `id` of its own (a line item's
 * `id` is otherwise used directly as the ticket code, matching the QR code URL).
 *
 * This MUST be a pure function of the payload, never random. The ticket document's id is derived
 * from this code (see zeffyPersist.js), and that derived id is the entire idempotency mechanism:
 * a redelivery of the same payload is supposed to collide on Appwrite's document-uniqueness
 * constraint and be skipped. A random code made the id different on every delivery, so the
 * conflict could never fire and each redelivery -- including every 12-hourly
 * Admin-VerifyZeffyTickets reconciliation pass -- minted a fresh duplicate ticket for the same
 * paid line item, each one counted again in that event's revenue.
 *
 * The transaction id and the line item's position within the payload are what identify the item,
 * so the code is a hash of exactly those two. Hashing the FULL transaction id (rather than
 * embedding a truncated slice of it) is what keeps two different transactions that happen to end
 * in the same characters from colliding on `${index}` and silently dropping a paid ticket; the
 * readable `ZEFFY-<last 8>` prefix is kept purely so these stay recognisable in the data.
 *
 * @param {string|number} transactionId - the Zeffy transaction the line item belongs to.
 * @param {number} index - the line item's 0-based position in the payload's `items` array.
 */
export function deriveFallbackTicketCode(transactionId, index) {
	const suffix = createHash('sha256')
		.update(`${String(transactionId)}:${index}`)
		.digest('hex')
		.slice(0, 12)
		.toUpperCase();
	return `ZEFFY-${String(transactionId).slice(-8)}-${suffix}`;
}
