import Stripe from 'stripe';
import { Databases, Query } from 'node-appwrite';
import fetch from 'node-fetch';
import { createAppwriteClient } from './appwriteClient.js';

// Records one payment leg (cash amount, verified card charge, or giftcard
// redemption) against a pending transaction, appending it to the
// transaction's `payments` array -- this is what makes a split sale
// (multiple cards, cash+card, giftcard+cash, giftcard+card, etc.)
// possible: call this once per leg until payment_due reaches 0. Replaces
// the old single-method Transaction-ApplyGiftcard / Transaction-
// RecordCardPayment functions, and the cash-completion half of
// Transaction-SetStatus (which now only handles "cancelled").
//
// Every leg is validated the same way the single-method functions already
// did -- a card leg is independently verified against the real Stripe API
// (status + amount), a giftcard leg re-reads the actual current balance --
// never trusting client-supplied amounts for anything but the split itself.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const GIFTCARDS_COLLECTION_ID = 'giftcards';
const EVENTS_COLLECTION_ID = '68e400210008d19bb5c9';
const ALLOWED_METHODS = ['cash', 'stripe', 'giftcard'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Every email this system sends CCs this address and closes with the same contact line -- see
// the identical constants in Transaction-EmailReceipt/Admin-EmailDj/Admin-EmailBartender/
// Admin-EmailCoordinator (each function stays self-contained, no shared email module).
const ALWAYS_CC = 'everett.bazzocchi@skullspace.ca';
const FOOTER_HTML = '<p style="color:#999;font-size:0.8em;margin-top:24px;">Questions or concerns? Email <a href="mailto:admin@skullspace.ca">admin@skullspace.ca</a>.</p>';

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const transactionId = body.transactionId;
	const method = body.method;
	const amount = parseInt(body.amount);

	if (!transactionId || !ALLOWED_METHODS.includes(method)) {
		return res.json({ error: `method must be one of: ${ALLOWED_METHODS.join(', ')}` }, 400);
	}
	if (!Number.isFinite(amount) || amount <= 0) {
		return res.json({ error: 'amount must be a positive integer (cents)' }, 400);
	}

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	let transaction;
	try {
		transaction = await databases.getDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transactionId);
	} catch (err) {
		error('Failed to read transaction: ' + err.message);
		return res.json({ error: 'Transaction not found' }, 404);
	}

	if (transaction.status !== 'pending') {
		return res.json({ error: `Transaction is not pending (status: ${transaction.status})` }, 400);
	}

	// A self-checkout kiosk sale (or a membership-dues payment, also kiosk-
	// originated) can only ever be paid by card -- enforced here, not just
	// by the kiosk UI never offering another option, since `channel` is
	// only ever set at transaction-creation time and can't be overridden by
	// a payment-leg request itself.
	if ((transaction.channel === 'self_checkout' || transaction.channel === 'membership') && method !== 'stripe') {
		return res.json({ error: 'Self-checkout transactions can only be paid by card' }, 400);
	}

	const paymentDue = parseInt(transaction.payment_due) || 0;
	if (amount > paymentDue) {
		return res.json({ error: `Amount ${amount} exceeds remaining balance ${paymentDue}` }, 400);
	}

	const leg = { method, amount };
	let tipDelta = 0;

	if (method === 'giftcard') {
		const giftcardId = body.giftcardId;
		if (!giftcardId) return res.json({ error: 'Missing giftcardId' }, 400);

		let giftcard;
		try {
			giftcard = await databases.getDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, giftcardId);
		} catch (err) {
			error('Failed to read giftcard: ' + err.message);
			return res.json({ error: 'Giftcard not found' }, 404);
		}

		// A DJ voucher is just a giftcard row with an `events` link -- standing customer gift
		// cards never have one, so this whole block is a no-op for them. Two rules, enforced
		// here (not just client-side) since this is the only place a giftcard leg is ever
		// actually applied: a voucher only works during its own event, and never alongside a
		// discount.
		const voucherEventId = giftcard.events?.$id || giftcard.events || null;
		if (voucherEventId) {
			if (giftcard.active === false) {
				return res.json({ error: 'This voucher has been revoked' }, 400);
			}
			if ((parseInt(transaction.discount) || 0) > 0) {
				return res.json({ error: "DJ vouchers can't be combined with a discount" }, 400);
			}
			let activeEvent;
			try {
				const result = await databases.listDocuments(DATABASE_ID, EVENTS_COLLECTION_ID, [
					Query.equal('isActive', true),
					Query.limit(1),
				]);
				activeEvent = result.documents?.[0] || null;
			} catch (err) {
				error("Failed to check active event for DJ voucher: " + err.message);
				return res.json({ error: "Failed to verify this voucher's event" }, 500);
			}
			if (!activeEvent || activeEvent.$id !== voucherEventId) {
				return res.json({ error: 'This voucher is only valid during its own event' }, 400);
			}
		}

		const balance = parseInt(giftcard.balance) || 0;
		if (amount > balance) {
			return res.json({ error: `Amount ${amount} exceeds giftcard balance ${balance}` }, 400);
		}

		try {
			await databases.updateDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, giftcardId, {
				balance: balance - amount,
			});
		} catch (err) {
			error('Failed to decrement giftcard balance: ' + err.message);
			return res.json({ error: 'Failed to update giftcard balance' }, 500);
		}

		leg.giftcardId = giftcardId;
	}

	if (method === 'stripe') {
		const paymentIntentId = body.paymentIntentId;
		if (!paymentIntentId) return res.json({ error: 'Missing paymentIntentId' }, 400);

		const key = transaction.testing ? process.env.testKey : process.env.prodKey;
		const stripe = new Stripe(key);

		let paymentIntent;
		try {
			paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
		} catch (err) {
			error('Failed to retrieve PaymentIntent: ' + err.message);
			return res.json({ error: `Failed to verify payment: ${err.message}` }, 400);
		}

		if (paymentIntent.status !== 'succeeded') {
			return res.json({ error: `PaymentIntent is not succeeded (status: ${paymentIntent.status})` }, 400);
		}
		if (paymentIntent.amount !== amount) {
			error(`PaymentIntent amount ${paymentIntent.amount} does not match leg amount ${amount}`);
			return res.json({ error: 'PaymentIntent amount does not match this payment leg' }, 400);
		}

		tipDelta = parseInt(paymentIntent.amount_details?.tip?.amount || 0);
		leg.stripeId = paymentIntent.id;
		leg.tip = tipDelta;
	}

	let payments;
	try {
		payments = JSON.parse(transaction.payments || '[]');
	} catch (err) {
		payments = [];
	}
	payments.push(leg);

	const newPaymentDue = Math.max(paymentDue - amount, 0);
	const newStatus = newPaymentDue <= 0 ? 'complete' : 'pending';
	// Only one leg so far -> keep the legacy single-method label for
	// backward-compatible display; more than one -> "split". Purely
	// cosmetic (the real breakdown lives in `payments`).
	const newPaymentMethod = payments.length > 1 ? 'split' : method;

	try {
		await databases.updateDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transactionId, {
			payments: JSON.stringify(payments),
			payment_due: newPaymentDue,
			status: newStatus,
			payment_method: newPaymentMethod,
			tip: (parseInt(transaction.tip) || 0) + tipDelta,
		});
	} catch (err) {
		error('Failed to record payment leg: ' + err.message);
		return res.json({ error: 'Failed to update transaction' }, 500);
	}

	log(`Recorded ${method} leg of ${amount} on ${transactionId}: ${newPaymentDue} remaining, status ${newStatus}`);

	// A completed membership-dues payment automatically notifies finance --
	// this fires as a direct consequence of the payment completing here,
	// not a separate client-triggered call that could be skipped if the
	// kiosk loses connectivity right after the card is charged. Never
	// fatal: the payment already succeeded and must not be reported as
	// failed, or rolled back, over a notification issue.
	if (transaction.channel === 'membership' && newStatus === 'complete') {
		try {
			// Same testing-flag switch already used for the Stripe key above --
			// a testing:true transaction (self-checkout is always run this way
			// during development) notifies the test recipient, never finance's
			// real inbox.
			const financeRecipient = transaction.testing
				? process.env.FINANCE_NOTIFICATION_EMAIL_TEST
				: process.env.FINANCE_NOTIFICATION_EMAIL_PROD;
			await notifyFinanceOfMembershipPayment({
				to: financeRecipient,
				name: transaction.member_name,
				email: transaction.member_email,
				amount: transaction.total,
				date: new Date().toLocaleString('en-CA'),
			});
		} catch (err) {
			error('Failed to notify finance of membership payment (payment still recorded): ' + err.message);
		}
	}

	return res.json({ ok: true, remaining: newPaymentDue, status: newStatus });
};

async function notifyFinanceOfMembershipPayment({ to, name, email, amount, date }) {
	const amountStr = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(
		(parseInt(amount) || 0) / 100,
	);
	// CC the member on their own dues receipt (in addition to the standing everett CC) -- best
	// effort: an invalid/missing member email just means one less CC, never blocks the notice.
	const cc = [ALWAYS_CC];
	if (email && EMAIL_PATTERN.test(email)) cc.push(email);

	const response = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: 'SkullPOS <SkullPOS@mail.shotty.tech>',
			to: [to],
			cc,
			subject: `Membership dues paid: ${name || 'unknown member'}`,
			html: `<p>A membership dues payment was just completed.</p>
				<ul>
					<li><strong>Name:</strong> ${escapeHtml(name || '(not provided)')}</li>
					<li><strong>Email:</strong> ${escapeHtml(email || '(not provided)')}</li>
					<li><strong>Amount:</strong> ${amountStr}</li>
					<li><strong>Date:</strong> ${escapeHtml(date)}</li>
				</ul>
				${FOOTER_HTML}`,
		}),
	});

	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Resend API returned ${response.status}: ${detail}`);
	}
}

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
