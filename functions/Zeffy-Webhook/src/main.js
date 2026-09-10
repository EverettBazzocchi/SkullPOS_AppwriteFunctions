import { Databases } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { parseZeffyPayload } from './zeffyPayload.js';
import { isZeffySignatureValid } from './zeffySignature.js';
import { persistZeffyPayment, DATABASE_ID, FAILED_WEBHOOKS_COLLECTION_ID } from './zeffyPersist.js';

// Receives Zeffy's payment.completed webhook (relayed unmodified, raw body + Zeffy-Signature
// header, by the Cloudflare Worker in ShottyTicketing/cloudflare-worker -- see that repo's
// index.js) and writes the resulting order/ticket(s) into this shared project's `orders` and
// `tickets` collections. Auth is the Zeffy-Signature header itself (HMAC over the raw body,
// verified below), not Appwrite auth -- this function's execute permission is public ("any") so
// the relay can call it with no Appwrite session.
//
// If persistence fails (DB hiccup, unexpected payload shape), the payload is dead-lettered into
// `failed_webhooks` instead of being lost -- Admin-VerifyZeffyTickets (12h cron) retries those
// through this exact same idempotent write path (see zeffyPersist.js).
function verifySignature(req, log, error) {
	const secret = process.env.ZEFFY_WEBHOOK_SIGNING_SECRET;
	if (!secret) {
		if (log) log('ZEFFY_WEBHOOK_SIGNING_SECRET is not configured -- this webhook is currently unauthenticated.');
		return true;
	}

	const headers = req.headers || {};
	const signatureHeader = headers['zeffy-signature'] || headers['Zeffy-Signature'];

	if (!isZeffySignatureValid(req.body || '', signatureHeader, secret)) {
		if (error) error('Rejected Zeffy webhook request: missing or invalid Zeffy-Signature.');
		return false;
	}
	return true;
}

/** Best-effort record of a webhook that couldn't be persisted, so Admin-VerifyZeffyTickets can
 * replay it later instead of the payment silently vanishing. Never throws. */
async function recordFailedWebhook(databases, log, error, parsed, errorMessage) {
	try {
		await databases.createDocument(DATABASE_ID, FAILED_WEBHOOKS_COLLECTION_ID, 'unique()', {
			source: 'ZEFFY',
			eventType: parsed.eventType,
			transactionId: String(parsed.transactionId || ''),
			payload: JSON.stringify(parsed).slice(0, 4999),
			errorMessage: String(errorMessage).slice(0, 999),
			createdAt: new Date().toISOString(),
		});
		if (log) log('Recorded failed webhook to failed_webhooks for the 12h retry job.');
	} catch (err) {
		if (error) error('Failed to record failed webhook (giving up -- payload was logged above): ' + err.message);
	}
}

export default async ({ req, res, log, error }) => {
	if (!verifySignature(req, log, error)) {
		return res.json({ success: false, error: 'Unauthorized' }, 401);
	}

	let payload = {};
	try {
		payload = JSON.parse(req.body || '{}');
	} catch (err) {
		payload = {};
	}

	const parsed = parseZeffyPayload(payload);
	const transactionId = String(parsed.transactionId || '');

	log(`Processing [${parsed.eventType}] - Event: "${parsed.eventName}", Transaction: ${transactionId}`);

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	try {
		const result = await persistZeffyPayment(databases, parsed, log);
		return res.json({ success: true, transactionId, ...result });
	} catch (err) {
		error('Failed to persist Zeffy order/tickets: ' + err.message);
		// Returns 200 deliberately -- Zeffy's own webhook retry policy shouldn't be relied on for
		// recovery now that failed_webhooks + the 12h retry job exist; a 4xx/5xx here would just
		// cause Zeffy to redeliver the same payload repeatedly with no better odds of success.
		await recordFailedWebhook(databases, log, error, parsed, err.message);
		return res.json({ success: false, error: 'Failed to persist order, recorded for retry' }, 200);
	}
};
