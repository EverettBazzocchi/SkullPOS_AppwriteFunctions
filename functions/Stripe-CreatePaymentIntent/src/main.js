import { Client, Users } from 'node-appwrite';

import Stripe from 'stripe';
import { installDnsPatch } from './dnsPatch.js';

// This deployment's sandbox cannot resolve its own domain through getaddrinfo (EAI_AGAIN after
// ~5s), which is the path Stripe's SDK and node-appwrite both use underneath. This function had NO
// resolver workaround at all -- it is why a card sale could log its key selection and then hang for
// the whole timeout without another line. Installed synchronously at import; it never blocks.
installDnsPatch();

// Shared by SkullPOS and ShottyTicketing (same Stripe account) -- both apps' payment-intent
// needs are the same Stripe call, so this is the one place that logic lives instead of two
// near-duplicate functions. The two clients use different request/response shapes: SkullPOS
// sends `{ test: "test"|"", amount }` and expects the raw Stripe PaymentIntent nested under
// `intent` (kept exactly as before -- POS/src/utils/stripe.js's getChargeID() reads
// `data.intent.id`/`data.intent.client_secret`); ShottyTicketing sends
// `{ amount, currency, isLive }` (or `environment`) and expects a flat
// `{ clientSecret, amount, currency, mode }` response. Detected by whether the body carries
// any of Ticketing's own fields (`isLive`/`environment`/`currency`), none of which SkullPOS's
// caller ever sends.
function isTicketingShape(body) {
    return 'isLive' in body || 'environment' in body || 'currency' in body;
}

// The live/test decision. Stripe-CancelPaymentIntent carries this function
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

const DEFAULT_DOOR_PRICE_CENTS = 3000;

export default async ({ req, res, log, error }) => {
    let body;
    try {
        body = JSON.parse(req.body || '{}');
    } catch (err) {
        error('Invalid JSON body: ' + err.message);
        return res.json({ error: 'Invalid request body' }, 400);
    }

    // Refusing an unnamed mode costs nothing HERE and nowhere else: no intent
    // exists yet, so nothing can have been captured against the wrong account,
    // and this is the only place in the family that mints money-moving state.
    // Every real caller already names it -- POS/src/utils/stripe.js always sends
    // `test`, ShottyTicketing's stripeService.ts always sends `isLive` -- so this
    // rejects nothing that works today, while making "which Stripe account is
    // this?" a question no function downstream has to guess the answer to.
    const mode = resolveStripeMode(body);
    if (mode.error || mode.isLive === null) {
        const reason =
            mode.error || 'No Stripe mode given: send isLive (boolean), environment ("live"/"test") or test ("test"/"")';
        error(`Refusing to create a PaymentIntent: ${reason}`);
        return res.json({ error: reason }, 400);
    }
    const isLive = mode.isLive;
    log(`${isLive ? 'production' : 'test'} key used (from ${mode.source})`);
    const key = isLive ? process.env.prodKey : process.env.testKey;
    if (!key) {
        const msg = `Stripe ${isLive ? 'live' : 'test'} key is not configured`;
        error(`${msg} (${isLive ? 'prodKey' : 'testKey'} is unset).`);
        return res.json({ error: msg }, 500);
    }
    const stripe = new Stripe(key);

    if (isTicketingShape(body)) {
        const amount = body.amount || DEFAULT_DOOR_PRICE_CENTS;
        const currency = (body.currency || 'cad').toLowerCase();
        try {
            const paymentIntent = await stripe.paymentIntents.create({
                amount,
                currency,
                payment_method_types: ['card_present', 'interac_present'],
                capture_method: 'automatic',
            });
            log(`Stripe payment intent created for ${amount} ${currency}`);
            return res.json({ clientSecret: paymentIntent.client_secret, amount, currency, mode: isLive ? 'live' : 'test' });
        } catch (err) {
            error('Error creating Stripe Payment Intent: ' + err.message);
            return res.json({ error: err.message }, 500);
        }
    }

    // REQUIRED, not optional, on the SkullPOS path. Transaction-RecordPayment hard-rejects any
    // stripe leg whose intent does not carry `metadata.transactionId` matching the sale, and this
    // intent is created with capture_method: 'automatic' -- so an intent minted without the stamp
    // can still be tapped, captures immediately, and can then never be recorded against the sale.
    // That was P0-1: money taken, sale unrecordable, every card sale, because the stamp was
    // applied only "if asked" while the reader was never asked. Refusing here costs nothing (no
    // intent exists yet, so nothing can have been captured) and it is the only way the two halves
    // cannot drift apart again.
    //
    // Only the SkullPOS shape is bound this way. ShottyTicketing's door sales (handled above) have
    // no Transactions row to point at.
    if (!body.transactionId || typeof body.transactionId !== 'string') {
        error('Refusing to create a PaymentIntent with no transactionId: it could be charged but never recorded.');
        return res.json({ error: 'transactionId is required to create a payment intent' }, 400);
    }

    try {
        const intent = await stripe.paymentIntents.create({
            amount: body.amount,
            currency: 'cad',
            payment_method_types: ['card_present', 'interac_present'],
            capture_method: 'automatic',
            // Stamped so Transaction-RecordPayment's stripe leg can verify this
            // PaymentIntent was actually created for THIS transaction before
            // accepting it as payment -- otherwise a PaymentIntent that succeeded
            // against one sale could be replayed to "pay" a second, unrelated one.
            metadata: { transactionId: body.transactionId },
        });

        log('Stripe payment intent created successfully');
        log(intent);

        return res.json({ intent: intent });
    } catch (err) {
        error('Error creating Stripe Payment Intent: ' + err.message);
        return res.json({ error: err.message }, 500);
    }
};
