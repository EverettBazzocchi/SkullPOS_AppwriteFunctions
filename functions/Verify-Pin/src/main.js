import crypto from 'crypto';
import { Teams } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

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

// Verifies a quick-access PIN for the POS's restricted "cashier mode" (no
// refunds, sales reports capped at 24 hours) or the self-checkout kiosk
// mode (selfCheckout:true PIN records -- no refunds/history/reporting at
// all, card-only payment).
//
// PINs are stored as sha256(pin) in the PINS_JSON environment variable
// (a secret var, e.g. [{"hash":"...","label":"Bartender"}]) -- not in a
// database collection, since an env var needs no network call at all and
// gets the same write-only protection as the Stripe keys.
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

    let pins;
    try {
        pins = JSON.parse(process.env.PINS_JSON || '[]');
    } catch (err) {
        error('PINS_JSON env var is not valid JSON');
        return res.json({ ok: false, error: 'Server not configured' }, 500);
    }

    const pinHash = hashPin(pin);
    const match = pins.find((p) => p.hash === pinHash && p.active !== false);

    if (!match) {
        log('PIN verification failed (no match)');
        return res.json({ ok: false });
    }

    log('PIN verified: ' + (match.label || 'unlabeled'));

    // Grant this session's user (the anonymous account the client creates
    // BEFORE calling this function -- see api.js's loginWithPin) membership
    // in the payment-access team, so it can execute the Stripe functions.
    // Not fatal if this fails or if there's no caller id yet (an older
    // client build, or a direct API call) -- the PIN itself is still valid,
    // it just won't be able to charge a card until this succeeds.
    const callerId = req.headers['x-appwrite-user-id'];
    if (callerId) {
        try {
            const client = await createAppwriteClient(req);
            const teams = new Teams(client);
            await teams.createMembership(PIN_PAYMENT_TEAM_ID, [], undefined, callerId);
        } catch (err) {
            error('Failed to grant payment-team membership (PIN still valid): ' + err.message);
        }
    } else {
        error('No caller id on the request -- session must be created before verifying the PIN');
    }

    return res.json({ ok: true, label: match.label || null, selfCheckout: !!match.selfCheckout });
};
