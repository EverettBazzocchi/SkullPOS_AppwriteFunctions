import { Databases, Users, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Returns one page of transaction documents (every status, not just "complete") for the
// transactions/refund view, newest first. The caller must belong to a till/admin team, and unless
// they are a member of the admin team the window they get is the last 24 hours of *server* time --
// not 24 hours ending wherever they asked. The client has no read access to the Transactions
// collection at all, so these two rules are what make the restriction real for the admin app's
// transaction browser as much as for the POS's own staff view.
//
// The clamp used to be computed as `endDate - 24h` from the caller's own `endDate`, which made it
// a sliding window rather than a limit: one request per day of history walked the entire ledger.
// Both bounds are now derived from Date.now() for a non-admin, so nothing in the request body can
// move the window backwards.
//
// Paginated via `limit`/`cursor` in the request body rather than returning the whole matching
// set in one response -- the admin app lazy-loads pages as the user scrolls instead of pulling
// full transaction history up front.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const ADMIN_TEAM_ID = '68e35aed00144b8cde9d';
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const RESTRICTED_WINDOW_MS = 24 * 60 * 60 * 1000;

// Mirrors what this function's `execute` list should be: the admin team, the POS team, and the
// team Verify-Pin joins a device to once a PIN is accepted. A bare anonymous session -- which is
// what `execute: ["users"]` actually admits, since anonymous sessions are enabled -- belongs to
// none of them.
const ALLOWED_TEAM_IDS = [
	ADMIN_TEAM_ID,
	'68ffcecc0026f78f0af8', // POS
	'6a9cbb1c95ea7d59dd8c', // PIN Payment Access
];

// Fields a non-admin caller may see, as an explicit allowlist rather than the raw document. The
// stored row also carries `member_name`/`member_email` (membership PII), `stripe_id` (the
// PaymentIntent), the encrypted `transaction_data` blob and `bartenderId` -- none of which the POS
// transaction/refund view reads. An allowlist also means an attribute added to the collection
// later is private by default instead of appearing in this response on the next deploy.
const NON_ADMIN_FIELDS = [
	'$id',
	'$createdAt',
	'$updatedAt',
	'status',
	'payment_method',
	'channel',
	'testing',
	'total',
	'tip',
	'discount',
	'payment_due',
	'giftcard_amount',
	'cart',
	'payments',
	'CreatedBy',
];

function projectForNonAdmin(doc) {
	const projected = {};
	for (const key of NON_ADMIN_FIELDS) {
		if (key in doc) projected[key] = doc[key];
	}
	return projected;
}

// Resolves both questions this function asks about the caller from one Users API call: may they
// call it at all, and are they admin (unclamped, unprojected). Only a caller the API positively
// places outside every allowed team is refused -- if the check cannot run (no injected key, or a
// transient failure) this logs loudly and falls back to the execute allowlist at the *non-admin*
// level rather than taking the refund view down mid-event. Neither of those states is
// attacker-reachable: an anonymous caller cannot make listMemberships fail.
async function resolveCaller(req, users, log, error) {
	const callerId = req.headers['x-appwrite-user-id'];
	if (!callerId) {
		// No user session at all -- a direct invocation with a project API key carrying
		// `execution.write`, which bypasses the execute allowlist entirely.
		return { allowed: false, admin: false };
	}
	if (!req.headers['x-appwrite-key']) {
		error('No x-appwrite-key available: cannot verify team membership. Grant this function the users.read scope.');
		return { allowed: true, admin: false };
	}
	try {
		const result = await users.listMemberships(callerId);
		const memberships = (result.memberships || []).filter((m) => m.confirm);
		const allowed = memberships.some((m) => ALLOWED_TEAM_IDS.includes(m.teamId));
		if (!allowed) log(`Caller ${callerId} is in none of the allowed teams`);
		return { allowed, admin: memberships.some((m) => m.teamId === ADMIN_TEAM_ID) };
	} catch (err) {
		error('Failed to check team membership (treating as non-admin): ' + err.message);
		return { allowed: true, admin: false };
	}
}

// `new Date("garbage")` yields an Invalid Date whose toISOString() throws -- outside the try block
// that wraps the query, so it used to surface as an unhandled 500 rather than a 400.
function parseDate(value) {
	if (value === undefined || value === null || value === '') return null;
	const parsed = new Date(value);
	return isNaN(parsed.getTime()) ? undefined : parsed;
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

	const { allowed, admin } = await resolveCaller(req, users, log, error);
	if (!allowed) {
		error('Refused transaction listing from a caller outside the allowed teams.');
		return res.json({ error: 'Unauthorized' }, 403);
	}

	let endDate = parseDate(body.endDate);
	let startDate = parseDate(body.startDate);
	if (endDate === undefined || startDate === undefined) {
		return res.json({ error: 'Invalid startDate or endDate' }, 400);
	}

	if (admin) {
		if (!endDate) endDate = new Date();
		if (!startDate) startDate = new Date(endDate.getTime() - RESTRICTED_WINDOW_MS);
	} else {
		// Absolute, not relative to anything the caller sent: the window is always the 24 hours
		// ending now. A requested endDate can only narrow it (the admin app passes one while
		// paging), never move it into the past, and a requested startDate is ignored outright.
		const now = Date.now();
		const requestedEnd = endDate ? endDate.getTime() : now;
		endDate = new Date(Math.min(requestedEnd, now));
		startDate = new Date(now - RESTRICTED_WINDOW_MS);
		if (endDate.getTime() < startDate.getTime()) {
			endDate = new Date(now);
		}
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
	const raw = hasMore ? fetched.slice(0, limit) : fetched;
	const nextCursor = hasMore ? raw[raw.length - 1].$id : null;
	const documents = admin ? raw : raw.map(projectForNonAdmin);

	log(`Listed ${documents.length} transaction(s) from ${startDate.toISOString()} to ${endDate.toISOString()} (admin: ${admin}, hasMore: ${hasMore})`);
	return res.json({ documents, restricted: !admin, hasMore, nextCursor });
};
