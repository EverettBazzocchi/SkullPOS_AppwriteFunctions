#!/usr/bin/env node
/**
 * ONE-OFF BACKFILL -- sets `tickets.eventId` on the ticket rows that were written before anything
 * populated it. Read this header before running it.
 *
 *   node AppwriteFunctions/functions/_scripts/backfill-ticket-event-ids.js                    # dry run (default)
 *   node AppwriteFunctions/functions/_scripts/backfill-ticket-event-ids.js --apply
 *   node AppwriteFunctions/functions/_scripts/backfill-ticket-event-ids.js --apply --expect-updates=202
 *
 * It lives under functions/_scripts/ rather than beside a function because it is NOT a function --
 * nothing in appwrite.config.json points here, so it is never deployed or executed by Appwrite. The
 * underscore is the marker; the location is what puts its decision rules
 * (backfill-ticket-event-ids.test.js) inside the repo's existing `npm test` run.
 *
 * WHAT IT DOES
 *
 * `tickets` carries the event as free text in `eventName`, and every reader re-matches that against
 * `Events.name` on every read -- so renaming an event orphans its tickets. `tickets.eventId`
 * (string 255, optional) and its `idx_event_id` key index exist live and were empty on all 204 rows
 * as of 2026-09-13. The three writers now resolve the name to an `Events.$id` once, at write time.
 * This script does the same for the rows that already exist.
 *
 * RULES IT WILL NOT BREAK
 *
 *  - EXACT NAME MATCHES ONLY. No trimming-into-a-match, no case folding, no fuzzy matching. A wrong
 *    id silently moves that ticket's revenue onto another event in the rollup, which is worse than
 *    no id at all.
 *  - A name that matches NO event, or MORE THAN ONE event, is reported and skipped. It never guesses.
 *  - Rows that already carry an eventId are skipped untouched, so the script is idempotent and safe
 *    to run twice, or to re-run after a partial failure. A second run plans zero updates.
 *  - It only ever writes the single `eventId` field. `eventName` is left exactly as it is -- readers
 *    still key off the name and must keep working mid-migration -- and nothing is ever deleted.
 *  - Dry run is the default. Writing requires `--apply` typed on purpose.
 *
 * `--expect-updates=N` is a tripwire for the supervised first run: if the number of rows the script
 * plans to update is not exactly N, it stops before writing anything. Take N from the dry run you
 * just read. (As of 2026-09-13 the dry run should report 107 for 'HAX 7.0 EDM Community Night',
 * 95 for 'Everetts Test event ignopre', and 2 rows unmatched -- 'Door Sales' and
 * 'Idempotency Test Event', neither of which has an event record and neither of which ever will.
 * Anything else means the data moved and a human should look before a single row is written.)
 *
 * CREDENTIALS -- an API key with `documents.read` and `documents.write`, passed by environment
 * variable, never on the command line (the shell history is not the place for it):
 *
 *   APPWRITE_API_KEY     required
 *   APPWRITE_ENDPOINT    default https://api.cloud.shotty.tech/v1
 *   APPWRITE_PROJECT_ID  default 68f2ac7b00002e7563a8
 *
 * No npm install: this talks to the Appwrite REST API with the built-in fetch (Node 18+), because
 * none of the functions in this repo are npm-installed locally.
 */

const ENDPOINT = (process.env.APPWRITE_ENDPOINT || 'https://api.cloud.shotty.tech/v1').replace(/\/$/, '');
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || '68f2ac7b00002e7563a8';
const API_KEY = process.env.APPWRITE_API_KEY || '';

const DATABASE_ID = '67c9ffd9003d68236514';
const TICKETS_COLLECTION_ID = 'tickets';
const EVENTS_COLLECTION_ID = '68e400210008d19bb5c9';

const PAGE_SIZE = 100;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const expectArg = args.find((a) => a.startsWith('--expect-updates='));
const EXPECT_UPDATES = expectArg ? Number(expectArg.split('=')[1]) : null;

function die(message) {
	console.error(`\nABORTED: ${message}\n`);
	process.exit(1);
}

async function appwrite(method, path, body) {
	const res = await fetch(`${ENDPOINT}${path}`, {
		method,
		headers: {
			'X-Appwrite-Project': PROJECT_ID,
			'X-Appwrite-Key': API_KEY,
			'Content-Type': 'application/json',
		},
		body: body ? JSON.stringify(body) : undefined,
	});

	const text = await res.text();
	let parsed = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		/* fall through to the raw text in the error below */
	}

	if (!res.ok) {
		const detail = (parsed && parsed.message) || text || '(no body)';
		const err = new Error(`${method} ${path} -> ${res.status}: ${detail}`);
		err.status = res.status;
		throw err;
	}
	return parsed;
}

/**
 * Pages a whole collection with an $id cursor. Deliberately NOT `Query.isNull('eventId')`: paging
 * everything and deciding in JS means the "already has one" test is a plain string check that also
 * catches an empty string, and the script's behaviour does not depend on how the API treats an
 * unset optional attribute.
 */
async function listAll(collectionId) {
	const all = [];
	let cursor = null;

	for (;;) {
		const queries = [
			JSON.stringify({ method: 'orderAsc', attribute: '$id' }),
			JSON.stringify({ method: 'limit', values: [PAGE_SIZE] }),
		];
		if (cursor) queries.push(JSON.stringify({ method: 'cursorAfter', values: [cursor] }));

		const qs = queries.map((q) => `queries[]=${encodeURIComponent(q)}`).join('&');
		const page = await appwrite('GET', `/databases/${DATABASE_ID}/collections/${collectionId}/documents?${qs}`);
		const batch = (page && page.documents) || [];
		all.push(...batch);

		if (batch.length < PAGE_SIZE) return all;
		cursor = batch[batch.length - 1].$id;
	}
}

function hasEventId(ticket) {
	return typeof ticket.eventId === 'string' && ticket.eventId.trim() !== '';
}

function buildEventIdsByName(events) {
	const eventIdsByName = new Map();
	for (const event of events) {
		const name = typeof event.name === 'string' ? event.name : '';
		if (!name) continue;
		if (!eventIdsByName.has(name)) eventIdsByName.set(name, []);
		eventIdsByName.get(name).push(event.$id);
	}
	return eventIdsByName;
}

/**
 * The whole decision -- deliberately pure, with no network in it, so every rule below is covered by
 * backfill-ticket-event-ids.test.js rather than only ever exercised against the live collection.
 *
 * Returns what WOULD be written; the caller decides whether to write it.
 */
function planBackfill(tickets, events) {
	const eventIdsByName = buildEventIdsByName(events);

	const planned = []; // { ticket, eventId }
	const skippedAlreadySet = [];
	const byName = new Map(); // eventName -> { total, willUpdate, alreadySet, verdict }

	function bucket(name) {
		if (!byName.has(name)) byName.set(name, { total: 0, willUpdate: 0, alreadySet: 0, verdict: '' });
		return byName.get(name);
	}

	for (const ticket of tickets) {
		const name = typeof ticket.eventName === 'string' ? ticket.eventName : '';
		const row = bucket(name || '(no eventName)');
		row.total++;

		// Idempotency lives here: a row that already carries an id is never re-derived, never
		// overwritten, and never re-sent -- so a second run plans nothing and a re-run after a
		// partial failure retries only what is still missing.
		if (hasEventId(ticket)) {
			row.alreadySet++;
			row.verdict = row.verdict || 'already has an eventId -- skipped';
			skippedAlreadySet.push(ticket.$id);
			continue;
		}

		if (!name) {
			row.verdict = 'NO EVENT NAME -- skipped, nothing to resolve';
			continue;
		}

		const matches = eventIdsByName.get(name) || [];
		if (matches.length === 1) {
			row.verdict = `-> ${matches[0]}`;
			row.willUpdate++;
			planned.push({ ticket, eventId: matches[0] });
		} else if (matches.length === 0) {
			row.verdict = 'NO MATCHING EVENT -- skipped, not guessed';
		} else {
			row.verdict = `AMBIGUOUS: ${matches.length} events share this name (${matches.join(', ')}) -- skipped, not guessed`;
		}
	}

	return {
		planned,
		skippedAlreadySet,
		byName,
		unresolved: tickets.length - planned.length - skippedAlreadySet.length,
	};
}

async function main() {
	if (!API_KEY) die('APPWRITE_API_KEY is not set. It needs documents.read and documents.write.');
	if (expectArg && !Number.isInteger(EXPECT_UPDATES)) die(`--expect-updates must be a whole number, got "${expectArg}".`);

	console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}  endpoint=${ENDPOINT}  project=${PROJECT_ID}`);

	const events = await listAll(EVENTS_COLLECTION_ID);
	console.log(`Loaded ${events.length} event(s), ${buildEventIdsByName(events).size} distinct name(s).`);

	const tickets = await listAll(TICKETS_COLLECTION_ID);
	console.log(`Loaded ${tickets.length} ticket(s).\n`);

	const { planned, skippedAlreadySet, byName, unresolved } = planBackfill(tickets, events);

	console.log('eventName                                          rows  toUpdate  resolution');
	console.log('-'.repeat(110));
	for (const [name, row] of [...byName.entries()].sort((a, b) => b[1].total - a[1].total)) {
		console.log(`${name.slice(0, 48).padEnd(50)} ${String(row.total).padStart(5)} ${String(row.willUpdate).padStart(9)}  ${row.verdict}`);
	}

	console.log('-'.repeat(110));
	console.log(`\n${planned.length} ticket(s) to update, ${skippedAlreadySet.length} already had an eventId, ${unresolved} left unresolved.`);

	if (EXPECT_UPDATES !== null && planned.length !== EXPECT_UPDATES) {
		die(`--expect-updates=${EXPECT_UPDATES} but ${planned.length} row(s) would be updated. Nothing was written. Re-read the table above.`);
	}

	if (!APPLY) {
		console.log('\nDry run -- nothing was written. Re-run with --apply once the table above looks right.');
		return;
	}

	let updated = 0;
	const failures = [];
	for (const { ticket, eventId } of planned) {
		try {
			// Only this one field. eventName is deliberately not in the payload.
			await appwrite('PATCH', `/databases/${DATABASE_ID}/collections/${TICKETS_COLLECTION_ID}/documents/${ticket.$id}`, {
				data: { eventId },
			});
			updated++;
		} catch (err) {
			failures.push({ id: ticket.$id, eventName: ticket.eventName, error: err.message });
		}
	}

	console.log(`\nUpdated ${updated} of ${planned.length} ticket(s).`);
	if (failures.length > 0) {
		console.error(`${failures.length} failed:`);
		for (const f of failures) console.error(`  ${f.id} (${f.eventName}): ${f.error}`);
		// Re-running is safe: the rows that succeeded now carry an eventId and will be skipped.
		die('Some updates failed. Fix the cause and run the script again -- it will only retry what is still missing.');
	}
	console.log('Done. Run again (dry) to confirm it now plans zero updates.');
}

// Only actually runs when a human invokes the file. Requiring it (the test does) just hands back
// the pure planner -- importing this script must never start talking to the live project.
if (require.main === module) {
	main().catch((err) => die(err.stack || err.message));
}

module.exports = { planBackfill, buildEventIdsByName, hasEventId };
