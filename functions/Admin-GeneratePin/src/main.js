import crypto from 'crypto';
import { Databases } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Generates/rotates/revokes staff PINs for the three PIN-gated systems (POS
// cashier, self-checkout kiosk, ShottyTicketing door staff), all stored as
// hashed rows in the shared `pins` collection -- read at verification time
// by Verify-Pin (system in ['pos','self_checkout']) and quick-access-login
// (system:'ticketing'). Admin-execute-only (enforced by Appwrite's own
// function execute permission, no in-code check needed -- same pattern as
// Stripe-RefundPayment).
//
// The raw 4-digit code is generated server-side (crypto.randomInt, never
// client-supplied). Verify-Pin only ever checks the sha256 hash (`hash`,
// matching the hashing convention its old PINS_JSON used) -- but the
// plaintext `pin` is deliberately persisted alongside it too, so the admin
// app can display/re-display a pin to staff after creation without this
// function having to hand it back over a fresh channel each time. Treat
// `pins` as containing sensitive plaintext, not just hashes.
const DATABASE_ID = '67c9ffd9003d68236514';
const PINS_COLLECTION_ID = 'pins';
const VALID_SYSTEMS = ['pos', 'self_checkout', 'ticketing'];
const VALID_ACTIONS = ['create', 'regenerate', 'revoke'];

function generatePin() {
	return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

function hashPin(pin) {
	return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		error('Invalid JSON body: ' + err.message);
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const { action, system, label, pinId } = body;

	if (!VALID_ACTIONS.includes(action)) {
		return res.json({ error: `Invalid action: ${action}. Must be one of ${VALID_ACTIONS.join(', ')}` }, 400);
	}

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	if (action === 'revoke') {
		if (!pinId) {
			return res.json({ error: 'Missing pinId' }, 400);
		}
		try {
			await databases.updateDocument(DATABASE_ID, PINS_COLLECTION_ID, pinId, { active: false });
		} catch (err) {
			error('Failed to revoke pin: ' + err.message);
			return res.json({ error: `Failed to revoke pin: ${err.message}` }, 404);
		}
		log(`Revoked pin ${pinId}`);
		return res.json({ ok: true });
	}

	if (action === 'regenerate') {
		if (!pinId) {
			return res.json({ error: 'Missing pinId' }, 400);
		}
		let existing;
		try {
			existing = await databases.getDocument(DATABASE_ID, PINS_COLLECTION_ID, pinId);
		} catch (err) {
			error('Failed to find pin: ' + err.message);
			return res.json({ error: 'Pin not found' }, 404);
		}

		const pin = generatePin();
		try {
			await databases.updateDocument(DATABASE_ID, PINS_COLLECTION_ID, pinId, { hash: hashPin(pin), pin, active: true });
		} catch (err) {
			error('Failed to regenerate pin: ' + err.message);
			return res.json({ error: `Failed to regenerate pin: ${err.message}` }, 500);
		}
		log(`Regenerated pin ${pinId} (${existing.system}/${existing.label})`);
		return res.json({ pinId, pin, label: existing.label, system: existing.system });
	}

	// action === 'create'
	if (!VALID_SYSTEMS.includes(system)) {
		return res.json({ error: `Invalid system: ${system}. Must be one of ${VALID_SYSTEMS.join(', ')}` }, 400);
	}
	if (!label) {
		return res.json({ error: 'Missing label' }, 400);
	}

	const pin = generatePin();
	let doc;
	try {
		doc = await databases.createDocument(DATABASE_ID, PINS_COLLECTION_ID, 'unique()', {
			system,
			label,
			hash: hashPin(pin),
			pin,
			active: true,
		});
	} catch (err) {
		error('Failed to create pin: ' + err.message);
		return res.json({ error: `Failed to create pin: ${err.message}` }, 500);
	}

	log(`Created ${system} pin "${label}" (${doc.$id})`);
	return res.json({ pinId: doc.$id, pin, label, system });
};
