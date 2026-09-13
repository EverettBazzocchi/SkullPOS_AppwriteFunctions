import crypto from 'crypto';
import { Databases, Query } from 'node-appwrite';
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
//   1. who may call this function at all, which Appwrite decides from the `execute` list (see
//      classifyCaller below), and
//   2. repeated misses from one IP lock that IP out (rateLimit.js).
// The second fails closed -- a miss that cannot be counted is refused (503) rather than served,
// which needs the documents.write scope to work at all -- and that is a different trade from the
// one in classifyCaller: the throttle is the only thing guarding the keyspace, nothing else
// enforces it, and it can only fail when the Appwrite Databases API is failing, at which point the
// giftcards query below cannot run either. Refusing there costs nothing that was still working.
const DATABASE_ID = '67c9ffd9003d68236514';
const GIFTCARDS_COLLECTION_ID = 'giftcards';
const RATE_LIMIT_COLLECTION_ID = 'rate_limits';

// Throttle per CALLING ACCOUNT, not per IP.
//
// This used to key on the leftmost element of x-forwarded-for (falling back to x-real-ip), which
// is caller-authored: createExecution lets a caller set arbitrary headers, so the bucket was
// choosable. That breaks it in both directions -- rotate the value and the 100,000-wide
// enumeration oracle is unthrottled, or pin it to another till's value and you exhaust that till's
// bucket from outside. It was also wrong operationally even with honest callers: every till at the
// venue leaves through one public IP, so all of them shared a single 10-attempt bucket and the
// eleventh legitimate scan of the night would have been refused venue-wide.
//
// `x-appwrite-user-id` is set by Appwrite from the session, cannot be supplied by the caller, and
// is per-device (each till signs in as its own account). classifyCaller has already refused the
// request if it is absent, so it is always present here. Same keying Transaction-EmailReceipt
// already uses for its send quota.
function extractThrottleKey(req) {
	return String((req.headers && req.headers['x-appwrite-user-id']) || '').trim() || 'unknown';
}

// Appwrite document IDs must be a restricted charset -- a short hash keeps this valid regardless
// of the raw IP format (IPv4, IPv6, or a comma-separated x-forwarded-for chain). Prefixed
// distinctly from Verify-Pin's `pin_...` and quick-access-login's `qa_...` docs in the same
// collection, since the three functions throttle independently.
function rateLimitDocId(throttleKey) {
	return 'gcl_' + crypto.createHash('sha1').update(throttleKey).digest('hex').slice(0, 16);
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

// WHO MAY CALL THIS FUNCTION IS APPWRITE'S DECISION, NOT THIS FILE'S. Identical in shape and
// reasoning to stripe-getConnectionToken's and Transaction-EmailReceipt's guard -- the three must
// stay the same shape, because an inconsistency between them is how the next incident starts.
//
// The function's `execute` list names three teams -- admin (68e35aed00144b8cde9d), POS
// (68ffcecc0026f78f0af8) and PIN Payment Access (6a9cbb1c95ea7d59dd8c), the team Verify-Pin joins a
// device to once a PIN is accepted -- and the platform checks that list when the execution is
// created, before this module is ever loaded. Appwrite grants a caller the `team:<id>` role only
// for a membership whose `confirm` is true, so "a confirmed member of one of those three teams" has
// already been proven by the time this code runs; a bare anonymous session belongs to none of them
// and never reaches here. Verified against the live function on 2026-09-13 with
// `appwrite functions get --function-id 6a9c5c1acb643536564a`: `execute` is those three teams and
// nothing else.
//
// So this function checks the ONE thing that allowlist does not cover: whether there is a caller at
// all. A project API key carrying `execution.write` can invoke a function directly -- Appwrite
// cancels permission checks for API-key requests, so the `execute` list is not consulted -- and
// such an execution has no session user, so `x-appwrite-user-id` arrives absent or empty.
//
// There is deliberately NO third "I could not tell" state, and nothing on this path calls out to
// another service. An earlier version re-derived team membership here through
// users.listMemberships() and refused with a 503 whenever that call could not answer. On 2026-09-13
// 07:51 UTC it could not answer -- `User with the requested ID could not be found`, which is what
// the project's Users API says about any caller id it cannot resolve -- and giftcard scanning at
// the bar stopped. The check's only job was to re-prove something Appwrite had already proven, so
// it could only ever agree or be wrong, and being wrong took a live till offline. Note the contrast
// with the enumeration throttle below, which does still fail closed: that one guards something
// nothing else guards, and it cannot fail while the rest of this function still works.
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

	if (classifyCaller(req) !== 'allowed') {
		error('Refused giftcard lookup: no session user, so this was a direct API-key invocation.');
		return res.json({ error: 'Unauthorized' }, 403);
	}

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	const throttleKey = extractThrottleKey(req);
	const rateLimitKey = rateLimitDocId(throttleKey);
	const now = Date.now();
	const { state: rateLimitState, ok: rateLimitReadable } = await loadRateLimitState(databases, rateLimitKey, error);
	if (!rateLimitReadable) {
		return res.json({ error: 'Giftcard lookup is temporarily unavailable -- try again' }, 503);
	}

	// Checked before the query runs, so a locked-out caller gets the identical response for a code
	// that exists and one that does not -- the lockout itself can't be used to finish the walk.
	const lockout = checkLockout(rateLimitState, now);
	if (lockout.locked) {
		log(`Giftcard lookup locked out for caller ${throttleKey} -- ${Math.ceil(lockout.retryAfterMs / 1000)}s remaining`);
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
			log(`Giftcard lookup now locked out for caller ${throttleKey} after repeated unrecognized codes`);
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
