import Stripe from 'stripe';
import { Users } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

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

// Teams allowed to mint a Terminal connection token. This function's `execute`
// list carries `users` on it -- which, with anonymous sessions enabled, is the
// public internet -- so until that list is narrowed THIS check is the only
// thing standing between an anonymous caller and a *live* Terminal connection
// token for the venue's own reader (P0-10). It is therefore written to fail
// closed: anything other than a positive "yes, this caller is in an allowed
// team" refuses. One extra API call on a path that runs once per POS boot
// rather than per sale.
//
// It needs the users.read scope to run at all (Appwrite injects
// x-appwrite-key only for a function that declares scopes) -- see
// appwrite.config.json and the README.
const ALLOWED_TEAM_IDS = [
	'68e35aed00144b8cde9d', // admin
	'68ffcecc0026f78f0af8', // POS
	'6a9cbb1c95ea7d59dd8c', // PIN Payment Access
];

// ShottyTicketing authenticates as this shared door account (quick-access-login
// mints its token), and that account is not a member of any team -- it reached
// this function only via the `users` entry above. Allow it by id so removing
// `users` from `execute` can't take the door app down; drop this constant once
// the account is a member of the POS team.
const DOOR_STAFF_USER_ID = '6aa201ecd741fa3bb794';

// 'allowed' | 'denied' | 'unverified'. `unverified` is a FAILURE, not a pass:
// this check used to return true whenever it could not run, which -- with this
// function's scopes empty, so Appwrite never injects x-appwrite-key at all --
// meant it never ran and never refused anybody. A gate that cannot run is not
// defence in depth, it is decoration, so both "cannot run" states now fail
// closed and are reported separately from a genuine refusal (they are an
// operator problem: see this function's README and `scopes` in
// appwrite.config.json, which must carry users.read).
async function classifyCaller(req, log, error) {
	const callerId = req.headers['x-appwrite-user-id'];
	if (!callerId) {
		// No user session at all -- a direct invocation with a project API key
		// carrying `execution.write`, which bypasses the execute allowlist.
		return 'denied';
	}
	// ShottyTicketing's shared door account, which belongs to no team. Allowed by
	// id -- see DOOR_STAFF_USER_ID above.
	if (callerId === DOOR_STAFF_USER_ID) return 'allowed';

	if (!req.headers['x-appwrite-key']) {
		error(
			'No x-appwrite-key injected: team membership cannot be verified, so this request is refused. Grant this function the users.read scope.',
		);
		return 'unverified';
	}

	try {
		const users = new Users(await createAppwriteClient(req));
		const result = await users.listMemberships(callerId);
		const allowed = (result.memberships || []).some((m) => ALLOWED_TEAM_IDS.includes(m.teamId) && m.confirm);
		if (!allowed) log(`Caller ${callerId} is in none of the allowed teams`);
		return allowed ? 'allowed' : 'denied';
	} catch (err) {
		error('Could not check team membership, refusing this request: ' + err.message);
		return 'unverified';
	}
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
	const caller = await classifyCaller(req, log, error);
	if (caller === 'unverified') {
		// Distinct status and message from a refusal: this one is on us, and a
		// till that hits it needs the operator to fix a scope, not a new PIN.
		return res.json({ error: 'Could not verify this device right now -- try again' }, 503);
	}
	if (caller !== 'allowed') {
		error('Refused connection-token request from a caller outside the allowed teams.');
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
