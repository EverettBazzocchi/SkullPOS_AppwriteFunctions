import { describeFloorWindow, barWindowUsable } from './activeEventWindow.js';

// THE WHOLE RULE SET, as one pure function of (every Events row, one instant). No SDK, no I/O, no
// clock of its own -- which is what makes every rule below table-testable, and what makes a run
// reproducible: given the same rows and the same `now`, every copy of this function on this planet
// decides the same thing. That matters more than usual here, because Appwrite 1.9.6 replays a
// missed cron backlog as a CONCURRENT BURST (observed 2026-09-13: seven copies of one function
// inside a single second), and a sub-second spread in `now` cannot move an hours-scale boundary.
// N concurrent copies therefore issue identical idempotent writes; the first wins and the rest find
// the row already active and write nothing.
//
// ONE CLOCK. `nowMs` is captured once by the caller and threaded through every comparison here.
// Never `Date.now()` twice: a run that straddled a boundary could otherwise classify one row as a
// candidate for the activation half and as ended for the deactivation half -- i.e. decide to
// activate and deactivate the same row in one run.

// ---------------------------------------------------------------------------------------------
// LEAD and GRACE. Plain integer-millisecond offsets against instants; no wall clock, no zone, no
// calendar day.
//
// WHY A GENEROUS LEAD IS ALMOST FREE. Verified in the clients rather than assumed: the register's
// POS/src/utils/barHours.js#isWithinBarHours (and skullmenu's copy of it) gates alcohol on the
// active event's own `barOpensAt`/`barClosesAt`, INDEPENDENTLY of `isActive`, and fails closed on
// anything missing or inverted. So activating the Afterparty at 16:00 local does not put drinks on
// the board at 16:00 -- the bar still opens at 22:00 because barOpensAt says so. What flips early
// is the door app's ticket name and price and the boards' event header, and at 16:00 on the day of
// the event those are simply correct.
//
// Deactivation is the asymmetric one: NO active event hides ALL alcohol regardless of window and
// drops the door to its CA$30 default. Activate generously; deactivate reluctantly.
//
// WHY SIX HOURS. The Afterparty's union start is 2026-09-27T03:00Z, so a 6h lead activates it at
// 2026-09-26T21:00Z = 16:00 local -- the exact "afternoon before, to set up and test" moment the
// operator actually turns up. The number is chosen to PRE-EMPT the operator rather than merely
// tolerate them: they arrive at 16:00, find the till already on the right event, and their tick is
// a no-op. A 4h lead (18:00 local) leaves a two-hour window where the operator's early tick
// classifies FUTURE, becomes a blocker, and suspends the automation for no reason. Six hours also
// cannot span two distinct nights at this venue, so it never manufactures an overlap that does not
// exist in reality, and it does not put the door on tomorrow's price all of today the way 24h
// would. Anchored on min(startsAt, barOpensAt), not startsAt alone, so a doors-20:00/bar-22:00
// event leads from 14:00 -- the door needs the right price from door-open, not bar-open.
export const LEAD_MS = 6 * 60 * 60 * 1000;

// WHY FOUR HOURS. Not about alcohol: isWithinBarHours already returns false one second past
// barClosesAt, so the bar closes on its own. Grace exists so the event is not yanked out from under
// the closing shift -- last-call ring-ups, the cash-out, Bartender-Sales and Sales-Report, and the
// operator who keeps last night's event on screen while reconciling. A 02:00 local close clears at
// 06:00 local, after everyone has gone home. Two hours would land at 04:00, still plausibly
// mid-reconciliation; six would push it to 08:00 for no additional benefit.
//
// THE GRACE IS ASYMMETRIC, AND THAT ASYMMETRY IS THE POINT. It shields a finished event from
// deactivation but is NEVER a reason to activate anything -- GRACE is excluded from the candidate
// set below. Consequence: an operator who unticks an event at 02:05 after close does NOT get it
// switched back on at 02:15. The symmetric version (candidate iff now < endMs + GRACE) is tidier on
// paper -- the two tests become exact complements -- and is rejected precisely because that
// tidiness costs a real fight with the operator at the worst hour of the night. The disjointness
// that actually matters survives without it: candidates are LIVE or LEAD_IN, deactivation requires
// now >= endMs, and no instant is both, so this function cannot activate and deactivate the same
// row in one run even in principle.
export const GRACE_MS = 4 * 60 * 60 * 1000;

// If `nowMs` is more than this far BEHIND the newest `$updatedAt` in the rows just read, the
// container's clock is behind reality and every classification below is wrong. Cheap, grounded in
// data already in hand, and it turns "the autopilot silently stopped doing anything" into a named
// error. It catches only the HARMLESS direction: a clock running AHEAD classifies a live event as
// ENDED and sweeps it mid-event, and there is no cheap internal defence against that without an
// external time source. Stated plainly in the README rather than papered over.
export const CLOCK_SKEW_TOLERANCE_MS = 10 * 60 * 1000;

// The total partition of the timeline against `nowMs`. Half-open throughout, so no instant lands in
// two classes and none falls between them.
export const UNSCHEDULED = 'UNSCHEDULED';
export const FUTURE = 'FUTURE';
export const LEAD_IN = 'LEAD_IN';
export const LIVE = 'LIVE';
export const GRACE = 'GRACE';
export const ENDED = 'ENDED';

/**
 * PROPERTY B, enforced at the only place activation can happen.
 *
 * Deliberately broader than `=== true`: an over-broad test declines to activate, which is safe; an
 * under-broad one puts a test event on the live floor, which is the exact bug this function exists
 * to fix. (Ticketing-ActiveEvent's own `testing !== true` is correctly narrow for the opposite
 * reason -- there, over-broad would DISCARD a real event and leave the floor with nothing.)
 */
export function isTestRow(row) {
	return row.testing === true || row.testing === 'true' || row.testing === 1;
}

/**
 * Strictly `=== true`, and matched to the consumer rather than chosen for taste: every server-side
 * reader of this flag asks Appwrite for `Query.equal('isActive', true)` against a boolean column,
 * which matches nothing else. Being loose here would invent blockers out of values the schema
 * cannot produce, and a blocker SUSPENDS the automation -- the dangerous direction.
 */
function isActiveRow(row) {
	return row.isActive === true;
}

/**
 * @returns {string} one of the six classes above.
 */
export function classify(window, nowMs, leadMs, graceMs) {
	if (!window) return UNSCHEDULED;
	if (nowMs < window.startMs - leadMs) return FUTURE;
	if (nowMs < window.startMs) return LEAD_IN;
	if (nowMs < window.endMs) return LIVE;
	if (nowMs < window.endMs + graceMs) return GRACE;
	return ENDED;
}

function label(entry) {
	return `"${entry.name}" (${entry.id})`;
}

function summarize(entry) {
	return { id: entry.id, name: entry.name, state: entry.state };
}

/**
 * THE COMPARATOR, consulted in exactly one situation: no incumbent, no blocker, and more than one
 * candidate -- a genuine same-night overlap. Resolved deterministically rather than refused,
 * because refusing here abandons the automation on precisely the busiest nights.
 *
 *   1. LIVE before LEAD_IN. A genuinely running event always outranks one merely in its lead-in --
 *      this is what makes a 14:00-18:00 matinee hold the floor at 16:30 while the 22:00 party is
 *      already a candidate.
 *   2. then earliest endMs. The event finishing soonest is the one the floor is on NOW, and the
 *      later one takes over cleanly when the first window closes. Earliest START would hand an
 *      all-day 12:00-23:00 event the floor over a 20:00-02:00 party for the whole night, which is
 *      the wrong answer for a bar.
 *   3. then earliest startMs, then `$id` ascending. `$id` is unique, so the comparator is TOTAL:
 *      two runs can never disagree and flap the floor, and the winner is never a function of which
 *      row the database happened to return first.
 *
 * `$updatedAt` IS NEVER AN ARBITER HERE, and that is evidence-based rather than taste.
 * Admin-RollupEventSales (`0 6 * * *`) calls updateDocument on EVERY event whose window has ended,
 * every day -- precisely the set of rows a "was a human here recently?" test would be applied to.
 * $updatedAt on an ended event is evidence of a batch job, not of an operator. This comparator uses
 * only startMs, endMs and $id: immutable facts about the event, so the answer does not move when an
 * unrelated job touches a row.
 */
function compareCandidates(a, b) {
	if (a.state !== b.state) return a.state === LIVE ? -1 : 1;
	if (a.window.endMs !== b.window.endMs) return a.window.endMs - b.window.endMs;
	if (a.window.startMs !== b.window.startMs) return a.window.startMs - b.window.startMs;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Names the RULE that picked the winner, not just the winner, in the style Ticketing-ActiveEvent
// already uses ("the most recently updated" vs "the most recently updated non-test event") -- a
// wrong explanation sends whoever reads it at 1am to the wrong row.
function whyWon(winner, candidates) {
	const liveCount = candidates.filter((c) => c.state === LIVE).length;
	if (winner.state === LIVE && liveCount === 1) return 'the only one of them actually running right now';
	if (winner.state === LIVE) return 'running right now and finishing soonest';
	return 'the one whose window ends soonest';
}

/**
 * @param {object[]} rows every Events document, unfiltered -- see main.js for why this is never a
 *   server-side filter.
 * @param {number} nowMs the single instant this whole decision is made against.
 * @param {{leadMs?: number, graceMs?: number, clockSkewToleranceMs?: number}} [options]
 * @returns {{
 *   intended: object|null, activate: object|null, deactivate: object[],
 *   incumbents: object[], blockers: object[], candidates: object[],
 *   unscheduled: object[], unreadable: object[], ambiguous: boolean, heldBack: object|null,
 *   clockSkewMs: number|null, reports: {level: string, message: string}[]
 * }}
 *   `activate`/`deactivate` are the intended WRITES -- empty means this run must write nothing.
 *   `intended` is the row that should hold the floor, which is often already holding it.
 */
export function decideActiveEvent(rows, nowMs, options = {}) {
	const leadMs = options.leadMs ?? LEAD_MS;
	const graceMs = options.graceMs ?? GRACE_MS;
	const clockSkewToleranceMs = options.clockSkewToleranceMs ?? CLOCK_SKEW_TOLERANCE_MS;

	const reports = [];
	const report = (level, message) => reports.push({ level, message });

	const entries = (rows || []).map((row) => {
		const described = describeFloorWindow(row);
		return {
			row,
			id: row.$id,
			name: row.name,
			window: described.window,
			reason: described.reason,
			rejected: described.rejected,
			isActive: isActiveRow(row),
			isTest: isTestRow(row),
			state: classify(described.window, nowMs, leadMs, graceMs),
		};
	});

	const empty = {
		intended: null,
		activate: null,
		deactivate: [],
		incumbents: [],
		blockers: [],
		candidates: [],
		unscheduled: [],
		unreadable: [],
		ambiguous: false,
		heldBack: null,
		clockSkewMs: null,
		reports,
	};

	// ---- CLOCK SANITY, before anything is classified into an action ---------------------------
	// The newest $updatedAt across the rows just read is a lower bound on "the real time, as of a
	// moment ago". A `now` well behind it is a container clock that cannot be trusted to decide
	// whether an event is running.
	const newestUpdatedAt = entries
		.map((entry) => Date.parse(entry.row.$updatedAt))
		.filter((ms) => Number.isFinite(ms))
		.reduce((max, ms) => (ms > max ? ms : max), Number.NEGATIVE_INFINITY);
	if (Number.isFinite(newestUpdatedAt) && newestUpdatedAt - nowMs > clockSkewToleranceMs) {
		const skew = newestUpdatedAt - nowMs;
		report(
			'error',
			`Refusing to touch the active event: this container's clock reads ${new Date(nowMs).toISOString()}, which is ` +
				`${Math.round(skew / 60000)} minutes BEHIND an Events row last written at ${new Date(newestUpdatedAt).toISOString()}. ` +
				'Every start/end comparison this function makes would be wrong, so it has changed nothing. ' +
				'Check the runtime host clock.',
		);
		return { ...empty, clockSkewMs: skew };
	}

	// ---- CLASSIFY -----------------------------------------------------------------------------
	const unscheduled = entries.filter((entry) => entry.state === UNSCHEDULED);
	// A row with nothing at all in any of the four instants is an unfinished draft, and naming it
	// every fifteen minutes is noise. A row that carries values the strict parser REFUSED is a data
	// regression, and that is worth a line in the Errors view every single run.
	const unreadable = unscheduled.filter((entry) => entry.rejected.length > 0);

	// GRACE is deliberately NOT a candidate class -- see GRACE_MS. A test row is never a candidate,
	// so no path in this function can write `isActive: true` to one.
	const candidates = entries.filter((entry) => !entry.isTest && (entry.state === LIVE || entry.state === LEAD_IN));
	const incumbents = candidates.filter((entry) => entry.isActive);
	// An active row that is neither a candidate nor provably ENDED: FUTURE (tomorrow's event ticked
	// early), UNSCHEDULED (no readable window), or a LIVE/LEAD_IN row excluded for `testing`. A
	// GRACE row is NOT a blocker -- it is handled by the handover branch below.
	const blockers = entries.filter(
		(entry) => entry.isActive && !candidates.includes(entry) && entry.state !== ENDED && entry.state !== GRACE,
	);
	const graceHolders = entries.filter((entry) => entry.isActive && entry.state === GRACE);

	// ---- DECIDE WHO SHOULD HOLD THE FLOOR ------------------------------------------------------
	let intended = null;
	let ambiguous = false;

	if (incumbents.length === 1) {
		// INCUMBENCY BEATS THE COMPARATOR, and this rule is doing double duty as the operator
		// override and as the anti-flap. A human's pick between two simultaneously-qualifying
		// events is re-picked by every subsequent run and produces zero writes. Without it the
		// function would activate the comparator's winner ALONGSIDE the operator's choice and fight
		// them on both counts.
		intended = incumbents[0];

		// ...BUT SAY SO WHEN HONOURING IT IS COSTING THE FLOOR TONIGHT, because this is the same
		// failure as the blocker refusal below and it was previously the only version of it that
		// happened in SILENCE.
		//
		// The shape: somebody ticks tomorrow night's event active while tonight's is genuinely
		// running. Ticked early enough it classifies FUTURE, becomes a blocker, and the branch below
		// escalates at error() naming the row to untick. But the six-hour lead means that same row
		// classifies LEAD_IN from six hours before its own start -- and a LEAD_IN active row is a
		// CANDIDATE, so it is an incumbent, so it lands here instead, where incumbency deliberately
		// short-circuits the comparator and the run reports nothing at all. The wrong event holds the
		// floor for the whole of the real one: the door sells the wrong ticket at the wrong price, and
		// the register hides every alcohol item all night, because the alcohol gate reads the ACTIVE
		// event's bar pair and that event's bar does not open until tomorrow.
		//
		// Nothing here may be written -- neither row has ended (A) and a second active row is
		// forbidden (F) -- so the wording is the entire mitigation, exactly as it is for the blocker.
		// A silent run is the one thing that must not happen, because the symptom on the floor
		// ("the till thinks it's tomorrow") gives nobody a row id to untick.
		const runningInstead = candidates.filter((entry) => entry.state === LIVE && entry.id !== intended.id);
		if (intended.state === LEAD_IN && runningInstead.length > 0) {
			report(
				'error',
				`${runningInstead.map(label).join(', ')} is running RIGHT NOW, but the floor is held by ` +
					`${label(intended)}, which somebody ticked active and which does not start until ` +
					`${new Date(intended.window.startMs).toISOString()}. Neither has ended, so this function will not ` +
					'switch either off -- untick "Active event" on ' +
					`${label(intended)} if tonight is ${runningInstead.map(label).join(' / ')}. Until then the register ` +
					'and both boards will hide every alcohol item and the door will show the wrong ticket price.',
			);
		}
	} else if (incumbents.length > 1) {
		// PROPERTY A vs PROPERTY F, the one place they genuinely conflict, and A WINS. Two active
		// rows are both genuinely current: neither has ENDED, so neither may be touched. This
		// function created neither, so F is not violated by leaving them. Downstream already has a
		// defensible answer ($updatedAt desc, stepping past `testing`).
		ambiguous = true;
		report(
			'error',
			`${incumbents.length} events are active AND currently running or in their lead-in at once: ` +
				`${incumbents.map(label).join(', ')}. Neither has ended, so this function will not switch either off -- ` +
				'untick "Active event" on the one that is not tonight. Until then the floor follows the most recently ' +
				'updated of them (Ticketing-ActiveEvent).',
		);
	} else if (blockers.length > 0) {
		// REFUSE. Activating the intended row alongside a blocker would leave two rows active (F
		// forbids); deactivating the blocker would touch a row not proved ended (A forbids). The
		// only lawful move is to write nothing and put it in front of a human. The ENDED sweep
		// still runs below, so a blocker plus a stale ENDED row still converges to exactly one
		// active row without ever touching the blocker.
		ambiguous = true;
		const wanted = candidates.slice().sort(compareCandidates)[0] || null;
		const blockerText = blockers
			.map((entry) => `${label(entry)} [${entry.state.toLowerCase()}${entry.isTest ? ', flagged testing' : ''}]`)
			.join(', ');

		// THE WORDING IS THE WHOLE MITIGATION, so it escalates when it matters. A generic "ambiguous
		// state" line sends the reader nowhere; this one names the row to untick and the money it
		// is costing.
		if (wanted && wanted.state === LIVE) {
			report(
				'error',
				`${label(wanted)} is running RIGHT NOW and cannot be given the floor, because ${blockerText} is marked ` +
					'active and has not ended. Alcohol will stay hidden on the register and both boards, and the door ' +
					'will show the wrong ticket price, until someone unticks it in the admin app.',
			);
		} else {
			report(
				'error',
				`Not changing the active event: ${blockerText} is marked active but is not running and cannot be proved ` +
					`ended, so switching it off is not this function's call. ` +
					(wanted
						? `${label(wanted)} is waiting in its lead-in and was NOT activated.`
						: 'Nothing else is due, so nothing was activated.'),
			);
		}
	} else if (candidates.length > 0) {
		const ranked = candidates.slice().sort(compareCandidates);
		const winner = ranked[0];
		// A LEAD-ONLY SUCCESSOR NEVER DISPLACES AN EVENT STILL INSIDE ITS WIND-DOWN. This is the
		// pair rule to the handover branch, and together they are what stops LEAD > GRACE from
		// producing a two-active state during a same-night handover: the successor's six-hour
		// lead-in overlaps the incumbent's four-hour grace by construction.
		if (graceHolders.length > 0 && winner.state !== LIVE) {
			// Ordinarily this is the right answer and an unremarkable one: the door queue is still last
			// event's crowd, so a successor that has not actually started does not get to take the
			// register off them. It stops being unremarkable when the row being shielded is a TEST row,
			// because then this rule is holding a test record on the live door through the whole of the
			// real event's lead-in -- a test ticket price at the door, for up to the full grace. Same
			// decision either way (the rule is the rule, and cutting a wind-down short on a lead-in is
			// the bug it exists to prevent), but the second case is an error somebody has to see.
			const testHolders = graceHolders.filter((entry) => entry.isTest);
			report(
				testHolders.length > 0 ? 'error' : 'log',
				`${label(winner)} is in its lead-in but ${graceHolders.map(label).join(', ')} is still inside its ` +
					'wind-down, so the floor stays where it is until the newer event actually starts.' +
					(testHolders.length > 0
						? ` ${testHolders.map(label).join(', ')} is flagged TESTING and is what the door and both ` +
							'boards are serving until then -- untick it in the admin app to hand the floor over now.'
						: ''),
			);
		} else {
			intended = winner;
			if (candidates.length > 1) {
				report(
					'log',
					`${candidates.length} events qualify right now (${candidates.map(label).join(', ')}). ` +
						`Choosing ${label(winner)}: ${whyWon(winner, candidates)}.`,
				);
			}
		}
	}

	// ---- PLAN THE ACTIVATION -------------------------------------------------------------------
	// Only when the desired state does not already hold. This matters beyond cost: Appwrite bumps
	// `$updatedAt` on every updateDocument even when the value is unchanged, and a needless bump
	// reshuffles Ticketing-ActiveEvent's tiebreak for nothing.
	const activate = intended && !intended.isActive ? intended : null;

	// ---- PLAN THE DEACTIVATIONS ----------------------------------------------------------------
	// An active row is reachable here ONLY when its own end instant is provably in the past. That is
	// PROPERTY A enforced structurally rather than as a special case somebody could refactor away:
	// nothing classified FUTURE, LEAD_IN, LIVE or UNSCHEDULED can ever appear in this list, and
	// GRACE only via a live handover. An operator who ticks the Afterparty active on the afternoon
	// of the 26th is LEAD_IN, then LIVE, then GRACE -- never ENDED -- so there is no move available
	// on that row at all.
	//
	// (1) SWEEP -- the row is ENDED (past its own end plus grace). Runs UNCONDITIONALLY: whether or
	//     not anything was activated, whether or not the run refused, whether or not a candidate
	//     exists. This is the branch that fixes the reported incident.
	const sweep = entries.filter((entry) => entry.isActive && entry.state === ENDED);

	// (2) HANDOVER -- a LIVE winner is taking the floor, so an active row still inside its
	//     wind-down has its grace cut short in the same run. A live event taking the floor is a
	//     better reason to end a wind-down than the clock is, and it is what keeps the
	//     two-events-in-one-night case from ever producing two active rows.
	//
	//     "Is activating" is read as "intends a LIVE row", not "is issuing an activation write".
	//     The difference only shows up after a partial failure -- a crash between this run's two
	//     writes leaves the successor active and the predecessor active-in-grace, and on the next
	//     run no activation write is needed. Reading it the narrow way would strand that residue
	//     for up to four hours; reading it this way makes the next run finish the job.
	const handover =
		intended && intended.state === LIVE ? graceHolders.filter((entry) => entry.id !== intended.id) : [];

	let deactivate = [...sweep, ...handover];
	let heldBack = null;

	// ---- THE SWEEP GUARD, and it is the only guard ----------------------------------------------
	// If this run's own writes would leave the floor with no REAL (non-test) active event, hold one
	// row back whenever ANY row might be running right now -- classified LIVE (including a `testing`
	// one, which is never activatable but is certainly running), or UNSCHEDULED so this function
	// cannot tell. Leaving the floor with zero active events mid-event is worse than leaving a stale
	// one: the register hides all alcohol and the door falls back to CA$30.
	//
	// "No non-test row left" rather than "no row left" closes the side door in property B: a stale
	// row swept out from around an ALREADY-ACTIVE test event promotes that test event to the floor
	// by subtraction, without this function ever writing `isActive: true` to it. Satisfying B to the
	// letter while a test record ends up steering the door is the exact bug being fixed, so the
	// guard has to see it.
	//
	// Deliberately narrower than a collection-wide "any bad row freezes all cleanup" rule, which
	// would let one draft event with a start and no end disable stale cleanup for every other event
	// indefinitely -- a symptom indistinguishable from the function not running. This guard bites
	// only when the alternative is a dark (or fake) floor, which is the only thing property D
	// actually cares about.
	//
	// It can never cancel a handover: an activation always installs a candidate, candidates are
	// never test rows, so a run that activates anything already leaves a real event on the floor.
	const activeAfter = new Map(entries.filter((entry) => entry.isActive).map((entry) => [entry.id, entry]));
	if (activate) activeAfter.set(activate.id, activate);
	deactivate.forEach((entry) => activeAfter.delete(entry.id));
	const realActiveAfter = [...activeAfter.values()].filter((entry) => !entry.isTest);

	if (realActiveAfter.length === 0 && deactivate.length > 0) {
		// TWO INDEPENDENT REASONS TO HOLD A ROW BACK, and they are not the same reason.
		//
		// (i) SOMETHING MIGHT BE RUNNING and the sweep would take the floor to zero: a row classified
		//     LIVE (including a `testing` one, which is never activatable but is certainly running),
		//     or UNSCHEDULED so this function cannot tell. That is property D -- a dark floor
		//     mid-event hides every alcohol item and drops the door to CA$30.
		//
		// (ii) A TEST ROW WOULD BE LEFT HOLDING THE FLOOR. This one is property B, and it does NOT
		//      depend on anything being classified LIVE, which is why testing it through (i) was not
		//      enough: a test event that is merely in its LEAD_IN or its GRACE is not "possibly
		//      running", so (i) is blind to it, the sweep proceeds, and the one non-test active row is
		//      subtracted out from under it. Ticketing-ActiveEvent then has nothing but a test row to
		//      serve, and pickActiveEvent deliberately falls back to serving it rather than returning
		//      null -- so the door sells at the test price and the boards carry the test event's name.
		//      This function never wrote `isActive: true` to it; it got there by subtraction, which is
		//      exactly the side door property B is supposed to close, and closing it to the letter
		//      while a test record ends up steering the door is the bug being fixed.
		//
		// Both are strictly conservative: they only ever leave an EXTRA row switched on, never
		// activate anything, and never reach a row that has not ended. Reason (ii) cannot re-open the
		// quiet-Tuesday case either -- if nothing is active after the sweep there is no test row to
		// promote, so `stillActiveAfter` is empty and the sweep goes ahead exactly as before.
		const possiblyRunning = entries.filter((entry) => entry.state === LIVE || entry.state === UNSCHEDULED);
		const stillActiveAfter = [...activeAfter.values()];
		const because = possiblyRunning.length > 0 ? possiblyRunning : stillActiveAfter;
		if (because.length > 0) {
			// Hold back exactly ONE. Holding back ALL of them would satisfy D and violate F for no
			// extra benefit, so the choice of which one is the whole of it:
			//
			//   A NON-TEST ROW FIRST. The reason this guard fired is that the run would otherwise leave
			//   the floor dark or leave a test record holding it, so holding back a test row is a wasted
			//   move -- the floor still ends up on a test event, which is the thing being prevented. A
			//   stale REAL event on the boards is the recoverable outcome; that is the one to keep.
			//   then THE MOST RECENTLY FINISHED, which is the freshest thing the floor could still be
			//   showing and the likeliest to match the shift that is actually standing there,
			//   then $id, so two concurrent runs of the replayed cron backlog cannot disagree.
			heldBack = deactivate
				.slice()
				.sort(
					(a, b) =>
						Number(a.isTest) - Number(b.isTest) ||
						b.window.endMs - a.window.endMs ||
						(a.id < b.id ? -1 : 1),
				)[0];
			deactivate = deactivate.filter((entry) => entry.id !== heldBack.id);
			const wouldLeave = activeAfter.size === 0 ? 'NO active event at all' : 'only a TEST event holding the floor';
			const why =
				possiblyRunning.length > 0
					? `while ${possiblyRunning.map(label).join(', ')} may be running ` +
						`(${possiblyRunning.map((entry) => entry.state.toLowerCase()).join(', ')})`
					: `and ${stillActiveAfter.map(label).join(', ')} is flagged TESTING, so the door and both boards ` +
						'would start serving a test record by subtraction';
			report(
				'error',
				`Leaving the stale active event ${label(heldBack)} switched on even though it ended at ` +
					`${new Date(heldBack.window.endMs).toISOString()}, because switching it off would leave ${wouldLeave} ` +
					`${why}. A stale event on the boards ` +
					'is recoverable; no event hides every alcohol item and drops the door to the default price. ' +
					'Give tonight a real, non-test Events row with readable instants and this clears itself.',
			);
		}
	}

	// ---- WARNINGS THAT CANNOT BE ACTED ON, ONLY REPORTED ----------------------------------------
	// A row whose union window is fine but whose BAR pair is not will take the floor and then sell
	// nothing, because the register gates alcohol on the bar pair alone.
	if (intended && intended.row.sellsAlcohol === true && !barWindowUsable(intended.row)) {
		report(
			'error',
			`${label(intended)} sells alcohol but its bar window is unusable (barOpensAt=${intended.row.barOpensAt ?? 'unset'}, ` +
				`barClosesAt=${intended.row.barClosesAt ?? 'unset'}). It will hold the floor and the register will still hide ` +
				'every alcohol item, because the alcohol gate reads that pair and nothing else. Fix the pair in the admin app.',
		);
	}

	unreadable.forEach((entry) => {
		report(
			'error',
			`${label(entry)} carries unreadable time fields (${entry.rejected.join(', ')}) and was ignored entirely -- ` +
				`${entry.reason}. It can neither be activated nor switched off until they are real ISO-8601 datetimes.`,
		);
	});

	return {
		intended: intended ? intended.row : null,
		activate: activate ? activate.row : null,
		deactivate: deactivate.map((entry) => entry.row),
		incumbents: incumbents.map(summarize),
		blockers: blockers.map(summarize),
		candidates: candidates.map(summarize),
		unscheduled: unscheduled.map((entry) => ({ id: entry.id, name: entry.name, reason: entry.reason })),
		unreadable: unreadable.map((entry) => ({ id: entry.id, name: entry.name, reason: entry.reason })),
		ambiguous,
		heldBack: heldBack ? summarize(heldBack) : null,
		clockSkewMs: null,
		reports,
	};
}
