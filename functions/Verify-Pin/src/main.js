import crypto from 'crypto';

function hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

// Verifies a quick-access PIN for the POS's restricted "cashier mode" (no
// refunds, sales reports capped at 24 hours).
//
// PINs are stored as sha256(pin) in the PINS_JSON environment variable
// (a secret var, e.g. [{"hash":"...","label":"Bartender"}]) -- not in a
// database collection. This function's execution sandbox has no network
// route back to this Appwrite instance's own API (self-hosted quirk), so
// reading a collection from here isn't viable; an env var needs no network
// call at all and gets the same write-only protection as the Stripe keys.
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
    return res.json({ ok: true, label: match.label || null });
};
