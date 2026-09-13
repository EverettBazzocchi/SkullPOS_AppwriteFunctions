// Computes the [start, end) window of an event to pull transactions from.
//
// PREFERRED -- the event carries real timestamps: `startsAt`/`endsAt` for the event itself and
// `barOpensAt`/`barClosesAt` for the bar. Each is a full instant written by the admin app, where a
// real timezone (America/Winnipeg) exists; this function then only ever compares instants, so it
// needs no zone, no "compose a day with a wall clock" step and none of the guesswork it used to
// carry. The window spans the UNION of the two pairs, because a sale can land any time either the
// event or the bar is running (a door sale before the bar opens, a last-call ring-up after the
// event's own end).
//
// FALLBACK -- `date`, itself an absolute instant, as the START anchor for a row carrying none of
// the four. Nothing else of the legacy shape is left. Both duration sources this module used to
// reach for have been retired along with their attributes:
//
//   `barOpenTime`/`barCloseTime` -- the "HH:mm" pair the admin app's event form wrote, and the same
//   pair Verify-Pin and Admin-EmailBartender derived their windows from. `barOpensAt`/`barClosesAt`
//   say the same thing as instants, without a wall clock that has to be recombined with a day.
//
//   `event_start`/`event_end` -- an hour pair NO screen in the admin app could edit, which is
//   exactly what made it dangerous: shortening an event's bar hours moved the window Verify-Pin
//   honoured and left this one frozen, folding every transaction in the tail (a next-morning cash
//   sale, a second event, a staff test ring-up) into the earlier event's revenue, tips and COGS,
//   and in the other direction dropping the last hours of real sales. It also carried a small-hour
//   PM guess (event_start 7 read as 7pm, because a nightlife event "starting at 7" means evening)
//   and a 7pm-4am default, so a row nobody had ever given hours to still got a confident nine-hour
//   window invented for it. No code in this estate ever wrote either column -- the values sitting
//   on the live rows came from Appwrite's own column defaults, which is precisely why they looked
//   populated and trustworthy while meaning nothing.
//
// A START WITH NO END IS NOW NO WINDOW AT ALL, AND IT IS REPORTED RATHER THAN GUESSED. With both
// duration sources gone, a row carrying a start instant but neither `endsAt` nor `barClosesAt` has
// nothing left to bound it, so this returns null and main.js skips it and names it in `skipped` --
// the same treatment a degenerate window already gets. Failing closed is the right direction HERE,
// and only here, because the output is money: inventing an end would attribute a whole window of
// transactions to the wrong night, or if the guess ran short drop real sales out of an event's
// revenue, and then write that over figures that in at least one case have already been published.
// A skipped event keeps the numbers it has and puts a line in the Errors view somebody can act on;
// a guessed one silently replaces them and reports success. Verify-Pin's computeEventWindow
// deliberately decides the identical shape the opposite way, because there a null is a bartender
// who cannot ring anything up at all.

/**
 * Milliseconds for a datetime attribute (ISO string or Date), or null when it is absent, empty or
 * unparseable -- which is what lets the `date` anchor below take over for an un-backfilled row.
 * Matches Verify-Pin/Admin-EmailBartender's own toMs exactly.
 */
function toMs(value) {
	if (value === null || value === undefined || value === '') return null;
	const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
	return Number.isNaN(ms) ? null : ms;
}

/**
 * @returns {{start: Date, end: Date}|null} null when the event has no usable window at all -- no
 * start instant of any kind, an unparseable one, no end instant of any kind, or a zero-length
 * window (an end that is not after the start). A zero-length window used to produce start === end,
 * which matched no transactions and then overwrote every one of the event's already-correct rollup
 * figures with zeroes, counted as a successful run; returning null lets main.js skip and report it
 * instead.
 */
export function eventSalesWindow(event) {
	if (!event) return null;

	const starts = [toMs(event.startsAt), toMs(event.barOpensAt)].filter((ms) => ms !== null);
	const ends = [toMs(event.endsAt), toMs(event.barClosesAt)].filter((ms) => ms !== null);

	// A half-migrated row (one side written, the other not yet) still anchors on whichever start it
	// does have, `date` included, so a partial backfill can never move an event's start.
	const startMs = starts.length > 0 ? Math.min(...starts) : toMs(event.date);
	if (startMs === null) return null;

	// No end of any kind. Reported by main.js, never guessed -- see the header.
	if (ends.length === 0) return null;

	const endMs = Math.max(...ends);

	// An inverted or zero-length pair: either way there is no window to roll up, and reporting it
	// beats silently zeroing the event's figures.
	if (endMs <= startMs) return null;

	return { start: new Date(startMs), end: new Date(endMs) };
}
