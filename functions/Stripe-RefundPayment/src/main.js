import Stripe from 'stripe';

// Refunds a captured Stripe PaymentIntent (unlike Stripe-CancelPaymentIntent,
// which only works on an intent that hasn't been captured yet). Called from
// the POS's transactions/refund view with { intent, amount?, test }.
export default async ({ req, res, log, error }) => {
    let key;
    let body;

    try {
        body = JSON.parse(req.body || '{}');
    } catch (err) {
        error('Invalid JSON body: ' + err.message);
        return res.json({ error: 'Invalid request body' }, 400);
    }

    if (body.test && body.test === 'test') {
        log('test key used');
        key = process.env.testKey;
    } else {
        log('production key used');
        key = process.env.prodKey;
    }

    const stripe = new Stripe(key);

    const paymentIntentId = body.intent;
    if (!paymentIntentId) {
        error('Missing intent (PaymentIntent id) in request body');
        return res.json({ error: 'Missing intent' }, 400);
    }

    try {
        const refund = await stripe.refunds.create({
            payment_intent: paymentIntentId,
            ...(body.amount ? { amount: parseInt(body.amount) } : {}),
        });

        log('Stripe refund created successfully');
        log(refund.id);

        return res.json({ data: refund });
    } catch (err) {
        error('Stripe refund failed: ' + err.message);
        return res.json({ error: err.message }, 400);
    }
};
