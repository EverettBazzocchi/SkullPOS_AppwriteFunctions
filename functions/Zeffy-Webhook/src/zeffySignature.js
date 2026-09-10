import crypto from 'crypto';

/**
 * Verifies Zeffy's webhook signature (https://www.zeffy.com/api/docs#tag/webhooks):
 * header `Zeffy-Signature: t=<unix seconds>,v1=<hex hmac>`, where v1 is the hex-encoded
 * HMAC-SHA256 of the string "{t}.{rawBody}" keyed with the whsec_... signing secret (used as a
 * literal string, not base64-decoded -- unlike e.g. Svix's whsec_ convention).
 */
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

/**
 * @param {string} rawBody - the exact raw request body bytes/string Zeffy signed -- must not be a
 *   re-serialized/re-parsed version, since that can reorder keys or change whitespace.
 * @param {string} signatureHeader - the `Zeffy-Signature` header value, e.g. "t=123,v1=abcd..."
 * @param {string} secret - the whsec_... signing secret from Zeffy's dashboard.
 * @param {number} nowSeconds - injected for testability; defaults to the current time.
 */
export function isZeffySignatureValid(rawBody, signatureHeader, secret, nowSeconds = Date.now() / 1000, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS) {
	if (!signatureHeader || !secret) return false;

	const parts = Object.fromEntries(
		String(signatureHeader)
			.split(',')
			.map((part) => part.split('='))
			.filter((pair) => pair.length === 2)
	);

	const timestamp = Number(parts.t);
	if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
		return false;
	}

	if (!parts.v1) return false;

	let received;
	try {
		received = Buffer.from(parts.v1, 'hex');
	} catch {
		return false;
	}

	const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest();
	return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
