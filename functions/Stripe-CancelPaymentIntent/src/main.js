import { Client, Users } from 'node-appwrite';

import Stripe from 'stripe';

export default async ({ req, res, log, error }) => {
    let key;
    log(req.body);
    let test = JSON.parse(req.body).test;
    if (test && test == 'test') {
        log('test key used');
        key = process.env.testKey;
    } else {
        log('production key used');
        key = process.env.prodKey;
    }

    const stripe = new Stripe(key);

    const intent = JSON.parse(req.body).intent;
    let cancelledIntent = await stripe.paymentIntents.cancel(
        JSON.parse(req.body).intent
    );

    log('Stripe payment intent cancelled successfully');
    log(intent);

    return res.json({ data: cancelledIntent });
};
