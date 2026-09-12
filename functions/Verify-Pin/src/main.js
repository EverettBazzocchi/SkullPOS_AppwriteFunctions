import crypto from 'crypto';
import { Databases, Teams, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { computeEventWindow } from './eventWindow.js';
import { checkLockout, recordFailedAttempt, resetState } from './rateLimit.js';

function hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

// Same shared `rate_limits` collection quick-access-login already uses for the identical
// problem (a short PIN on an unauthenticated `execute:["any"]` endpoint -- 10,000 possible
// 4-digit combinations, brute-forceable without this). Keyed by caller IP, not by the PIN
// itself, so a lockout can't be used to probe which PINs exist.
const RATE_LIMIT_COLLECTION_ID = 'rate_limits';

function extractClientIp(req) {
    const forwarded = (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '';
    return String(forwarded).split(',')[0].trim() || 'unknown';
}

// Appwrite document IDs must be a restricted charset -- a short hash keeps this valid
// regardless of the raw IP format (IPv4, IPv6, or a comma-separated x-forwarded-for chain).
// Prefixed distinctly from quick-access-login's own `qa_...` docs in the same collection, since
// the two functions throttle independently.
function rateLimitDocId(ip) {
    return 'pin_' + crypto.createHash('sha1').update(ip).digest('hex').slice(0, 16);
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

async function saveRateLimitState(databases, databaseId, docId, existed, data, error) {
    try {
        if (existed) {
            await databases.updateDocument(databaseId, RATE_LIMIT_COLLECTION_ID, docId, data);
        } else {
            await databases.createDocument(databaseId, RATE_LIMIT_COLLECTION_ID, docId, data);
        }
    } catch (err) {
        error('Failed to persist rate-limit state (continuing): ' + err.message);
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
// start-to-close window (see eventWindow.js) -- a bartender pin only works for the event(s)
// they're actually scheduled for, covering their whole shift, not permanently like a
// POS/self-checkout pin.
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
// 1 hour of one of their assigned events' `date`) and resolves to a real
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

    const ip = extractClientIp(req);
    const rateLimitKey = rateLimitDocId(ip);
    const now = Date.now();
    const rateLimitState = await loadRateLimitState(databases, DATABASE_ID, rateLimitKey, error);

    const lockout = checkLockout(rateLimitState, now);
    if (lockout.locked) {
        log(`PIN verification locked out for ${ip} -- ${Math.ceil(lockout.retryAfterMs / 1000)}s remaining`);
        return res.json(
            { ok: false, error: `Too many incorrect PIN attempts. Try again in ${minutesFromMs(lockout.retryAfterMs)} minute(s).` },
            429,
        );
    }

    // Records a failed attempt against this IP and returns the response to send back -- the
    // normal "no match" response unless this failure just tipped the caller into a lockout, in
    // which case the lockout message takes over (communicating a real, different signal --
    // "you're locked out" -- from "that PIN was wrong", without ever confirming *which* PINs
    // came close).
    async function rejectWithFailedAttempt(plainResponseBody) {
        const nextState = recordFailedAttempt(rateLimitState, now);
        await saveRateLimitState(databases, DATABASE_ID, rateLimitKey, !!rateLimitState, nextState, error);
        if (nextState.justLocked) {
            log(`PIN verification now locked out for ${ip} after repeated incorrect attempts`);
            const retryAfterMs = Date.parse(nextState.lockedUntil) - now;
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
            log(`Bartender pin for ${bartender.name} rejected -- outside its event's 1-hour window`);
            return rejectWithFailedAttempt({ ok: false, error: "This pin is only valid within 1 hour of your event's start time" });
        }

        resolved = { label: bartender.name || null, selfCheckout: false, bartenderId: bartender.$id };
    }

    log('PIN verified: ' + (resolved.label || 'unlabeled'));

    // A correct PIN clears any accumulated failed attempts for this IP -- only worth a write if
    // there was actually prior state to clear.
    if (rateLimitState) {
        await saveRateLimitState(databases, DATABASE_ID, rateLimitKey, true, resetState(), error);
    }

    // Grant this session's user (the anonymous account the client creates
    // BEFORE calling this function -- see api.js's loginWithPin) membership
    // in the payment-access team, so it can execute the Stripe functions.
    // Not fatal if this fails or if there's no caller id yet (an older
    // client build, or a direct API call) -- the PIN itself is still valid,
    // it just won't be able to charge a card until this succeeds.
    const callerId = req.headers['x-appwrite-user-id'];
    if (callerId) {
        try {
            const teams = new Teams(client);
            await teams.createMembership(PIN_PAYMENT_TEAM_ID, [], undefined, callerId);
        } catch (err) {
            error('Failed to grant payment-team membership (PIN still valid): ' + err.message);
        }
    } else {
        error('No caller id on the request -- session must be created before verifying the PIN');
    }

    return res.json({ ok: true, label: resolved.label, selfCheckout: resolved.selfCheckout, bartenderId: resolved.bartenderId });
};
