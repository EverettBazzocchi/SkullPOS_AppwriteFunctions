import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Looks up a giftcard by its UPC/code server-side, so the client never
// needs read access to the giftcards collection (which would otherwise let
// any session -- anonymous quick-access PIN sessions included -- list
// every giftcard code and balance in the system).
const DATABASE_ID = '67c9ffd9003d68236514';
const GIFTCARDS_COLLECTION_ID = 'giftcards';

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
		return res.json({ found: false });
	}

	log('Giftcard found: ' + found.$id);
	return res.json({ found: true, id: found.$id, balance: found.balance || 0 });
};
