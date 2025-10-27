import { Client, Users } from 'node-appwrite';

import Stripe from 'stripe';

export default async ({ req, res, log, error }) => {
    let key;
    if (req.body.test && req.body.test == 'test') {
        log('test key used');
        key = process.env.testKey;
    } else {
        log('production key used');
        key = process.env.prodKey;
    }

    const stripe = new Stripe(key);
    let connectionToken = await stripe.terminal.connectionTokens.create();

    if (connectionToken.error) {
        log.error(connectionToken.error);
        return res
            .status(500)
            .json({ error: 'Failed to create Stripe connection token' });
    }
    log('Stripe connection token created successfully');
    log(connectionToken);

    return res.json({ secret: connectionToken.secret });
};
