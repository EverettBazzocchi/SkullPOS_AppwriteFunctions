import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Returns a bartender's OWN sales -- called from their own logged-in POS session (an anonymous
// PIN session, same as every other function a bartender pin can reach) so they can see what they
// personally sold and tipped, never anyone else's. This is the only sales-facing read a
// bartender-pin session has access to; it filters by `bartenderId` server-side rather than
// trusting the client to only ever ask for its own id, but there's no ownership proof beyond
// that (a bartender pin session has no way to learn another bartender's id in the first place --
// this mirrors the exposure posture Giftcard-Lookup/Transactions-List already accept for a PIN
// session, not a stronger guarantee). The id is not a secret -- it reaches every POS client via
// checkout.js -- and it cannot be resolved from the session either, because a bartender signs in
// on a shared anonymous PIN session with no user->bartender mapping to check against. So what
// actually has to bound this is the function's execute scope: it belongs to the staff team, not
// to `users` (an Appwrite-side permission change, not a code one).
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const BARTENDERS_COLLECTION_ID = 'bartenders';
const PAGE_SIZE = 100;
// The list of individual sales stays capped -- it is a scroll-back, not a ledger -- but the
// TOTALS are now computed over every matching row, not over that cap. A single capped page was
// being reduced into `salesTotal`/`tipsTotal`/`transactionCount`, so past 200 lifetime sales the
// headline figures silently stopped being totals with nothing on screen saying so, while a
// tip-out is calculated from exactly those figures (POS/src/components/pos/mySalesView.js).
const MAX_LISTED_TRANSACTIONS = 200;

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

	let documents = [];
	try {
		let lastId = null;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const queries = [
				Query.equal('bartenderId', bartenderId),
				Query.equal('status', ['complete', 'refunded']),
				// Every other money report excludes test rows (Sales-Report:238,
				// Admin-RollupEventSales:116) and this one did not, so practice sales rung up on a
				// staging build against the same bartenderId inflated a real person's earnings.
				Query.notEqual('testing', true),
				Query.orderDesc('$createdAt'),
				Query.limit(PAGE_SIZE),
			];
			if (lastId) queries.push(Query.cursorAfter(lastId));

			const page = await databases.listDocuments(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, queries);
			const docs = page.documents || [];
			documents = documents.concat(docs);

			if (docs.length < PAGE_SIZE) break;
			lastId = docs[docs.length - 1].$id;
		}
	} catch (err) {
		error('Failed to query transactions: ' + err.message);
		return res.json({ error: 'Failed to load sales' }, 500);
	}

	// Only completed sales count toward the totals -- a refunded one still shows up in the list
	// (marked as such) but isn't counted as money the bartender actually brought in.
	const completed = documents.filter((doc) => doc.status === 'complete');
	const salesTotal = completed.reduce((sum, doc) => sum + (parseInt(doc.total) || 0), 0);
	const tipsTotal = completed.reduce((sum, doc) => sum + (parseInt(doc.tip) || 0), 0);

	const transactions = documents.slice(0, MAX_LISTED_TRANSACTIONS).map((doc) => ({
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
		// The totals above always cover everything; this says only that the LIST below was cut
		// short, so a caller can show "showing the most recent 200" instead of implying it is all.
		listTruncated: documents.length > MAX_LISTED_TRANSACTIONS,
	});
};
