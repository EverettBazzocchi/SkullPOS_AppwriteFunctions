import crypto from 'crypto';
import { Databases, Teams, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { computeEventWindow } from './eventWindow.js';

function hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin)).digest('hex');
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
            return res.json({ ok: false });
        }

        if (!isWithinAnyEventWindow(bartender.events)) {
            log(`Bartender pin for ${bartender.name} rejected -- outside its event's 1-hour window`);
            return res.json({ ok: false, error: "This pin is only valid within 1 hour of your event's start time" });
        }

        resolved = { label: bartender.name || null, selfCheckout: false, bartenderId: bartender.$id };
    }

    log('PIN verified: ' + (resolved.label || 'unlabeled'));

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
