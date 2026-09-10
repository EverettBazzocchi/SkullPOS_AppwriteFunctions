/**
 * Kept in sync by hand with the identical copy in
 * functions/Admin-VerifyZeffyTickets/src/zeffyPayload.js -- both functions need to parse a
 * dead-lettered payload (or a live webhook body) into the exact same shape, but Appwrite
 * functions are deployed independently, so there's no shared package between them.
 *
 * Normalizes a Zeffy webhook payload into the fields the rest of the handler needs, tolerating
 * the couple of shape variations Zeffy is known to send (top-level vs nested under `data`,
 * snake_case vs camelCase buyer fields).
 */
export function parseZeffyPayload(payload) {
	if (!payload || typeof payload !== 'object') {
		payload = {};
	}

	const eventType = payload.type || payload.eventType || payload.event || 'payment.completed';
	const dataObj = payload.data || payload;

	const transactionId = dataObj.id || payload.id || null;
	const eventName = dataObj.description || dataObj.campaignName || payload.description || payload.campaignName || 'Zeffy Event';
	const amount = parseInt(dataObj.amount || payload.amount || 0, 10);
	const currency = (dataObj.currency || payload.currency || 'CAD').toUpperCase();

	const buyerObj = dataObj.buyer || payload.buyer || {};
	const firstName = buyerObj.first_name || buyerObj.firstName || dataObj.first_name || 'Guest';
	const lastName = buyerObj.last_name || buyerObj.lastName || dataObj.last_name || 'User';
	const email = buyerObj.email || dataObj.email || 'guest@example.com';
	const buyerName = `${firstName} ${lastName}`.trim();

	const paymentMethodType = (dataObj.payment_method && dataObj.payment_method.type) || 'zeffy_checkout';
	const items = dataObj.items || payload.items || [{ name: 'Standard Ticket', amount }];

	return { eventType, transactionId, eventName, amount, currency, buyerName, email, paymentMethodType, items };
}
