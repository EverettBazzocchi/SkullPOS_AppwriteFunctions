import crypto from 'crypto';

/**
 * Generates a fallback ticket code when a Zeffy line item has no `id` (which is otherwise used
 * directly as the ticket code, matching the QR code URL). Uses a random UUID segment rather than
 * a small random number so an accidental collision with an unrelated ticket -- which would cause
 * the webhook handler's idempotency check to mistake this for a duplicate delivery and silently
 * drop a paid ticket -- is effectively impossible.
 */
export function generateFallbackTicketCode(transactionId) {
	const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
	return `ZEFFY-${String(transactionId).slice(-8)}-${suffix}`;
}
