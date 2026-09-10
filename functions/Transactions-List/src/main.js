import { Databases, Users, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Returns one page of raw transaction documents (every status, not just "complete") for the
// transactions/refund view, newest first. The requested date range is clamped to the last 24
// hours UNLESS the caller is a member of the admin team -- checked the same way Sales-Report
// already does, via the Users API against req.headers['x-appwrite-user-id'] (Appwrite-verified,
// can't be spoofed by the client). The client has no read access to Transactions at all, so this
// clamp is what makes the restriction real for the admin app's transaction browser as much as
// for the POS's own staff view.
//
// Paginated via `limit`/`cursor` in the request body rather than returning the whole matching
// set in one response -- the admin app lazy-loads pages as the user scrolls instead of pulling
// full transaction history up front.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const ADMIN_TEAM_ID = '68e35aed00144b8cde9d';
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

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

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const test = !!body.test;
	const limit = Math.min(Math.max(parseInt(body.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
	const cursor = body.cursor || null;

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

	// Fetch one extra document beyond the page size -- its presence (or absence) tells us
	// whether there's a next page without a separate count query.
	const queries = [
		test ? Query.equal('testing', true) : Query.notEqual('testing', true),
		Query.greaterThanEqual('$createdAt', startDate.toISOString()),
		Query.lessThanEqual('$createdAt', endDate.toISOString()),
		Query.orderDesc('$createdAt'),
		Query.limit(limit + 1),
	];
	if (cursor) queries.push(Query.cursorAfter(cursor));

	let page;
	try {
		page = await databases.listDocuments(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, queries);
	} catch (err) {
		error('Failed to list transactions: ' + err.message);
		return res.json({ error: 'Failed to list transactions' }, 500);
	}

	const fetched = page.documents || [];
	const hasMore = fetched.length > limit;
	const documents = hasMore ? fetched.slice(0, limit) : fetched;
	const nextCursor = hasMore ? documents[documents.length - 1].$id : null;

	log(`Listed ${documents.length} transaction(s) from ${startDate.toISOString()} to ${endDate.toISOString()} (admin: ${admin}, hasMore: ${hasMore})`);
	return res.json({ documents, restricted: !admin, hasMore, nextCursor });
};
