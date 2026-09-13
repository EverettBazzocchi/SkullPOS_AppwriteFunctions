import crypto from 'crypto';
import { Databases, Teams, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { computeEventWindow } from './eventWindow.js';
import {
    checkLockout,
    recordFailedAttempt,
    resetState,
    toPersistedState,
    MAX_ATTEMPTS,
    IP_MAX_ATTEMPTS,
} from './rateLimit.js';

function hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

// Same shared `rate_limits` collection quick-access-login already uses for the identical
// problem (a short PIN on an unauthenticated `execute:["any"]` endpoint -- 10,000 possible
// 4-digit combinations, brute-forceable without this). Keyed by caller IP, not by the PIN
// itself, so a lockout can't be used to probe which PINs exist.
const RATE_LIMIT_COLLECTION_ID = 'rate_limits';

// The **rightmost** element of x-forwarded-for, not the leftmost. Each proxy appends the address
// it received the request from, so the last element is the one written by the trusted proxy in
// front of this runtime; everything to its left is whatever the caller chose to send. That
// matters here because Appwrite's own createExecution API lets a caller supply an arbitrary
// `headers` map, so the leftmost element is literally attacker-authored -- keying the throttle on
// it meant every attempt landed in a fresh bucket, and that a chosen value could pin a lockout on
// the venue's own bucket (P0-4b).
//
// Assumption: exactly one trusted proxy appends to this header in front of the function runtime,
// which is what the deployment behind api.cloud.shotty.tech does. If another proxy is ever put in
// front, the trusted element moves and this must take the Nth-from-last instead.
function extractClientIp(req) {
    const forwarded = (req.headers && req.headers['x-forwarded-for']) || '';
    const chain = String(forwarded)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    if (chain.length > 0) return chain[chain.length - 1];
    // x-real-ip is written by the proxy as a single value (no chain to pick from). It is only
    // reached when there is no x-forwarded-for at all.
    const realIp = (req.headers && req.headers['x-real-ip']) || '';
    return String(realIp).trim() || 'unknown';
}

// Appwrite document IDs must be a restricted charset -- a short hash keeps this valid
// regardless of the raw value's format (IPv4, IPv6, or an Appwrite user id).
// Prefixed distinctly from quick-access-login's own `qa_...` docs in the same collection, since
// the two functions throttle independently.
function rateLimitDocId(prefix, value) {
    return prefix + crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

// Two buckets are checked and written on every failed attempt:
//
//   caller (`pin_c_`, MAX_ATTEMPTS) -- the session the client created before verifying. Gives each
//     till/kiosk/phone its own budget, so one device's five typos no longer lock out every other
//     device sharing the venue's egress IP (P1-14). A caller can mint a fresh anonymous session to
//     get a fresh bucket, so this can only ever *narrow* the budget, never escape it.
//   ip (`pin_ip_`, IP_MAX_ATTEMPTS) -- the trusted proxy-supplied address. The ceiling that cannot
//     be walked away from, which is why it, not the caller bucket, is the real brute-force limit.
function rateLimitBuckets(ip, callerId) {
    return [
        { id: rateLimitDocId('pin_c_', callerId || ip), max: MAX_ATTEMPTS, label: callerId ? 'caller' : 'caller(ip)' },
        { id: rateLimitDocId('pin_ip_', ip), max: IP_MAX_ATTEMPTS, label: 'ip' },
    ];
}

function minutesFromMs(ms) {
    return Math.max(1, Math.ceil(ms / 60000));
}

// Best-effort load: any failure (including the expected 404 for a caller with no prior failed
// attempts) is treated as "no state on record" rather than blocking PIN verification entirely --
// a rate-limit storage hiccup must never lock staff out of the till.
async function loadRateLimitState(databases, databaseId, docId, error) {
    try {
        const doc = await databases.getDocument(databaseId, RATE_LIMIT_COLLECTION_ID, docId);
        return doc || null;
    } catch (err) {
        if (err && err.code !== 404) {
            error('Rate-limit lookup failed (proceeding without throttling for this request): ' + err.message);
        }
        return null;
    }
}

// Persists one bucket's counter. Returns true only if the write actually landed -- the caller
// decides what a false means, and for a failed PIN attempt it means fail CLOSED (see
// rejectWithFailedAttempt). This used to swallow every failure into a log line, which is how the
// limiter ran for its entire life persisting nothing at all: `justLocked` was passed straight
// through as a document attribute, `rate_limits` has no such attribute, and Appwrite 400'd every
// single write (P0-4a). Only `toPersistedState`'s three attributes are ever sent now.
//
// KNOWN GAP (P2-16): this is still a read-modify-write, not an atomic increment, so a burst of
// concurrent executions all read the same `attempts` and all write back the same successor -- the
// persisted counter climbs by one no matter how wide the burst. The server side of the fix exists
// (this instance runs Appwrite 1.9.0, which serves
// `PATCH .../documents/{id}/{attribute}/increment`), but reaching it from here needs
// `Databases.incrementDocumentAttribute`, which arrived in node-appwrite 17 -- this function pins
// ^14.1.0 and runs on the node-16.0 runtime, and node-appwrite 17+ needs Node 18+. So closing this
// is a runtime bump plus an SDK major, not an edit to this file. quick-access-login, which talks
// raw HTTP and so is not bound by the SDK version, calls that endpoint directly today; see
// `recordFailureForBucket` there for the shape this should take once the runtime moves.
async function saveRateLimitState(databases, databaseId, docId, existed, state, error) {
    const data = toPersistedState(state);
    try {
        if (existed) {
            await databases.updateDocument(databaseId, RATE_LIMIT_COLLECTION_ID, docId, data);
        } else {
            try {
                await databases.createDocument(databaseId, RATE_LIMIT_COLLECTION_ID, docId, data);
            } catch (createErr) {
                // 409: a concurrent execution created this bucket between our read and our write.
                // That is someone else's failed attempt, not a reason to drop ours.
                if (!createErr || createErr.code !== 409) throw createErr;
                await databases.updateDocument(databaseId, RATE_LIMIT_COLLECTION_ID, docId, data);
            }
        }
        return true;
    } catch (err) {
        error(
            `RATE-LIMIT-WRITE-FAILED doc=${docId} code=${(err && err.code) || 'none'} type=${(err && err.type) || 'none'}: ` +
                ((err && err.message) || String(err)),
        );
        return false;
    }
}

// The narrower team a verified PIN session (staff cashier or self-checkout
// kiosk) is granted membership in so it can execute the Stripe payment
// functions (Terminal connection token, create/cancel PaymentIntent) --
// those functions' `execute` permission lists this team alongside
// STAFF_TEAM_IDS. Deliberately NOT the same team as STAFF_TEAM_IDS: a PIN
// session must be able to charge a card without also counting as "staff"
// for the isStaff() checks in Sales-Report/Transactions-List, which is what
// keeps the 24h report clamp and no-refunds restriction real.
const PIN_PAYMENT_TEAM_ID = '6a9cbb1c95ea7d59dd8c';

const DATABASE_ID = '67c9ffd9003d68236514';
const PINS_COLLECTION_ID = 'pins';
const BARTENDERS_COLLECTION_ID = 'bartenders';
const PIN_VALID_WINDOW_MS = 60 * 60 * 1000; // buffer on each side of the event's actual window

// True if `now` falls within 1 hour of any of this bartender's assigned events' actual
// start-to-close window (see eventWindow.js -- the UNION of the event's own `startsAt`/`endsAt`
// and the bar's `barOpensAt`/`barClosesAt` instants, with the legacy `date` surviving only as a
// START anchor for a row carrying none of the four) -- a bartender pin only works for the event(s)
// they're actually scheduled for, covering their whole shift, not permanently like a
// POS/self-checkout pin.
//
// There is no longer any legacy route from a start to an END: the `barOpenTime`/`barCloseTime`
// duration this used to fall back on is gone with the attributes themselves. So a row with a start
// and no end instant yields a zero-length window, and the ±1h buffer below is then that pin's
// ENTIRE validity rather than padding on top of a real shift. eventWindow.js argues why that beats
// refusing to authenticate at all; what matters at this call site is that the buffer is the only
// thing holding such a shift open, so narrowing it is not the local tweak it looks like.
//
// The bartender rows are fetched with Query.select(['*', 'events.*']), so the new attributes come
// through on the nested events with no query change needed.
function isWithinAnyEventWindow(events, now = Date.now()) {
	if (!Array.isArray(events)) return false;
	return events.some((event) => {
		const window = computeEventWindow(event);
		if (!window) return false;
		return now >= window.startMs - PIN_VALID_WINDOW_MS && now <= window.endMs + PIN_VALID_WINDOW_MS;
	});
}

// Verifies a quick-access PIN for the POS's restricted "cashier mode" (no
// refunds, sales reports capped at 24 hours), the self-checkout kiosk mode
// (system:'self_checkout' rows -- no refunds/history/reporting at all,
// card-only payment), or a bartender's own event-scoped pin.
//
// PINs are stored as sha256(pin) rows in the shared `pins` collection
// (system in ['pos','self_checkout'], plus 'ticketing' for
// quick-access-login's own separate PIN pool) -- managed by the admin app
// via Admin-GeneratePin. Formerly a PINS_JSON environment variable; moved
// to a database collection so PINs can be generated/rotated/revoked from a
// client instead of hand-edited via the console/CLI.
//
// Bartender pins are a separate `bartenders` collection (own hash, not
// mixed into `pins`) -- checked only if nothing in `pins` matched, since a
// bartender pin has an extra rule none of the others do (only valid within
// 1 hour of one of their assigned events' own window) and resolves to a real
// bartender document id (`bartenderId`) rather than just a display label,
// so POS can attribute every sale they make back to their own row.
export default async ({ req, res, log, error }) => {
    let body;
    try {
        body = JSON.parse(req.body || '{}');
    } catch (err) {
        return res.json({ ok: false, error: 'Invalid request body' }, 400);
    }

    const pin = String(body.pin || '').trim();
    if (!pin) {
        return res.json({ ok: false, error: 'Missing pin' }, 400);
    }

    const client = await createAppwriteClient(req);
    const databases = new Databases(client);

    const callerId = req.headers['x-appwrite-user-id'];
    const ip = extractClientIp(req);
    const now = Date.now();
    const buckets = rateLimitBuckets(ip, callerId);
    for (const bucket of buckets) {
        bucket.state = await loadRateLimitState(databases, DATABASE_ID, bucket.id, error);
    }

    const lockedBucket = buckets.find((bucket) => checkLockout(bucket.state, now).locked);
    if (lockedBucket) {
        const { retryAfterMs } = checkLockout(lockedBucket.state, now);
        log(`PIN verification locked out (${lockedBucket.label} bucket) for ${ip} -- ${Math.ceil(retryAfterMs / 1000)}s remaining`);
        return res.json(
            { ok: false, error: `Too many incorrect PIN attempts. Try again in ${minutesFromMs(retryAfterMs)} minute(s).` },
            429,
        );
    }

    // Records a failed attempt against this IP and returns the response to send back -- the
    // normal "no match" response unless this failure just tipped the caller into a lockout, in
    // which case the lockout message takes over (communicating a real, different signal --
    // "you're locked out" -- from "that PIN was wrong", without ever confirming *which* PINs
    // came close).
    async function rejectWithFailedAttempt(plainResponseBody) {
        let persistedAll = true;
        let locked = null;
        for (const bucket of buckets) {
            const nextState = recordFailedAttempt(bucket.state, now, bucket.max);
            const persisted = await saveRateLimitState(databases, DATABASE_ID, bucket.id, !!bucket.state, nextState, error);
            persistedAll = persistedAll && persisted;
            if (persisted && nextState.justLocked && !locked) {
                locked = { bucket, nextState };
            }
        }

        // Fail CLOSED: if the counter could not be written, this attempt leaves no trace and the
        // next one starts from zero -- i.e. the endpoint is running with no brute-force defence at
        // all. Refusing to answer is the only way an unauthenticated PIN endpoint can stay safe
        // while its limiter is broken, and it turns a silent, permanent hole into a visible outage.
        if (!persistedAll) {
            error('RATE-LIMIT-UNAVAILABLE refusing PIN verification: a failed attempt could not be recorded');
            return res.json(
                { ok: false, error: 'PIN verification is temporarily unavailable. Please try again shortly.' },
                503,
            );
        }

        if (locked) {
            log(`PIN verification now locked out (${locked.bucket.label} bucket) for ${ip} after repeated incorrect attempts`);
            const retryAfterMs = Date.parse(locked.nextState.lockedUntil) - now;
            return res.json(
                { ok: false, error: `Too many incorrect PIN attempts. Try again in ${minutesFromMs(retryAfterMs)} minute(s).` },
                429,
            );
        }
        return res.json(plainResponseBody);
    }

    const pinHash = hashPin(pin);
    let match;
    try {
        const result = await databases.listDocuments(DATABASE_ID, PINS_COLLECTION_ID, [
            Query.equal('system', ['pos', 'self_checkout']),
            Query.equal('hash', pinHash),
            Query.equal('active', true),
            Query.limit(1),
        ]);
        match = result.documents[0];
    } catch (err) {
        error('Failed to query pins: ' + err.message);
        return res.json({ ok: false, error: 'Server not configured' }, 500);
    }

    // Resolves to what the rest of this function needs regardless of which collection matched:
    // a display label, whether it's the self-checkout kiosk mode, and (bartenders only) the
    // bartender's own document id, so POS can attribute every sale they make back to them.
    let resolved;

    if (match) {
        resolved = { label: match.label || null, selfCheckout: match.system === 'self_checkout', bartenderId: null };
    } else {
        let bartender;
        try {
            const result = await databases.listDocuments(DATABASE_ID, BARTENDERS_COLLECTION_ID, [
                Query.equal('hash', pinHash),
                Query.equal('active', true),
                Query.select(['*', 'events.*']),
                Query.limit(1),
            ]);
            bartender = result.documents[0];
        } catch (err) {
            error('Failed to query bartenders: ' + err.message);
            return res.json({ ok: false, error: 'Server not configured' }, 500);
        }

        if (!bartender) {
            log('PIN verification failed (no match)');
            return rejectWithFailedAttempt({ ok: false });
        }

        if (!isWithinAnyEventWindow(bartender.events)) {
            // The response body here is deliberately IDENTICAL, byte for byte, to the no-match
            // response above. It used to read "This pin is only valid within 1 hour of your event's
            // start time", which made this endpoint a PIN-existence oracle (P2-13): walk the
            // 10,000-code space at any hour, get that message back on exactly one code, and you
            // have positively identified a live bartender PIN to replay at the venue's next
            // advertised event -- reducing the window check, the only extra protection a bartender
            // PIN has, to a scheduling inconvenience. The human-readable reason now exists only in
            // the execution log, where support can read it and a caller cannot.
            //
            // Still deliberately NOT counted as a failed attempt: the credential was correct, just
            // presented outside its shift, and a bartender who arrives early and taps her own real
            // PIN five times must not burn the budget for every other device sharing the venue's
            // egress (P1-14). That leaves a far weaker residual side-channel -- this one code costs
            // the caller no budget -- but reading it means running a full 15-minute lockout cycle
            // per batch and spotting an off-by-one in the remaining allowance, instead of getting
            // the answer from a single response.
            log(`Bartender pin for ${bartender.name} rejected -- outside its event's window (answered as a plain no-match; no failed attempt recorded)`);
            return res.json({ ok: false });
        }

        resolved = { label: bartender.name || null, selfCheckout: false, bartenderId: bartender.$id };
    }

    log('PIN verified: ' + (resolved.label || 'unlabeled'));

    // A correct PIN clears this caller's accumulated failed attempts -- only worth a write if
    // there was actually prior state to clear. Deliberately only the caller bucket: the shared-IP
    // backstop keeps counting (it expires on its own window), so one device's success can't wipe
    // the venue-wide evidence of a brute-force walk in progress from the same egress. A failure
    // here is logged but not fatal -- it leaves the counter higher than it should be, which errs
    // toward locking out rather than toward unlimited guesses.
    const callerBucket = buckets[0];
    if (callerBucket.state) {
        await saveRateLimitState(databases, DATABASE_ID, callerBucket.id, true, resetState(), error);
    }

    // Grant this session's user (the anonymous account the client creates
    // BEFORE calling this function -- see api.js's loginWithPin) membership
    // in the payment-access team, so it can execute the Stripe functions.
    // Not fatal if this fails or if there's no caller id yet (an older
    // client build, or a direct API call) -- the PIN itself is still valid,
    // it just won't be able to charge a card until this succeeds.
    //
    // NOTE: this grant has no expiry and nothing anywhere deletes it, so revoking the PIN row
    // (`active: false`) does NOT revoke the access this call already handed out -- see P1-2. The
    // membership can't simply be TTL'd here: a self-checkout kiosk is designed never to re-enter
    // its PIN (POS/src/utils/pin.js), so expiring it server-side would strand the kiosk mid-shift
    // with no way to re-authorise. Properly fixing it means replacing the durable team with a
    // short-lived claim the Stripe functions validate, which spans POS and those functions. Until
    // then, this line is the audit trail: it records which account was granted access by which PIN,
    // so a revoke can be carried out by hand against the team's member list.
    if (callerId) {
        try {
            const teams = new Teams(client);
            await teams.createMembership(PIN_PAYMENT_TEAM_ID, [], undefined, callerId);
            log(`PIN-GRANT user=${callerId} label=${resolved.label || 'unlabeled'} bartenderId=${resolved.bartenderId || 'none'}`);
        } catch (err) {
            error('Failed to grant payment-team membership (PIN still valid): ' + err.message);
        }
    } else {
        error('No caller id on the request -- session must be created before verifying the PIN');
    }

    return res.json({ ok: true, label: resolved.label, selfCheckout: resolved.selfCheckout, bartenderId: resolved.bartenderId });
};
