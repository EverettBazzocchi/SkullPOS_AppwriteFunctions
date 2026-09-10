import Stripe from 'stripe';

// Shared by SkullPOS and ShottyTicketing (same Stripe account) -- both
// apps' Stripe Terminal connection-token needs are identical, so this is
// the one place that logic lives instead of two near-duplicate functions.
// The two clients use different request shapes for the same test/live
// choice: SkullPOS sends `{ test: "test" }` (or omits the field for
// prod), ShottyTicketing sends `{ isLive: true|false }` or
// `{ environment: "live" }`. Normalize both to one boolean rather than
// requiring either client to change its call shape.
function resolveIsLive(body) {
	if ('isLive' in body || 'environment' in body) {
		return body.isLive === true || body.environment === 'live';
	}
	return !(body.test && body.test === 'test');
}

export default async ({ req, res, log, error }) => {
	let body = {};
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		// Both callers sometimes send an empty body for the prod/live
		// default -- an empty/unparseable body isn't an error here.
	}

	const isLive = resolveIsLive(body);
	log(isLive ? 'production key used' : 'test key used');
	const key = isLive ? process.env.prodKey : process.env.testKey;

	const stripe = new Stripe(key);
	let connectionToken;
	try {
		connectionToken = await stripe.terminal.connectionTokens.create();
	} catch (err) {
		error('Error creating Stripe connection token: ' + err.message);
		return res.json({ error: err.message }, 500);
	}

	log('Stripe connection token created successfully');
	return res.json({ secret: connectionToken.secret, mode: isLive ? 'live' : 'test' });
};
