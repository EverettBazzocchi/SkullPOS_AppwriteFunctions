import crypto from 'crypto';
import { Databases, Users, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { checkLockout, recordMiss, resetState, toPersistable } from './rateLimit.js';

// Looks up a giftcard by its UPC/code server-side, so the client never
// needs read access to the giftcards collection (which would otherwise let
// any session -- anonymous quick-access PIN sessions included -- list
// every giftcard code and balance in the system).
//
// Two controls sit in front of that lookup, because the response ({id, balance}) is exactly the
// pair Transaction-RecordPayment accepts as `giftcardId` to debit a card, and every live UPC
// shares a fixed `75855` prefix -- a 100,000-wide keyspace one caller could otherwise walk end to
// end in an afternoon:
//   1. the caller must belong to a till/admin team (below), and
//   2. repeated misses from one IP lock that IP out (rateLimit.js).
// `execute` has been narrowed off `users` (the public internet, with anonymous sessions enabled)
// in appwrite.config.json, but only a push makes that live, and a list is only ever as tight as
// its last deploy -- so these two are treated as the access control, not a second copy of it.
// Both therefore fail closed: a caller whose team membership cannot be
// checked, and a miss that cannot be counted, are both refused (503) rather than served. Running
// them at all requires the users.read and documents.write scopes (see appwrite.config.json and
// the README); without those this function refuses every lookup instead of quietly allowing
// every lookup, which is what it did before.
const DATABASE_ID = '67c9ffd9003d68236514';
const GIFTCARDS_COLLECTION_ID = 'giftcards';
const RATE_LIMIT_COLLECTION_ID = 'rate_limits';

// Mirrors what this function's `execute` list should be: the admin team, the POS team, and the
// team Verify-Pin joins a device to once a PIN is accepted. A bare anonymous session belongs to
// none of them.
const ALLOWED_TEAM_IDS = [
	'68e35aed00144b8cde9d', // admin
	'68ffcecc0026f78f0af8', // POS
	'6a9cbb1c95ea7d59dd8c', // PIN Payment Access
];

function extractClientIp(req) {
	const forwarded = (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '';
	return String(forwarded).split(',')[0].trim() || 'unknown';
}

// Appwrite document IDs must be a restricted charset -- a short hash keeps this valid regardless
// of the raw IP format (IPv4, IPv6, or a comma-separated x-forwarded-for chain). Prefixed
// distinctly from Verify-Pin's `pin_...` and quick-access-login's `qa_...` docs in the same
// collection, since the three functions throttle independently.
function rateLimitDocId(ip) {
	return 'gcl_' + crypto.createHash('sha1').update(ip).digest('hex').slice(0, 16);
}

function minutesFromMs(ms) {
	return Math.max(1, Math.ceil(ms / 60000));
}

// Loads this IP's counter. A 404 is the normal "no misses on record" answer and means exactly
// that. Any OTHER failure means the throttle cannot be enforced for this request, and this
// endpoint is a 100,000-wide enumeration oracle when it is not throttled -- so that is reported
// as a storage failure and refused upstream, not quietly treated as "no misses".
async function loadRateLimitState(databases, docId, error) {
	try {
		const doc = await databases.getDocument(DATABASE_ID, RATE_LIMIT_COLLECTION_ID, docId);
		return { state: doc || null, ok: true };
	} catch (err) {
		if (err && err.code === 404) return { state: null, ok: true };
		error('Rate-limit lookup failed, refusing the lookup rather than serving it unthrottled: ' + err.message);
		return { state: null, ok: false };
	}
}

// Returns whether the counter was actually persisted. A swallowed write failure here is what made
// the whole limiter decorative: with no documents.write scope every create/update threw, the
// counter never advanced, and checkLockout always saw a fresh state. A miss that cannot be
// counted must therefore fail the request rather than be logged and forgotten.
async function saveRateLimitState(databases, docId, existed, state, error) {
	try {
		const data = toPersistable(state);
		if (existed) {
			await databases.updateDocument(DATABASE_ID, RATE_LIMIT_COLLECTION_ID, docId, data);
		} else {
			await databases.createDocument(DATABASE_ID, RATE_LIMIT_COLLECTION_ID, docId, data);
		}
		return true;
	} catch (err) {
		error('Failed to persist rate-limit state: ' + err.message + ' (the giftcards documents.write scope is required)');
		return false;
	}
}

// Same shape as stripe-getConnectionToken's check, for the same reason, and fail-closed for the
// same reason: returning true whenever the check could not run meant it never ran at all (this
// function declares no users.read scope, so Appwrite injects no x-appwrite-key, so
// listMemberships could only ever throw). 'allowed' | 'denied' | 'unverified' -- only the first
// reaches the giftcards collection.
async function classifyCaller(req, users, log, error) {
	const callerId = req.headers['x-appwrite-user-id'];
	if (!callerId) {
		// No user session at all -- a direct invocation with a project API key carrying
		// `execution.write`, which bypasses the execute allowlist entirely.
		return 'denied';
	}
	if (!req.headers['x-appwrite-key']) {
		error(
			'No x-appwrite-key injected: team membership cannot be verified, so this lookup is refused. Grant this function the users.read scope.',
		);
		return 'unverified';
	}
	try {
		const result = await users.listMemberships(callerId);
		const allowed = (result.memberships || []).some((m) => ALLOWED_TEAM_IDS.includes(m.teamId) && m.confirm);
		if (!allowed) log(`Caller ${callerId} is in none of the allowed teams`);
		return allowed ? 'allowed' : 'denied';
	} catch (err) {
		error('Could not check team membership, refusing this lookup: ' + err.message);
		return 'unverified';
	}
}

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const code = String(body.code || '').trim();
	if (!code) {
		return res.json({ error: 'Missing code' }, 400);
	}

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);
	const users = new Users(client);

	const caller = await classifyCaller(req, users, log, error);
	if (caller === 'unverified') {
		// Distinct from a refusal: this one is an operator problem (a missing scope or an Appwrite
		// blip), and it must not be answerable by guessing codes in the meantime.
		return res.json({ error: 'Could not verify this device right now -- try again' }, 503);
	}
	if (caller !== 'allowed') {
		error('Refused giftcard lookup from a caller outside the allowed teams.');
		return res.json({ error: 'Unauthorized' }, 403);
	}

	const ip = extractClientIp(req);
	const rateLimitKey = rateLimitDocId(ip);
	const now = Date.now();
	const { state: rateLimitState, ok: rateLimitReadable } = await loadRateLimitState(databases, rateLimitKey, error);
	if (!rateLimitReadable) {
		return res.json({ error: 'Giftcard lookup is temporarily unavailable -- try again' }, 503);
	}

	// Checked before the query runs, so a locked-out caller gets the identical response for a code
	// that exists and one that does not -- the lockout itself can't be used to finish the walk.
	const lockout = checkLockout(rateLimitState, now);
	if (lockout.locked) {
		log(`Giftcard lookup locked out for ${ip} -- ${Math.ceil(lockout.retryAfterMs / 1000)}s remaining`);
		return res.json(
			{ found: false, error: `Too many unrecognized giftcard codes. Try again in ${minutesFromMs(lockout.retryAfterMs)} minute(s).` },
			429,
		);
	}

	let docs;
	try {
		const result = await databases.listDocuments(DATABASE_ID, GIFTCARDS_COLLECTION_ID, [
			Query.equal('UPC', code),
			Query.limit(25),
		]);
		docs = result.documents || [];
	} catch (err) {
		error('Giftcard lookup query failed: ' + err.message);
		return res.json({ error: 'Lookup failed' }, 500);
	}

	// Defensive fallback in case UPC's stored shape varies across documents
	// (e.g. a legacy string containing the code as a substring, or an
	// array-type UPC attribute).
	const found = docs.find((d) => {
		const upc = d.UPC;
		if (Array.isArray(upc)) return upc.includes(code);
		if (typeof upc === 'string') return upc === code || upc.includes(code);
		return false;
	});

	if (!found) {
		log('Giftcard not found for code');
		const nextState = recordMiss(rateLimitState, now);
		const counted = await saveRateLimitState(databases, rateLimitKey, !!rateLimitState, nextState, error);
		if (!counted) {
			// A miss that cannot be counted is a free guess. Refusing to answer it is the only way
			// this limiter means anything: an enumerator who can crash the counter would otherwise
			// have an unthrottled oracle, which is precisely the state this function shipped in.
			return res.json({ error: 'Giftcard lookup is temporarily unavailable -- try again' }, 503);
		}
		if (nextState.justLocked) {
			log(`Giftcard lookup now locked out for ${ip} after repeated unrecognized codes`);
			const retryAfterMs = Date.parse(nextState.lockedUntil) - now;
			return res.json(
				{ found: false, error: `Too many unrecognized giftcard codes. Try again in ${minutesFromMs(retryAfterMs)} minute(s).` },
				429,
			);
		}
		return res.json({ found: false });
	}

	log('Giftcard found: ' + found.$id);

	// A real card clears any accumulated misses for this IP -- only worth a write if there was
	// actually prior state to clear.
	if (rateLimitState) {
		await saveRateLimitState(databases, rateLimitKey, true, resetState(now), error);
	}

	return res.json({
		found: true,
		id: found.$id,
		balance: found.balance || 0,
		// DJ-voucher signals -- absent/false for every standing customer gift card. `events`/`djs`
		// are relationship attributes that come back as plain related-document IDs (not nested
		// objects) on a direct getDocument/listDocuments call. The authoritative event/discount/
		// revocation checks happen at payment time in Transaction-RecordPayment, not here -- this
		// is informational only, so POS can show the right message before checkout is attempted.
		eventId: found.events?.$id || found.events || null,
		active: found.active !== false,
	});
};
