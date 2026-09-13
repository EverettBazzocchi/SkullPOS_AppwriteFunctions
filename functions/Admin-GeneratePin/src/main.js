import crypto from 'crypto';
import { Databases, Query } from 'node-appwrite';
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
// Bartender pins live in their own collection but authenticate through the same Verify-Pin
// against the same 10,000-value namespace, so a candidate has to be checked against both.
const BARTENDERS_COLLECTION_ID = 'bartenders';
const VALID_SYSTEMS = ['pos', 'self_checkout', 'ticketing'];
const VALID_ACTIONS = ['create', 'regenerate', 'revoke'];
// 4 digits is only 10,000 values and both pools draw from it. Bounded so a (currently
// impossible) near-full namespace fails loudly instead of spinning until the 15s timeout.
const MAX_PIN_ATTEMPTS = 12;

function generatePin() {
	return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

// Exported so a test can pin the exact digest convention against a golden vector. Verify-Pin,
// quick-access-login and SkullAdminApp each hold their own copy of this expression; if any one
// of them drifts, every credential it issued stops verifying, with "Incorrect PIN" as the only
// symptom. The value, not just the shape, is what has to be asserted.
export function hashPin(pin) {
	return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

// True if any row in either pin pool already carries this hash. Deliberately not filtered on
// `active`: revocation only writes `{ active: false }` and leaves `hash` in place, so an
// inactive row can be re-armed later and would then collide retroactively.
async function hashIsTaken(databases, hash, excludePinId) {
	const [pins, bartenders] = await Promise.all([
		databases.listDocuments(DATABASE_ID, PINS_COLLECTION_ID, [Query.equal('hash', hash), Query.limit(2)]),
		databases.listDocuments(DATABASE_ID, BARTENDERS_COLLECTION_ID, [Query.equal('hash', hash), Query.limit(1)]),
	]);
	const pinRows = (pins.documents || []).filter((doc) => doc.$id !== excludePinId);
	return pinRows.length > 0 || (bartenders.documents || []).length > 0;
}

// Verify-Pin matches on `hash` alone (after a system/active filter), so two rows sharing a hash
// means the wrong row wins -- a bartender pin that collides with a `pos` pin authenticates as
// the pos pin, losing her sales attribution and skipping the event-window check entirely.
// Re-roll until the candidate is unique across both pools.
async function generateUniquePin(databases, excludePinId) {
	for (let attempt = 0; attempt < MAX_PIN_ATTEMPTS; attempt += 1) {
		const pin = generatePin();
		const hash = hashPin(pin);
		if (!(await hashIsTaken(databases, hash, excludePinId))) return { pin, hash };
	}
	throw new Error(`Could not find an unused pin after ${MAX_PIN_ATTEMPTS} attempts`);
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

		let pin;
		let hash;
		try {
			// The row being regenerated is excluded -- re-rolling onto its own current hash is a
			// no-op collision, not a clash with another credential.
			({ pin, hash } = await generateUniquePin(databases, pinId));
		} catch (err) {
			error('Failed to generate a unique pin: ' + err.message);
			return res.json({ error: 'Failed to generate a unique pin' }, 500);
		}

		try {
			await databases.updateDocument(DATABASE_ID, PINS_COLLECTION_ID, pinId, { hash, pin, active: true });
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

	let pin;
	let hash;
	try {
		({ pin, hash } = await generateUniquePin(databases));
	} catch (err) {
		error('Failed to generate a unique pin: ' + err.message);
		return res.json({ error: 'Failed to generate a unique pin' }, 500);
	}

	let doc;
	try {
		doc = await databases.createDocument(DATABASE_ID, PINS_COLLECTION_ID, 'unique()', {
			system,
			label,
			hash,
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
