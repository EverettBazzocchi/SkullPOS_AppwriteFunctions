import { Databases } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Toggles one boolean visibility flag on a menu item, server-side. `field`
// is restricted to this exact allowlist -- these are the ONLY fields this
// function will ever touch -- the client has no write access to pos_items
// at all (removed alongside the rest of the POS PIN-system security
// plan), since a blanket update grant would let any session, anonymous
// quick-access PIN sessions included, change ANY field on ANY item
// directly (price, alcohol flag, etc.) -- e.g. reprice a bottle to a cent
// and ring up unlimited cheap sales. Unlike Transactions/giftcards
// there's no natural "creator" to scope a document permission to (items
// are shared, pre-existing catalog rows a cashier didn't create), so this
// is a narrow single-purpose function instead.
const DATABASE_ID = '67c9ffd9003d68236514';
const ITEMS_COLLECTION_ID = 'pos_items';
const ALLOWED_FIELDS = ['enabled_menu', 'enabled_pos'];
const DEFAULT_FIELD = 'enabled_menu';

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const itemId = body.itemId;
	const enabled = body.enabled;
	const field = body.field || DEFAULT_FIELD;
	if (!itemId || typeof enabled !== 'boolean') {
		return res.json({ error: 'Missing itemId or enabled (boolean)' }, 400);
	}
	if (!ALLOWED_FIELDS.includes(field)) {
		return res.json({ error: `field must be one of: ${ALLOWED_FIELDS.join(', ')}` }, 400);
	}

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	try {
		await databases.updateDocument(DATABASE_ID, ITEMS_COLLECTION_ID, itemId, {
			[field]: enabled,
		});
	} catch (err) {
		error('Failed to update item: ' + err.message);
		return res.json({ error: 'Item not found or failed to update' }, 404);
	}

	log(`Item ${itemId} ${field} set to ${enabled}`);
	return res.json({ ok: true, enabled });
};
