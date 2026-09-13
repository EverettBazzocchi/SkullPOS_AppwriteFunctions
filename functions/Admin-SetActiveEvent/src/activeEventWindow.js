// The [start, end) instants this function is allowed to STEER THE FLOOR by -- the union of the
// bar's hours and the event's own, the same shape Verify-Pin's computeEventWindow and
// Admin-RollupEventSales' eventSalesWindow already take, because a sale (and a door scan) can land
// any time either the event or the bar is running.
//
// It is the THIRD helper in this repo computing that same union, and it deliberately decides two
// of the shared edge cases differently from both siblings. Each of the three has to say why, so
// whoever ends up comparing them is not left assuming one of them is simply wrong:
//
//   STRICT PARSING, not the loose `toMs` (bare `Date.parse`) the other two use. This is
//   load-bearing in the dangerous direction and the register already knows it:
//   `Date.parse("1800")` is not NaN, it is the YEAR 1800. A hand-corrected row -- or an admin-app
//   regression that puts an "HH:mm"-shaped wall clock back into `barClosesAt` -- parses under
//   `toMs` as an end instant two centuries in the past, which would make a LIVE event eligible for
//   deactivation and take the floor dark mid-event. The shape test below is copied from the
//   register's own POS/src/utils/barHours.js#parseInstant, with the same reasoning written out
//   there. A function whose whole job is steering the register must never be LOOSER than the
//   register: the worst this strictness can do is decline to act (see UNSCHEDULED below); the
//   worst looseness can do is switch off an event while it is running.
//
//   `date` IS NOT A FALLBACK, in either direction. Both siblings anchor on it when the four
//   instants are absent. Here it must not be, for a reason specific to what this function writes:
//   `date` yields a START and never an END, so a row activated off `date` alone could never
//   afterwards be proved ENDED -- a trap door this function could open and never close, holding
//   the floor on that row forever. Its time half is also documented junk (the owner's own words:
//   "the date is the date of the event, the time it says is irrelevant"), and the live rows prove
//   it -- the test row's `date` is 00:00Z against a `startsAt` of 01:00Z. All three live rows
//   carry all four instants, so nothing real is lost today.
//
// The consequence of both choices is the same and is accepted on purpose: a row this module cannot
// read is UNSCHEDULED -- never activated (even if it is genuinely tonight's event) and never
// deactivated (unreadable is not ended). It changes nothing, and gets named in the run's report so
// a botched `barClosesAt` surfaces as a line in the Errors view hours before the door opens rather
// than as silence. Verify-Pin decides the identical shape the other way (a start-only window
// rather than a refusal, because there a null is a bartender who cannot ring anything up); this is
// the one place where refusing costs nothing and guessing costs the night.
//
// No local time is ever constructed here, no timezone is ever named, and no calendar day is ever
// computed. That is what makes DST a non-event and what makes the Afterparty's 22:00->02:00 local
// window one contiguous instant pair with no midnight special case. (main.test.js pins that
// structurally -- it greps these sources for `America/`, `getHours`, `toLocale` and friends.)

/**
 * An ISO-8601 datetime: a date AND a time, offset optional. Copied from the register's
 * POS/src/utils/barHours.js#parseInstant so the two cannot disagree about what counts as a
 * readable instant -- see the header for why being stricter than `Date.parse` is the whole point.
 */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * @returns {number|null} milliseconds, or null when the value is absent, blank, the wrong type, or
 * not ISO-8601-datetime-shaped. Appwrite hands a datetime attribute back as an ISO string; a Date
 * is accepted too so a caller that has already parsed one need not stringify it back.
 */
export function parseInstant(value) {
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!ISO_DATETIME.test(trimmed)) return null;
	const ms = Date.parse(trimmed);
	return Number.isFinite(ms) ? ms : null;
}

// A field is "present but rejected" when the row carries something in it and the strict parser
// refuses it. That distinction is the only signal available that a row is a DATA REGRESSION rather
// than an unfinished draft, and the two want very different reactions from a human: one is a typo
// to fix before doors, the other is a row nobody has filled in yet.
function isPresent(value) {
	return value !== null && value !== undefined && value !== '';
}

const START_FIELDS = ['startsAt', 'barOpensAt'];
const END_FIELDS = ['endsAt', 'barClosesAt'];

/**
 * The full story of a row's window, for the reporting path.
 *
 * @returns {{window: {startMs: number, endMs: number}|null, reason: string|null, rejected: string[]}}
 *   `window` null means UNSCHEDULED. `rejected` names every instant field that held something the
 *   strict parser would not take.
 */
export function describeFloorWindow(row) {
	if (!row) return { window: null, reason: 'no event row', rejected: [] };

	const rejected = [...START_FIELDS, ...END_FIELDS].filter(
		(field) => isPresent(row[field]) && parseInstant(row[field]) === null,
	);

	const starts = START_FIELDS.map((field) => parseInstant(row[field])).filter((ms) => ms !== null);
	const ends = END_FIELDS.map((field) => parseInstant(row[field])).filter((ms) => ms !== null);

	// Deliberately NOT falling through to `date` -- see the header. A row with neither pair is a
	// draft nobody scheduled; a row with one half is a half-finished edit. Both read the same way
	// to this function (it will not touch them) but not to the person fixing them, so the reason
	// says which.
	if (starts.length === 0 && ends.length === 0) {
		return {
			window: null,
			reason: rejected.length
				? `no readable start or end instant (${rejected.join(', ')} could not be read as ISO-8601 datetimes)`
				: 'no start or end instants at all (startsAt/endsAt and barOpensAt/barClosesAt are all empty)',
			rejected,
		};
	}
	if (starts.length === 0) {
		return { window: null, reason: 'no readable start instant (check startsAt/barOpensAt)', rejected };
	}
	if (ends.length === 0) {
		// The shape that matters most: this function can never prove such a row has ENDED, so it
		// must never give it the floor in the first place.
		return { window: null, reason: 'no readable end instant (check endsAt/barClosesAt)', rejected };
	}

	const startMs = Math.min(...starts);
	const endMs = Math.max(...ends);

	// An inverted or zero-length pair. Catches the most common shape of a mistyped instant (an
	// 02:00 close that never got the following day attached), and is the one typo class this
	// function CAN see -- a wholesale wrong-year pair is internally consistent and passes.
	if (endMs <= startMs) {
		return {
			window: null,
			reason: `end instant is not after the start (${new Date(startMs).toISOString()} -> ${new Date(endMs).toISOString()})`,
			rejected,
		};
	}

	return { window: { startMs, endMs }, reason: null, rejected };
}

/**
 * @returns {{startMs: number, endMs: number}|null} the union window, or null when the row is
 * UNSCHEDULED. The hot path; `describeFloorWindow` is the same computation with the words attached.
 */
export function floorWindow(row) {
	return describeFloorWindow(row).window;
}

/**
 * Whether the BAR's own pair -- `barOpensAt`/`barClosesAt` -- is usable on its own.
 *
 * Separate from the union on purpose. A row with good `startsAt`/`endsAt` but a missing or inverted
 * bar pair produces a perfectly usable union window, so this function will happily give it the
 * floor -- and then the register's own instantWindow rejects the bar pair and hides alcohol all
 * night. This function cannot fix that (the bar hours are the bar hours), but it can say so in the
 * report while there is still time to correct the row, which is the only mitigation available.
 */
export function barWindowUsable(row) {
	if (!row) return false;
	const opensAt = parseInstant(row.barOpensAt);
	const closesAt = parseInstant(row.barClosesAt);
	if (opensAt === null || closesAt === null) return false;
	return closesAt > opensAt;
}
