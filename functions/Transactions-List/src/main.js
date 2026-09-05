import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Returns raw transaction documents (every status, not just "complete")
// from the last 24 hours -- always, regardless of caller -- for the
// transactions/refund view. This range is fixed server-side (not
// client-adjustable) rather than gated by team membership, since the UI
// never offers a wider range to anyone; the client has no read access to
// Transactions at all, so this is the only way to see this list.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const PAGE_SIZE = 100;

async function fetchAllDocuments(databases, databaseId, collectionId, extraQueries = []) {
	let allDocuments = [];
	let lastId = null;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const queries = [...extraQueries, Query.orderAsc('$id'), Query.limit(PAGE_SIZE)];
		if (lastId) queries.push(Query.cursorAfter(lastId));

		const page = await databases.listDocuments(databaseId, collectionId, queries);
		const docs = page.documents || [];
		allDocuments = allDocuments.concat(docs);

		if (docs.length < PAGE_SIZE) break;
		lastId = docs[docs.length - 1].$id;
	}

	return allDocuments;
}

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const test = !!body.test;
	const now = new Date();
	const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	let docs;
	try {
		docs = await fetchAllDocuments(databases, DATABASE_ID, TRANSACTIONS_COLLECTION_ID, [
			test ? Query.equal('testing', true) : Query.notEqual('testing', true),
			Query.greaterThanEqual('$createdAt', start.toISOString()),
			Query.lessThanEqual('$createdAt', now.toISOString()),
		]);
	} catch (err) {
		error('Failed to list transactions: ' + err.message);
		return res.json({ error: 'Failed to list transactions' }, 500);
	}

	docs.sort((a, b) => new Date(b.$createdAt) - new Date(a.$createdAt));

	log(`Listed ${docs.length} transactions from the last 24 hours`);
	return res.json({ documents: docs });
};
