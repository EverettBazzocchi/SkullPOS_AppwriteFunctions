import Stripe from 'stripe';
import { installDnsPatch } from './dnsPatch.js';

// This deployment's sandbox cannot resolve its own domain through getaddrinfo (EAI_AGAIN after
// ~5s), which is the path Stripe's SDK and node-appwrite both use underneath. This function had NO
// resolver workaround at all -- it is why a card sale could log its key selection and then hang for
// the whole timeout without another line. Installed synchronously at import; it never blocks.
installDnsPatch();

// Cancels the PaymentIntent behind an aborted card sale, so the amount stops
// sitting on the reader's screen. Called by POS/src/utils/stripe.js's
// handleCancelStripePayment when the cashier backs out of a charge.
//
// The live/test decision. Stripe-CreatePaymentIntent carries this function
// character-for-character, and its test file carries the identical table of
// cases -- change one, change both.
//
// NOT YET ADOPTED by stripe-getConnectionToken or Stripe-RefundPayment, which
// still carry their own older spellings. The refund one is the urgent copy: it
// resolves a mode-less body to TEST where this resolves it to LIVE, so a refund
// that omits the flag asks the test account to refund a live PaymentIntent.
//
// Three accepted spellings of the same question, one answer:
//   SkullPOS:        { test: "test" } -> test,  { test: "" } -> live
//   ShottyTicketing: { isLive: true | false }
//   either:          { environment: "live" | "test" }
//
// Everything else is an ERROR rather than a default (P2-19). These functions had
// drifted into four near-copies of this logic that resolved the SAME body in
// opposite directions, and the failure mode is the worst kind there is: the
// wrong Stripe ACCOUNT moves the money. `isLive: "true"` (a string, e.g.
// straight out of a query string or a form) and `environment: "production"` both
// used to fall silently through to TEST while the caller plainly meant live, and
// vice versa. Contradictions between two spellings in one body used to be
// resolved by which `if` came first.
//
// Returns { isLive, source } or { error }.
function resolveStripeMode(body) {
	const signals = [];
	if ('isLive' in body) {
		if (typeof body.isLive !== 'boolean') {
			return { error: `isLive must be true or false, not ${JSON.stringify(body.isLive)}` };
		}
		signals.push({ source: 'isLive', isLive: body.isLive });
	}
	if ('environment' in body) {
		if (body.environment !== 'live' && body.environment !== 'test') {
			return { error: `environment must be "live" or "test", not ${JSON.stringify(body.environment)}` };
		}
		signals.push({ source: 'environment', isLive: body.environment === 'live' });
	}
	if ('test' in body) {
		if (typeof body.test !== 'string') {
			return { error: `test must be "test" (test mode) or "" (live mode), not ${JSON.stringify(body.test)}` };
		}
		// "test" means test mode; anything else (POS sends "") means live.
		signals.push({ source: 'test', isLive: body.test !== 'test' });
	}
	// No signal at all is reported as such -- `isLive: null` -- rather than being
	// answered with a default, because the right answer differs by operation and
	// belongs at the call site: see the note where this is called.
	if (signals.length === 0) {
		return { isLive: null, source: null };
	}
	if (signals.some((signal) => signal.isLive !== signals[0].isLive)) {
		return {
			error: `Contradictory Stripe mode: ${signals.map((s) => `${s.source} says ${s.isLive ? 'live' : 'test'}`).join(', ')}`,
		};
	}
	return { isLive: signals[0].isLive, source: signals.map((signal) => signal.source).join('+') };
}

// ShottyTicketing generates synthetic `pi_tkt_...` ids for card_present
// placeholder/offline cases -- they look like PaymentIntent ids but were never
// created against the Stripe API, so cancelling one is only ever a confusing
// Stripe error. Same rule as Stripe-RefundPayment applies.
function isCancelablePaymentIntentId(intentId) {
	return typeof intentId === 'string' && intentId.startsWith('pi_') && !intentId.startsWith('pi_tkt_');
}

export default async ({ req, res, log, error }) => {
	// Defense-in-depth: this function's execute scope is restricted to the
	// admin/POS/PIN teams, but a project API key with `execution.write` scope
	// can invoke a function directly with no Appwrite user session at all,
	// bypassing that allowlist entirely. Appwrite sets this header itself for a
	// session-authenticated call -- it can't be spoofed by the request body.
	if (!req.headers['x-appwrite-user-id']) {
		error('Refused cancel attempt with no caller identity (missing x-appwrite-user-id).');
		return res.json({ error: 'Unauthorized' }, 403);
	}

	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		error('Invalid JSON body: ' + err.message);
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const intentId = body.intent;
	if (!isCancelablePaymentIntentId(intentId)) {
		const msg = `Not a cancelable Stripe payment intent id (got "${intentId}")`;
		error(msg);
		return res.json({ error: msg }, 400);
	}

	// A MALFORMED mode is refused (a typo'd `environment: "production"` must not
	// quietly become "test"), but an ABSENT one still defaults to live here rather
	// than 400ing, unlike Stripe-CreatePaymentIntent. The asymmetry is deliberate
	// and it is not a re-run of the drift this converged: Create refuses an unnamed
	// mode, so no intent can exist whose account was ever guessed -- there is
	// nothing left here to guess ABOUT. And on this path refusing is the strictly
	// worse failure, the same argument the ownership check below makes: the
	// alternative to cancelling an uncaptured intent is leaving it live on the
	// reader with the cashier unable to back out. So default, and say so loudly.
	const resolved = resolveStripeMode(body);
	if (resolved.error) {
		error(`Refusing to cancel a payment intent: ${resolved.error}`);
		return res.json({ error: resolved.error }, 400);
	}
	const isLive = resolved.isLive === null ? true : resolved.isLive;
	const mode = isLive ? 'live' : 'test';
	if (resolved.source) {
		log(`${mode} key used (from ${resolved.source})`);
	} else {
		error(`Cancel request for ${intentId} named no Stripe mode -- defaulting to LIVE. The caller should send test/isLive/environment.`);
	}
	const key = isLive ? process.env.prodKey : process.env.testKey;
	if (!key) {
		error(`No Stripe key configured for ${mode} mode (${isLive ? 'prodKey' : 'testKey'} is unset).`);
		return res.json({ error: `Stripe ${mode} key is not configured` }, 500);
	}

	const stripe = new Stripe(key);

	// Read the intent before touching it. Three things come out of this one
	// call that the old one-liner had no way to know: whether the caller owns
	// this intent at all, whether it is already cancelled (so a double-tap
	// isn't a 500), and whether the money has already been captured (in which
	// case this is a refund, not a cancel, and cancelling would silently do
	// nothing for the customer).
	let intent;
	try {
		intent = await stripe.paymentIntents.retrieve(intentId);
	} catch (err) {
		error(`Failed to retrieve payment intent ${intentId} in ${mode} mode: ` + err.message);
		return res.json({ error: `No ${mode}-mode payment intent found for ${intentId}` }, 404);
	}

	// Ownership. Stripe-CreatePaymentIntent stamps `metadata.transactionId` when
	// the caller passes one, which makes the intent itself the authoritative
	// record of which sale it belongs to -- better than the transaction's
	// `stripe_id`, which isn't written until the payment is *recorded*, i.e.
	// never on the abort path this function serves. So: whenever an intent
	// carries that stamp AND the caller names a transaction, the two must agree,
	// which stops one till cancelling another till's in-flight sale.
	//
	// A caller that names NOTHING is allowed through on caller identity alone.
	// That is deliberate and it is the deploy-ordering seam: CreatePaymentIntent
	// now stamps every intent, but a POS build that predates this release sends
	// only `{test, intent}` on the abort path. Refusing those would 403 every
	// cancel from the currently-deployed till -- no money captured, but the
	// amount stranded on the reader and the cashier unable to back out. Refusing
	// is also the strictly worse failure: the alternative to cancelling an
	// uncaptured intent is leaving it live. So enforce a genuine MISMATCH only,
	// and log the unnamed case so the gap is visible until every client names it.
	const stampedTransactionId = intent.metadata && intent.metadata.transactionId;
	if (stampedTransactionId && body.transactionId && body.transactionId !== stampedTransactionId) {
		error(`Caller asked to cancel ${intentId}, which belongs to transaction ${stampedTransactionId}, as "${body.transactionId}".`);
		return res.json({ error: 'This payment intent belongs to a different transaction' }, 403);
	}
	if (stampedTransactionId && !body.transactionId) {
		log(`Payment intent ${intentId} is stamped for transaction ${stampedTransactionId} but the caller named none -- cancelling on caller identity alone (client predates transactionId on the cancel path).`);
	} else if (!stampedTransactionId) {
		log(`Payment intent ${intentId} carries no transactionId metadata -- cancelling on caller identity alone.`);
	}

	// Idempotent: the cashier tapping cancel twice, or a retry after a timeout,
	// should not surface as an error the second time round.
	if (intent.status === 'canceled') {
		log(`Payment intent ${intentId} was already cancelled`);
		return res.json({ data: intent, alreadyCancelled: true });
	}

	if (intent.status === 'succeeded') {
		const msg = `Payment intent ${intentId} has already been captured -- refund it instead of cancelling`;
		error(msg);
		return res.json({ error: msg }, 400);
	}

	let cancelledIntent;
	try {
		cancelledIntent = await stripe.paymentIntents.cancel(intentId);
	} catch (err) {
		error('Error cancelling Stripe Payment Intent: ' + err.message);
		return res.json({ error: err.message }, 500);
	}

	log('Stripe payment intent cancelled successfully');
	log(intentId);

	return res.json({ data: cancelledIntent });
};
