import { Users, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Runs weekly (see appwrite.config.json's schedule) to permanently delete anonymous user
// accounts that haven't been active in 90+ days. POS/self-checkout create one anonymous
// account per device the first time its PIN is used (see POS/src/utils/api.js's
// loginWithPin() -- "Ensures an anonymous session exists first ... so the device has
// 'users'-level permission to create transactions"), and these accumulate indefinitely
// otherwise, e.g. from retired kiosks/devices that never come back.
//
// Only ever touches TRUE anonymous accounts (no email AND no phone) -- every real login
// (Google-authenticated staff/admin, the shared Ticketing door-staff account) has an email,
// so this can never delete a real, named account regardless of how long it's been inactive.
//
// Also callable directly (admin-team execute permission) for manual/testing runs, but the
// primary trigger is the schedule.
const INACTIVE_DAYS = 90;
const PAGE_SIZE = 100;

function isAnonymous(user) {
	return !user.email && !user.phone;
}

async function listAllUsers(users) {
	let all = [];
	let lastId = null;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const queries = [Query.orderAsc('$id'), Query.limit(PAGE_SIZE)];
		if (lastId) queries.push(Query.cursorAfter(lastId));

		const page = await users.list(queries);
		const batch = page.users || [];
		all = all.concat(batch);

		if (batch.length < PAGE_SIZE) break;
		lastId = batch[batch.length - 1].$id;
	}

	return all;
}

export default async ({ req, res, log, error }) => {
	const client = await createAppwriteClient(req);
	const users = new Users(client);

	const cutoff = new Date(Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000);

	let allUsers;
	try {
		allUsers = await listAllUsers(users);
	} catch (err) {
		error('Failed to list users: ' + err.message);
		return res.json({ error: 'Failed to list users' }, 500);
	}

	const staleAnonymousUsers = allUsers.filter((user) => {
		if (!isAnonymous(user)) return false;
		const lastActive = new Date(user.accessedAt || user.$updatedAt || user.$createdAt);
		return lastActive < cutoff;
	});

	let deleted = 0;
	const failures = [];

	for (const user of staleAnonymousUsers) {
		try {
			await users.delete(user.$id);
			deleted++;
		} catch (err) {
			error(`Failed to delete user ${user.$id}: ` + err.message);
			failures.push({ userId: user.$id, error: err.message });
		}
	}

	log(`Purged ${deleted}/${staleAnonymousUsers.length} stale anonymous user(s) (inactive ${INACTIVE_DAYS}+ days, of ${allUsers.length} total users checked).`);

	return res.json({
		totalUsersChecked: allUsers.length,
		staleAnonymousFound: staleAnonymousUsers.length,
		deleted,
		failures,
	});
};
