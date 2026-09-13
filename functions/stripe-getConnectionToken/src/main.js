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

// WHO MAY CALL THIS FUNCTION IS APPWRITE'S DECISION, NOT THIS FILE'S.
//
// The function's `execute` list names three teams -- admin (68e35aed00144b8cde9d), POS
// (68ffcecc0026f78f0af8) and PIN Payment Access (6a9cbb1c95ea7d59dd8c) -- and the platform checks
// that list when the execution is created, before this module is ever loaded. Appwrite grants a
// caller the `team:<id>` role only for a membership whose `confirm` is true, so "a confirmed
// member of one of those three teams" is exactly the predicate that has already been proven by the
// time this code runs. Verified against the live function on 2026-09-13 with
// `appwrite functions get --function-id 68f2904a00171e8b0266`: `execute` is those three teams and
// nothing else.
//
// So this function checks the ONE thing that allowlist does not cover: whether there is a caller at
// all. A project API key carrying `execution.write` can invoke a function directly -- Appwrite
// cancels permission checks for API-key requests, so the `execute` list is not consulted -- and
// such an execution has no session user, so `x-appwrite-user-id` arrives absent or empty. That is
// the only reachable caller the allowlist does not stop, and the identity check below is what stops
// it.
//
// There is deliberately NO third "I could not tell" state, and nothing on this path calls out to
// another service. An earlier version re-derived team membership here through
// users.listMemberships() and refused with a 503 whenever that call could not answer. On 2026-09-13
// 07:50 UTC it could not answer -- `User with the requested ID could not be found`, which is what
// the project's Users API says about any caller id it cannot resolve, a console-authenticated
// operator included -- and a live Terminal reader was refused its connection token by a check whose
// only job was to re-prove something Appwrite had already proven. A control that duplicates the
// platform's own decision can only ever agree with it or be wrong, and the cost of being wrong here
// is a door reader or a till going dark mid-service. That trade is not worth making, so the
// duplicate is gone rather than merely made fail-open: a second copy of the team list is also a
// second thing to keep in sync, and a stale copy refuses legitimate callers just as readily.
//
// Whatever replaces this must keep both properties: an API-key-only invocation is refused, and no
// external lookup can turn a session caller away. Both are covered by tests in main.test.js.
function classifyCaller(req) {
	// 'allowed' | 'denied' -- two states, because every input this needs is already on the request.
	const callerId = req.headers['x-appwrite-user-id'];
	if (!callerId) {
		// No session user: a direct invocation with a project API key carrying `execution.write`,
		// which is the one way past the execute allowlist. Appwrite sends this header with an empty
		// value rather than omitting it, so "" must be refused as firmly as a missing header.
		return 'denied';
	}
	return 'allowed';
}

// Which mode a Stripe secret/restricted key declares about itself, or null
// for anything that doesn't announce one. Used to catch a key configured
// under the wrong variable name -- only a key that positively declares the
// *other* mode is refused, so an unrecognized key format can never be the
// reason card payments stop.
function keyDeclaresMode(key) {
	if (/^(sk|rk)_live_/.test(key)) return 'live';
	if (/^(sk|rk)_test_/.test(key)) return 'test';
	return null;
}

export default async ({ req, res, log, error }) => {
	if (classifyCaller(req) !== 'allowed') {
		error('Refused connection-token request: no session user, so this was a direct API-key invocation.');
		return res.json({ error: 'Unauthorized' }, 403);
	}

	let body = {};
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		// Both callers sometimes send an empty body for the prod/live
		// default -- an empty/unparseable body isn't an error here.
	}

	const isLive = resolveIsLive(body);
	const mode = isLive ? 'live' : 'test';
	log(isLive ? 'production key used' : 'test key used');
	const key = isLive ? process.env.prodKey : process.env.testKey;

	// A missing key used to reach `new Stripe(undefined)` and surface as an
	// opaque Stripe error; a key sitting under the wrong variable name used to
	// mint a token in the *opposite* mode to the one the response advertises,
	// which the client then pairs with a PaymentIntent from the other mode.
	// Both are configuration faults, so say so.
	if (!key) {
		error(`No Stripe key configured for ${mode} mode (${isLive ? 'prodKey' : 'testKey'} is unset).`);
		return res.json({ error: `Stripe ${mode} key is not configured` }, 500);
	}
	const declaredMode = keyDeclaresMode(key);
	if (declaredMode && declaredMode !== mode) {
		error(`${isLive ? 'prodKey' : 'testKey'} holds a ${declaredMode}-mode key but ${mode} mode was requested.`);
		return res.json({ error: `Stripe ${mode} key is misconfigured` }, 500);
	}

	const stripe = new Stripe(key);
	let connectionToken;
	try {
		connectionToken = await stripe.terminal.connectionTokens.create();
	} catch (err) {
		error('Error creating Stripe connection token: ' + err.message);
		return res.json({ error: err.message }, 500);
	}

	log('Stripe connection token created successfully');
	return res.json({ secret: connectionToken.secret, mode });
};
