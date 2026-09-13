import { Client, Users } from 'node-appwrite';

import Stripe from 'stripe';

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

function resolveIsLive(body) {
    if ('isLive' in body || 'environment' in body) {
        return body.isLive === true || body.environment === 'live';
    }
    return !(body.test && body.test === 'test');
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

    const isLive = resolveIsLive(body);
    log(isLive ? 'production key used' : 'test key used');
    const key = isLive ? process.env.prodKey : process.env.testKey;
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
