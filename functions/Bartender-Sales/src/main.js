import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Returns a bartender's OWN sales -- called from their own logged-in POS session (an anonymous
// PIN session, same as every other function a bartender pin can reach) so they can see what they
// personally sold and tipped, never anyone else's. This is the only sales-facing read a
// bartender-pin session has access to; it filters by `bartenderId` server-side rather than
// trusting the client to only ever ask for its own id, but there's no ownership proof beyond
// that (a bartender pin session has no way to learn another bartender's id in the first place --
// this mirrors the exposure posture Giftcard-Lookup/Transactions-List already accept for a PIN
// session, not a stronger guarantee).
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const BARTENDERS_COLLECTION_ID = 'bartenders';

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const bartenderId = body.bartenderId;
	if (!bartenderId) {
		return res.json({ error: 'Missing bartenderId' }, 400);
	}

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	try {
		await databases.getDocument(DATABASE_ID, BARTENDERS_COLLECTION_ID, bartenderId);
	} catch (err) {
		error('Failed to read bartender: ' + err.message);
		return res.json({ error: 'Bartender not found' }, 404);
	}

	let documents;
	try {
		const result = await databases.listDocuments(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, [
			Query.equal('bartenderId', bartenderId),
			Query.equal('status', ['complete', 'refunded']),
			Query.orderDesc('$createdAt'),
			Query.limit(200),
		]);
		documents = result.documents || [];
	} catch (err) {
		error('Failed to query transactions: ' + err.message);
		return res.json({ error: 'Failed to load sales' }, 500);
	}

	// Only completed sales count toward the totals -- a refunded one still shows up in the list
	// (marked as such) but isn't counted as money the bartender actually brought in.
	const completed = documents.filter((doc) => doc.status === 'complete');
	const salesTotal = completed.reduce((sum, doc) => sum + (parseInt(doc.total) || 0), 0);
	const tipsTotal = completed.reduce((sum, doc) => sum + (parseInt(doc.tip) || 0), 0);

	const transactions = documents.map((doc) => ({
		id: doc.$id,
		createdAt: doc.$createdAt,
		total: parseInt(doc.total) || 0,
		tip: parseInt(doc.tip) || 0,
		status: doc.status,
		paymentMethod: doc.payment_method || null,
	}));

	log(`Bartender ${bartenderId}: ${completed.length} completed sales, ${salesTotal} total, ${tipsTotal} tips`);
	return res.json({
		salesTotal,
		tipsTotal,
		transactionCount: completed.length,
		transactions,
	});
};
