import { Databases, Users, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Returns raw transaction documents (every status, not just "complete")
// for the transactions/refund view. The requested date range is clamped
// to the last 24 hours UNLESS the caller is a member of the admin team --
// checked the same way Sales-Report already does, via the Users API
// against req.headers['x-appwrite-user-id'] (Appwrite-verified, can't be
// spoofed by the client). The client has no read access to Transactions
// at all, so this clamp is what makes the restriction real for the new
// admin app's transaction browser as much as for the POS's own staff view.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const ADMIN_TEAM_ID = '68e35aed00144b8cde9d';
const PAGE_SIZE = 100;

async function isAdmin(users, callerId, error) {
	if (!callerId) return false;
	try {
		const result = await users.listMemberships(callerId);
		return (result.memberships || []).some((m) => m.teamId === ADMIN_TEAM_ID && m.confirm);
	} catch (err) {
		error('Failed to check team membership (treating as non-admin): ' + err.message);
		return false;
	}
}

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

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);
	const users = new Users(client);

	const callerId = req.headers['x-appwrite-user-id'];
	const admin = await isAdmin(users, callerId, error);

	let endDate = body.endDate ? new Date(body.endDate) : new Date();
	let startDate = body.startDate ? new Date(body.startDate) : null;

	const earliestAllowed = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
	if (!admin && (!startDate || startDate < earliestAllowed)) {
		startDate = earliestAllowed;
	}
	if (!startDate) {
		startDate = earliestAllowed;
	}

	let docs;
	try {
		docs = await fetchAllDocuments(databases, DATABASE_ID, TRANSACTIONS_COLLECTION_ID, [
			test ? Query.equal('testing', true) : Query.notEqual('testing', true),
			Query.greaterThanEqual('$createdAt', startDate.toISOString()),
			Query.lessThanEqual('$createdAt', endDate.toISOString()),
		]);
	} catch (err) {
		error('Failed to list transactions: ' + err.message);
		return res.json({ error: 'Failed to list transactions' }, 500);
	}

	docs.sort((a, b) => new Date(b.$createdAt) - new Date(a.$createdAt));

	log(`Listed ${docs.length} transactions from ${startDate.toISOString()} to ${endDate.toISOString()} (admin: ${admin})`);
	return res.json({ documents: docs, restricted: !admin });
};
