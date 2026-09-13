import Stripe from 'stripe';
import { Databases, Query } from 'node-appwrite';
import fetch from 'node-fetch';
import { createAppwriteClient } from './appwriteClient.js';
import { cartItemIds, parseCart, priceTransaction } from './pricing.js';

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
// The transaction's own `cart` is re-priced here too (see the note by the
// call to repriceTransaction): `payment_due` is written by the client, so on
// its own it is not evidence of anything.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const GIFTCARDS_COLLECTION_ID = 'giftcards';
const EVENTS_COLLECTION_ID = '68e400210008d19bb5c9';
const POS_ITEMS_COLLECTION_ID = 'pos_items';
const DISCOUNTS_COLLECTION_ID = 'discounts';
const ALLOWED_METHODS = ['cash', 'stripe', 'giftcard'];
// How many pos_items ids to resolve per listDocuments call -- a real cart is
// a handful of lines, this only exists so a pathological one still works.
const ITEM_LOOKUP_CHUNK = 50;
// Membership dues are not a pos_items cart: the kiosk rings one synthetic
// "Membership Dues" line with no $id, so the server price for that channel is
// the dues amount itself. Kept in sync by hand with MEMBERSHIP_DUES_CENTS in
// POS/src/components/selfCheckout/selfCheckout.js -- and used only as a floor
// (see the re-pricing note below), so if dues are ever raised there first, a
// payment for the new higher amount still completes normally.
const MEMBERSHIP_DUES_CENTS = 4000;
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
	// Per-leg idempotency key, generated once by the client and re-sent
	// unchanged on every retry of the SAME leg (POS/src/utils/splitPayment.js's
	// newLegId). Optional rather than required so a caller that predates it
	// still works -- it just doesn't get replay protection.
	const legId = typeof body.legId === 'string' && body.legId.length > 0 && body.legId.length <= 64 ? body.legId : null;

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

	let payments;
	try {
		payments = JSON.parse(transaction.payments || '[]');
	} catch (err) {
		payments = [];
	}
	if (!Array.isArray(payments)) payments = [];

	// Replay protection. The client retries a leg whose response never arrived
	// (an Appwrite execution that already committed its writes isn't cancelled
	// by the tablet losing the reply), so "same leg sent twice" is a normal
	// event, not an attack: recognise it and report the state that leg already
	// produced instead of appending a second one and debiting the customer
	// twice. Deliberately ahead of the pending check -- a retry of the leg that
	// finished the sale has to succeed idempotently, not come back as "this
	// transaction is not pending".
	if (legId && payments.some((recorded) => recorded && recorded.legId === legId)) {
		log(`Leg ${legId} was already recorded on ${transactionId} -- returning the existing state`);
		return res.json({
			ok: true,
			remaining: parseInt(transaction.payment_due) || 0,
			status: transaction.status,
			replay: true,
		});
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

	// Re-price the cart server-side before looking at any client-supplied
	// balance. `cart`, `total`, `discount` and `payment_due` are all written
	// by the same client that's now asking to record a payment (Transactions
	// is create("users")), so `amount <= payment_due` on its own compares a
	// client number to a client number: a $100 cart created with
	// `payment_due: 1` passes every other check in this function. `pricing.total`
	// is what this sale is worth according to `pos_items.sale_price` and the
	// `discounts` collection.
	//
	// It is used as a FLOOR on what must be paid before the transaction may
	// reach `complete`, never as a cap on a single leg -- a price edited
	// between ringing up the cart and tapping the card must not be able to
	// make this function refuse a leg Stripe has already captured.
	//
	// And that is the whole rule for what a bad re-price may do, because this
	// function runs AFTER the reader has captured: re-pricing may DETECT a
	// problem, it may never turn an already-captured payment into one that
	// cannot be written down (that is P0-1, the worst bug in the system). So:
	//
	//   * a leg carrying money that is already gone (`stripe`: the intent is
	//     verified `succeeded` below) is always recorded, with the reason
	//     stamped onto the leg itself, returned to the till as `warning`, and
	//     logged at error level. The server floor still applies, so an
	//     underpaid sale stays `pending` with the balance visible rather than
	//     silently completing;
	//   * a cart that cannot be priced at all refuses every OTHER leg here,
	//     which is BEFORE anything irreversible happens -- the giftcard is not
	//     debited until further down, and cash is still in the drawer.
	//
	// An unverifiable *discount* is not a refusal in either case: it is simply
	// not applied, which moves the price up, never down. That is flagged (it
	// leaves a real balance the till has to deal with) but it is not "this sale
	// cannot be priced".
	const pricing = await repriceTransaction(databases, transaction, error);
	let priceWarning = null;
	if (!pricing.trusted) {
		error(`Server-side re-pricing of ${transactionId} is not trustworthy: ${pricing.reason}`);
		if (!pricing.priceable && method !== 'stripe') {
			return pricing.unavailable
				? res.json({ error: 'Failed to verify this sale', reason: pricing.reason }, 500)
				: res.json({ error: 'This sale could not be priced server-side', reason: pricing.reason }, 400);
		}
		priceWarning = pricing.reason;
	}

	const alreadyPaid = payments.reduce((sum, recorded) => sum + (parseInt(recorded && recorded.amount) || 0), 0);

	const storedDue = parseInt(transaction.payment_due) || 0;
	const serverDue = Math.max(pricing.total - alreadyPaid, 0);
	const paymentDue = Math.max(storedDue, serverDue);
	if (amount > paymentDue) {
		return res.json({ error: `Amount ${amount} exceeds remaining balance ${paymentDue}` }, 400);
	}

	const leg = { method, amount };
	if (legId) leg.legId = legId;
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
		// A card-present sale can pick up a tip on the reader itself: the POS
		// charges with `config_override.update_payment_intent: true`, whose
		// whole purpose is to let the reader rewrite the intent's amount to
		// "cart total + tip" and report the tip back separately in
		// `amount_details.tip.amount`. So what has to equal this leg is the
		// captured amount MINUS that tip, not the captured amount: requiring
		// strict equality made a tipped card sale impossible to record at all
		// (claiming the tip-inclusive amount as the leg instead just fails the
		// payment_due check above, since a tip isn't payment toward the cart).
		//
		// The anti-forgery property is unchanged -- both numbers still come
		// from Stripe, so a caller still can't claim a leg larger than what
		// was actually captured for the cart, and an overpayment that is NOT a
		// declared tip is still rejected. The tip is clamped into
		// [0, captured] first so a malformed `amount_details` can't be used to
		// inflate the base.
		const capturedAmount = parseInt(paymentIntent.amount) || 0;
		const reportedTip = parseInt(paymentIntent.amount_details?.tip?.amount) || 0;
		const tip = Math.min(Math.max(reportedTip, 0), capturedAmount);
		if (capturedAmount - tip !== amount) {
			error(`PaymentIntent amount ${capturedAmount} (tip ${tip}) does not match leg amount ${amount}`);
			return res.json({ error: 'PaymentIntent amount does not match this payment leg' }, 400);
		}

		// Anti-replay: Stripe-CreatePaymentIntent stamps `metadata.transactionId`
		// at creation time -- require it to match THIS transaction, otherwise a
		// PaymentIntent that succeeded against one sale could be replayed here to
		// "pay" a second, unrelated transaction for free.
		if (!paymentIntent.metadata || paymentIntent.metadata.transactionId !== transactionId) {
			error(
				`PaymentIntent ${paymentIntent.id} metadata.transactionId (${paymentIntent.metadata?.transactionId}) does not match transaction ${transactionId}`,
			);
			return res.json({ error: 'PaymentIntent was not created for this transaction' }, 400);
		}

		// Anti-reuse, this transaction: a retry that lost its `legId` (or a
		// second call hand-made from the same PaymentIntent) would otherwise
		// sail past every check while the sale is still part-paid, appending
		// the same card charge twice. `payments` is the authoritative list --
		// `stripe_id` on the document only remembers the last of several card
		// legs.
		if (payments.some((recorded) => recorded && recorded.stripeId === paymentIntent.id)) {
			error(`PaymentIntent ${paymentIntent.id} is already recorded as a leg on ${transactionId}`);
			return res.json({ error: 'This payment has already been recorded on this transaction' }, 400);
		}

		// Anti-reuse, other transactions: even with matching metadata, confirm
		// this exact PaymentIntent hasn't already been recorded as a leg on
		// some OTHER transaction. `stripe_id` is kept in sync below whenever a
		// stripe leg is recorded, so this Query.equal lookup catches reuse
		// regardless of which transaction the id was originally recorded
		// against.
		let reuseCheck;
		try {
			reuseCheck = await databases.listDocuments(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, [
				Query.equal('stripe_id', paymentIntent.id),
			]);
		} catch (err) {
			error('Failed to check PaymentIntent reuse: ' + err.message);
			return res.json({ error: 'Failed to verify payment' }, 500);
		}
		const reusedElsewhere = (reuseCheck?.documents || []).some((doc) => doc.$id !== transactionId);
		if (reusedElsewhere) {
			error(`PaymentIntent ${paymentIntent.id} has already been recorded against a different transaction`);
			return res.json({ error: 'This payment has already been used on another transaction' }, 400);
		}

		// `leg.amount` stays tip-exclusive and the tip is carried alongside it
		// -- the convention Transactions.tip, Events.tips_earned and
		// derivePaymentLegs already assume.
		tipDelta = tip;
		leg.stripeId = paymentIntent.id;
		leg.tip = tipDelta;
	}

	// Stamped onto the leg itself (not just logged) so the flag survives in the
	// document: `payments` is what every report, receipt and refund reads, so a
	// sale recorded on a price the server could not stand behind is visible
	// wherever that sale is, not only in one function's execution log.
	if (priceWarning) leg.priceWarning = priceWarning;

	payments.push(leg);

	// The transaction is only finished once BOTH ledgers are satisfied: what
	// the document says is outstanding, and what the cart is actually worth
	// server-side. A forged `payment_due` therefore no longer buys a
	// `complete` sale -- the remainder stays visible as payment_due.
	const newPaymentDue = Math.max(Math.max(storedDue - amount, 0), Math.max(pricing.total - alreadyPaid - amount, 0));
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
			// Kept in sync (not just appended into `payments`) so the reuse-guard
			// Query.equal lookup above can find this leg from a future request.
			...(method === 'stripe' ? { stripe_id: leg.stripeId } : {}),
			// Same idea for the giftcard total: `giftcard_amount` is the field
			// every report's legacy derivation buckets gift-card revenue from,
			// and nothing had been writing it since this function replaced
			// Transaction-ApplyGiftcard -- which is how gift-card redemptions
			// end up reported (and refunded) as cash. Rows written from here
			// carry `payments`, so their legs are read from that directly, but
			// leaving the column silently wrong for new rows is what created
			// the problem in the first place.
			...(method === 'giftcard'
				? { giftcard_amount: (parseInt(transaction.giftcard_amount) || 0) + amount }
				: {}),
		});
	} catch (err) {
		error('Failed to record payment leg: ' + err.message);
		// The giftcard was debited ~100 lines above and that write has already
		// committed on its own -- Appwrite gives no multi-document transaction
		// here. Nothing downstream can put it back either: Transaction-SetStatus
		// and Admin-CancelStaleTransactions both reverse from `payments`, which
		// this leg never reached. So credit it back here, and if even that
		// fails, say so in terms someone can act on rather than returning a bare
		// "Failed to update transaction" over a customer's missing money (P0-13).
		if (method === 'giftcard') {
			try {
				const current = await databases.getDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, leg.giftcardId);
				await databases.updateDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, leg.giftcardId, {
					balance: (parseInt(current.balance) || 0) + amount,
				});
				log(`Credited ${amount} back to giftcard ${leg.giftcardId} after the leg write failed`);
				return res.json({ error: 'Failed to update transaction', giftcardRestored: true }, 500);
			} catch (creditErr) {
				error(
					`ORPHANED GIFTCARD DEBIT -- giftcard ${leg.giftcardId} was debited ${amount} for transaction ${transactionId}, the leg could not be recorded, and the credit-back also failed (${creditErr.message}). This balance must be restored by hand.`,
				);
				return res.json(
					{
						error: 'Failed to update transaction',
						giftcardRestored: false,
						manualCredit: { giftcardId: leg.giftcardId, amount },
					},
					500,
				);
			}
		}
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

	// `warning` is the till-facing half of the flag: the payment IS recorded
	// (ok: true), but staff are told the sale could not be verified against the
	// catalogue, and `remaining` shows exactly what the server still thinks is
	// outstanding -- never a silent rejection of money that was taken.
	return res.json({
		ok: true,
		remaining: newPaymentDue,
		status: newStatus,
		...(priceWarning
			? { warning: `Recorded, but this sale could not be fully verified server-side: ${priceWarning}` }
			: {}),
	});
};

// Resolves what this transaction is actually worth, server-side. Never throws:
// a pos_items/discounts collection this function cannot read is reported as an
// untrusted price (`unavailable: true`) rather than as an exception, because
// the caller's only two options at that point are "refuse" and "record and
// flag", and which of those is safe depends on whether money has already
// changed hands -- not on whether Appwrite happened to answer. A failed read
// still never prices the cart at zero: `total` is 0 and `trusted` is false, so
// the client's own stored balance becomes the floor and the sale is flagged.
async function repriceTransaction(databases, transaction, error) {
	if (transaction.channel === 'membership') {
		return {
			ok: true,
			trusted: true,
			reason: null,
			subtotal: MEMBERSHIP_DUES_CENTS,
			discount: 0,
			discountVerified: true,
			total: MEMBERSHIP_DUES_CENTS,
		};
	}

	const cart = parseCart(transaction.cart);
	if (!cart) {
		return { ok: false, trusted: false, reason: 'cart is missing or unreadable', subtotal: 0, discount: 0, discountVerified: false, total: 0 };
	}

	const salePriceById = {};
	const ids = cartItemIds(cart);
	let discountOptions = [];
	try {
		for (let i = 0; i < ids.length; i += ITEM_LOOKUP_CHUNK) {
			const chunk = ids.slice(i, i + ITEM_LOOKUP_CHUNK);
			const result = await databases.listDocuments(DATABASE_ID, POS_ITEMS_COLLECTION_ID, [
				Query.equal('$id', chunk),
				Query.limit(chunk.length),
			]);
			(result?.documents || []).forEach((item) => {
				const salePrice = parseInt(item.sale_price);
				if (Number.isFinite(salePrice)) salePriceById[item.$id] = salePrice;
			});
		}

		// Only two discounts exist and they're only needed when the transaction
		// claims one, so this read is skipped on the overwhelming majority of
		// sales.
		if ((parseInt(transaction.discount) || 0) > 0) {
			const result = await databases.listDocuments(DATABASE_ID, DISCOUNTS_COLLECTION_ID, [Query.limit(100)]);
			discountOptions = result?.documents || [];
		}
	} catch (err) {
		error('Failed to re-price cart: ' + err.message);
		return {
			ok: false,
			trusted: false,
			unavailable: true,
			reason: 'the item/discount catalogue could not be read: ' + err.message,
			subtotal: 0,
			discount: 0,
			discountVerified: false,
			total: 0,
		};
	}

	return priceTransaction({ cart, discount: transaction.discount }, { salePriceById, discountOptions });
}

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
