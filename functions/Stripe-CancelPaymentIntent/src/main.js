import { Client, Users } from 'node-appwrite';

import Stripe from 'stripe';

export default async ({ req, res, log, error }) => {
    let key;
    if (req.body.test && req.body.test == 'test') {
        key = process.env.testKey;
    } else {
        key = process.env.prodKey;
    }

    if (req.body) log(req.body);
    const stripe = new Stripe(key);

    const intent = JSON.parse(req.body).intent;
    let cancelledIntent = await stripe.paymentIntents.cancel(
        JSON.parse(req.body).intent
    );

    log('Stripe payment intent cancelled successfully');
    log(intent);

    return res.json({ data: cancelledIntent });
};
