import { Client, Users } from 'node-appwrite';

import Stripe from 'stripe';

export default async ({ req, res, log, error }) => {
    let key;
    console.log(req.body);
    let test = JSON.parse(req.body).test;
    if (test && test == 'test') {
        log('test key used');
        key = process.env.testKey;
    } else {
        log('production key used');
        key = process.env.prodKey;
    }

    if (req.body) log(req.body);
    const stripe = new Stripe(key);

    const amount = JSON.parse(req.body).amount;
    const intent = await stripe.paymentIntents.create({
        amount,
        currency: 'cad',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
    });

    log('Stripe payment intent created successfully');
    log(intent);

    return res.json({ intent: intent });
};
