import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { decideActiveEvent, LEAD_MS, GRACE_MS } from './decideActiveEvent.js';

// Maintains `Events.isActive` on a schedule, so that exactly one event carries it and it is the
// right one. That flag is the single choke point the whole floor reads through: the register, both
// wall-mounted menu boards and the door app all resolve the active event through
// Ticketing-ActiveEvent, which serves whichever row has it. Until this function existed NOTHING on
// the server ever wrote it -- the only writers were a human ticking "Active event" in the admin
// app's event form and the deactivateOtherEvents() sweep that runs immediately after that save --
// so somebody had to remember, and when they didn't, the floor pointed at whatever was ticked last.
// It was pointing at a test event whose bar window had closed three days earlier when this was
// written.
//
// THIS FILE DOES I/O AND REPORTING ONLY. Every rule lives in decideActiveEvent.js as a pure
// function of (rows, now) -- read it first; the reasoning for the six-hour lead, the four-hour
// grace, the comparator, the refusals and the sweep guard is all there, and all of it is
// table-tested with no SDK in sight.
const DATABASE_ID = '67c9ffd9003d68236514';
const EVENTS_COLLECTION_ID = '68e400210008d19bb5c9';
const PAGE_SIZE = 100;

// THE BLUNT KILL SWITCH, read fresh on every run so it takes effect without a redeploy.
//
// DEFAULT IS APPLY. Unset, blank, or any value nobody deliberately chose means the function runs
// normally. That polarity is the whole point: a config typo must never silently disable the
// automation on the night of a paying event. The inverse ("only the literal string 'on' enables
// it") is a trap that turns a missing variable into a dead autopilot, which is exactly the failure
// this function exists to remove.
//
// Set it to `report` in the Appwrite console and the run computes the full decision, logs exactly
// what it would have done, and writes nothing. Twenty seconds, no redeploy, reversible, and
// talkable-through over the phone to a bartender. The mode is echoed on every run's log line, so a
// suspended autopilot is visible in the Executions view rather than mistaken for a working one.
const AUTOPILOT_VARIABLE = 'ACTIVE_EVENT_AUTOPILOT';
const REPORT_ONLY = 'report';

// Paged exactly like Admin-RollupEventSales' fetchAllDocuments, and for the same reason the rollup
// does it: the collection is small today and this must not quietly start missing rows if it isn't.
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

function resolveMode(log) {
	const raw = process.env[AUTOPILOT_VARIABLE];
	if (raw === undefined || raw === null || raw.trim() === '') return 'apply';
	const value = raw.trim().toLowerCase();
	if (value === REPORT_ONLY) return REPORT_ONLY;
	if (value === 'apply') return 'apply';
	// Fails open, loudly. An operator who typed "reprot" gets a working autopilot and a line telling
	// them why their kill switch did nothing, rather than a dark floor and no explanation.
	log(`${AUTOPILOT_VARIABLE} is set to "${raw}", which is not "report" or "apply" -- applying changes as normal.`);
	return 'apply';
}

export default async ({ req, res, log, error }) => {
	const mode = resolveMode(log);

	// ONE CLOCK for the whole run, captured before the read and threaded through every comparison.
	// Never Date.now() twice -- a run that straddled a boundary could otherwise decide to activate
	// and deactivate the same row.
	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	let events;
	try {
		// NO SERVER-SIDE FILTER, on purpose, and this is not a style choice.
		//
		// `Query.equal('isActive', true)` would hide exactly the rows this function has to reason
		// about (the candidate it should activate), and `Query.notEqual('testing', true)` is the
		// trap already documented twice in this repo -- a SQL inequality silently drops NULL rows,
		// which cost the rollup its legacy `channel` sales and cost Ticketing-ActiveEvent its
		// pre-attribute events. The collection also carries exactly ONE index and it is a fulltext
		// index on `name` (verified read-only, 2026-09-13), so no filter here is index-assisted
		// anyway. Over three rows a filter buys nothing and costs the ability to SEE and report the
		// rows it excluded -- which is half of what this function is for.
		events = await fetchAllDocuments(databases, DATABASE_ID, EVENTS_COLLECTION_ID);
	} catch (err) {
		// FAIL SAFE: an unreadable collection changes nothing. Whatever is on the floor stays on the
		// floor, which is always better than guessing at it.
		error('Failed to list events, so the active event was left exactly as it is: ' + err.message);
		return res.json({ error: 'Failed to list events' }, 500);
	}

	const decision = decideActiveEvent(events, nowMs);
	decision.reports.forEach((entry) => (entry.level === 'error' ? error(entry.message) : log(entry.message)));

	const describe = (doc) => `"${doc.name}" (${doc.$id})`;
	const summary = {
		mode,
		now: nowIso,
		leadHours: LEAD_MS / 3600000,
		graceHours: GRACE_MS / 3600000,
		eventsRead: events.length,
		incumbents: decision.incumbents,
		blockers: decision.blockers,
		candidates: decision.candidates,
		unscheduled: decision.unscheduled,
		unreadable: decision.unreadable,
		ambiguous: decision.ambiguous,
		heldBack: decision.heldBack,
		// Non-null only when the run refused because the container clock is behind the newest
		// $updatedAt in the rows it just read. It has to reach the BODY as well as the Errors view:
		// without it a refusal is byte-identical to a healthy quiet run, and "the autopilot is doing
		// nothing" is the exact symptom this function exists to make impossible to misread.
		clockSkewMs: decision.clockSkewMs,
	};

	// The line a human reads in the Executions view. It has to reconstruct the decision WITHOUT the
	// data, because by the time anybody looks the rows have moved on -- so it names the row that
	// should hold the floor, the ones that qualified, and the ones that got in the way.
	const decisionLine =
		`[${mode}] now=${nowIso} read=${events.length} ` +
		`intended=${decision.intended ? describe(decision.intended) : 'none'} ` +
		`candidates=${decision.candidates.length ? decision.candidates.map((c) => `${c.name}[${c.state}]`).join(', ') : 'none'} ` +
		`incumbents=${decision.incumbents.length} blockers=${decision.blockers.length} ` +
		`willActivate=${decision.activate ? describe(decision.activate) : 'none'} ` +
		`willDeactivate=${decision.deactivate.length ? decision.deactivate.map(describe).join(', ') : 'none'}`;
	log(decisionLine);

	if (mode === REPORT_ONLY) {
		log(
			`${AUTOPILOT_VARIABLE}=report -- the autopilot is SUSPENDED and this run wrote nothing. ` +
				'Clear the variable (or set it to "apply") in the Appwrite console to re-enable it; no redeploy needed.',
		);
		return res.json({
			...summary,
			wouldActivate: decision.activate ? decision.activate.$id : null,
			wouldDeactivate: decision.deactivate.map((doc) => doc.$id),
			activated: null,
			deactivated: [],
			failures: [],
		});
	}

	// ZERO WRITES when the desired state already holds -- the common case on a Tuesday, and the
	// common case on event night once either the operator or a previous run has picked the right
	// row.
	if (!decision.activate && decision.deactivate.length === 0) {
		// Three different reasons to write nothing, and they must not read the same in the log.
		// "Nothing qualifies" is a healthy Tuesday; a refused run is not, and saying the healthy
		// sentence over a clock fault or an ambiguous collection is how a suspended autopilot gets
		// mistaken for a working one -- the error() lines above have already been emitted, but the
		// line a human skims is this one.
		log(
			decision.clockSkewMs !== null
				? 'Nothing was changed: the container clock is not trustworthy enough to decide (see the error above).'
				: decision.intended
					? `Nothing to do: ${describe(decision.intended)} already holds the floor.`
					: decision.ambiguous || decision.heldBack
						? 'Nothing was changed: the run refused rather than guess (see the error above).'
						: 'Nothing to do: no event qualifies right now and nothing stale is active.',
		);
		return res.json({ ...summary, activated: null, deactivated: [], failures: [] });
	}

	// ---- ORDERING IS LOAD-BEARING: ACTIVATE FIRST, DEACTIVATE SECOND ------------------------------
	// The transient between the two writes is "two rows active", never "zero rows active". Zero
	// active mid-event is the dark floor this function exists to prevent: the register hides every
	// alcohol item, both boards go generic, and the door drops to the CA$30 default.
	//
	// Two active is already survivable downstream, but ONLY because of a behaviour this function
	// does not own: Ticketing-ActiveEvent orders active rows `orderDesc('$updatedAt')`, so the row
	// written here is by definition the one served, and its pickActiveEvent independently steps past
	// `testing === true`. THAT COUPLING IS COMMENTED IN BOTH FILES. Anyone who "tidies up" that
	// order clause silently breaks the safety of this ordering.
	let activated = null;
	if (decision.activate) {
		try {
			// EXACTLY ONE KEY, never an echo of the row's other fields, so a concurrent admin-app
			// save cannot be clobbered by this write.
			await databases.updateDocument(DATABASE_ID, EVENTS_COLLECTION_ID, decision.activate.$id, { isActive: true });
			activated = decision.activate.$id;
			log(`Activated ${describe(decision.activate)}.`);
		} catch (err) {
			// THE DEACTIVATION PHASE IS SKIPPED ENTIRELY. Switching the old event off after failing
			// to install its replacement is the one path in this design that walks straight into a
			// dark floor, so it is closed by construction rather than by ordering luck. The incumbent
			// keeps the floor and the next run retries the whole thing.
			error(
				`Failed to activate ${describe(decision.activate)}: ${err.message}. Skipping every deactivation this run -- ` +
					'switching the current event off after failing to switch the new one on would leave the floor with no ' +
					'active event at all. Nothing was changed.',
			);
			return res.json(
				{
					...summary,
					activated: null,
					deactivated: [],
					abortedAfterActivationFailure: true,
					failures: [{ id: decision.activate.$id, name: decision.activate.name, error: err.message }],
				},
				500,
			);
		}
	}

	const deactivated = [];
	const failures = [];
	for (const doc of decision.deactivate) {
		try {
			await databases.updateDocument(DATABASE_ID, EVENTS_COLLECTION_ID, doc.$id, { isActive: false });
			deactivated.push(doc.$id);
			log(`Deactivated ${describe(doc)} -- its window ended and nothing is waiting on it.`);
		} catch (err) {
			// One failure must not strand the others. The residue is one extra stale active row,
			// which the next run retries; the floor is already on the right event by this point.
			error(`Failed to deactivate ${describe(doc)}: ${err.message}. It is still marked active.`);
			failures.push({ id: doc.$id, name: doc.name, error: err.message });
		}
	}

	log(`Done. activated=${activated ?? 'none'} deactivated=${deactivated.length} failures=${failures.length}`);
	return res.json({ ...summary, activated, deactivated, failures });
};
