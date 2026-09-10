import fetch from 'node-fetch';

const ZEFFY_API_BASE = 'https://api.zeffy.com/api/v1';
const PAGE_SIZE = 100;

/**
 * Fetches every succeeded payment from Zeffy's Payments API
 * (https://www.zeffy.com/api/docs#tag/payments/GET/api/v1/payments), paginating via
 * starting_after until has_more is false. This is the actual source of truth this function
 * reconciles against -- not just the locally dead-lettered failed_webhooks rows.
 */
export async function fetchAllZeffySucceededPayments(apiKey, log) {
	let all = [];
	let cursor = null;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const params = new URLSearchParams({ status: 'succeeded', limit: String(PAGE_SIZE) });
		if (cursor) params.set('starting_after', cursor);

		const response = await fetch(`${ZEFFY_API_BASE}/payments?${params.toString()}`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});

		if (!response.ok) {
			const detail = await response.text();
			throw new Error(`Zeffy API returned ${response.status}: ${detail}`);
		}

		const page = await response.json();
		const batch = page.data || [];
		all = all.concat(batch);
		if (log) log(`Fetched ${batch.length} Zeffy payment(s) (running total: ${all.length}).`);

		if (!page.has_more || batch.length === 0) break;
		cursor = page.next_cursor || batch[batch.length - 1].id;
	}

	return all;
}

/**
 * Maps one Zeffy Payments API payment object into the shape persistZeffyPayment() expects.
 * Deliberately separate from zeffyPayload.js's parseZeffyPayload() (which parses a *webhook
 * delivery*, wrapped as `{ type: "payment.completed", data: {...} }`) -- the Payments API's own
 * `type` field means payment type ("online"/"manual"/"imported"), not an event type, so reusing
 * parseZeffyPayload() directly on a raw payment object would misread that field as the event
 * type and silently skip persistence.
 */
export function parsedFromZeffyPayment(payment) {
	const buyer = payment.buyer || {};
	return {
		eventType: 'payment.completed',
		transactionId: payment.id,
		eventName: payment.description || 'Zeffy Event',
		amount: parseInt(payment.amount, 10) || 0,
		currency: (payment.currency || 'CAD').toUpperCase(),
		buyerName: `${buyer.first_name || 'Guest'} ${buyer.last_name || 'User'}`.trim(),
		email: buyer.email || 'guest@example.com',
		paymentMethodType: (payment.payment_method && payment.payment_method.type) || 'zeffy_checkout',
		items: (payment.items || []).map((item) => ({
			id: item.id,
			type: item.rate_title || item.type || 'Standard Ticket',
			amount: item.amount,
		})),
	};
}
