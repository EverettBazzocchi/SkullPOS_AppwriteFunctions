// Computes the [start, end) window of an event to pull transactions from.
//
// `date` is trusted as the event's real start instant (it's populated from Zeffy's own
// occurrence timestamp when synced from there) and used as-is -- deliberately NOT
// reconstructed from a "calendar day + hour", which would require knowing the venue's timezone.
// Everything else only determines the event's DURATION, which is added on top of `date`.
//
// The duration comes from `barOpenTime`/`barCloseTime` -- the HH:mm strings the admin app's event
// form actually writes, and the same pair Verify-Pin and Admin-EmailBartender already derive their
// windows from. This used to be derived from `event_start`/`event_end` instead, which no screen in
// the admin app can edit: shortening an event's bar hours moved the window Verify-Pin honoured but
// left this one frozen, so every transaction in the tail -- a next-morning cash sale, a second
// event, a staff test ring-up -- was folded into the earlier event's revenue, tips and COGS (and in
// the other direction, the last hours of real sales were dropped). `event_start`/`event_end` are
// kept only as a fallback for rows that predate bar hours being set, so nothing silently loses its
// window; a small hour value (0-11) for event_start is treated there as PM (a nightlife event
// "starting at 7" means 7pm), while event_end needs no such adjustment since an early-morning value
// unambiguously means AM. Defaults (7, 4) --> 7pm-4am, a 9-hour window.
const DEFAULT_EVENT_START_HOUR = 7;
const DEFAULT_EVENT_END_HOUR = 4;

// Matches Verify-Pin/Admin-EmailBartender's parser exactly (colon optional, 3-digit forms
// accepted) so the two do not disagree about the same stored value.
function parseTimeToMinutes(value) {
	if (!value) return null;
	const cleaned = String(value).replace(':', '');
	if (!/^\d{3,4}$/.test(cleaned)) return null;
	const padded = cleaned.padStart(4, '0');
	const hour = parseInt(padded.slice(0, 2), 10);
	const minute = parseInt(padded.slice(2), 10);
	if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 23 || minute > 59) return null;
	return hour * 60 + minute;
}

/** Duration in minutes from the admin-editable bar hours, or null if they aren't usable. */
function barHoursDurationMinutes(event) {
	const openMinutes = parseTimeToMinutes(event.barOpenTime);
	const closeMinutes = parseTimeToMinutes(event.barCloseTime);
	if (openMinutes === null || closeMinutes === null) return null;
	// Wraps past midnight correctly (open 22:00 / close 02:00 -> 240 minutes, not negative).
	return (((closeMinutes - openMinutes) % 1440) + 1440) % 1440;
}

/** Duration in minutes from the legacy event_start/event_end hour pair. */
function legacyHoursDurationMinutes(event) {
	const rawStartHour = typeof event.event_start === 'number' ? event.event_start : DEFAULT_EVENT_START_HOUR;
	const rawEndHour = typeof event.event_end === 'number' ? event.event_end : DEFAULT_EVENT_END_HOUR;

	const startHour = rawStartHour < 12 ? rawStartHour + 12 : rawStartHour;
	const endHour = rawEndHour;

	return ((((endHour - startHour) % 24) + 24) % 24) * 60;
}

/**
 * @returns {{start: Date, end: Date}|null} null when the event has no usable window at all -- no
 * date, an unparseable date, or a zero-length window (open === close). A zero-length window used
 * to produce start === end, which matched no transactions and then overwrote every one of the
 * event's already-correct rollup figures with zeroes, counted as a successful run; returning null
 * lets main.js skip and report it instead.
 */
export function eventSalesWindow(event) {
	if (!event || !event.date) return null;
	const start = new Date(event.date);
	if (Number.isNaN(start.getTime())) return null;

	const barDuration = barHoursDurationMinutes(event);
	const durationMinutes = barDuration === null ? legacyHoursDurationMinutes(event) : barDuration;
	if (durationMinutes <= 0) return null;

	const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
	return { start, end };
}
