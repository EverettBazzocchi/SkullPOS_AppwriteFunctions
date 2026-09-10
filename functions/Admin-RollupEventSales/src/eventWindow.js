// Computes the [start, end) window of an event to pull transactions from, from its `date` and
// `event_start`/`event_end` fields (hour-of-day the event runs -- confirmed with the user these
// are the actual event start/end hours, distinct from the now-legacy permit_start/permit_end
// liquor-permit hours being superseded by barOpenTime/barCloseTime).
//
// `date` is trusted as the event's real start instant (it's populated from Zeffy's own
// occurrence timestamp when synced from there) and used as-is -- deliberately NOT
// reconstructed from a "calendar day + hour", which would require knowing the venue's timezone.
// event_start/event_end instead only determine the event's DURATION: a small hour value (0-11)
// for event_start is treated as PM (a nightlife event "starting at 7" means 7pm, not 7am);
// event_end needs no such adjustment since an early-morning value (0-11) unambiguously means AM
// there. That duration is added on top of `date` to get the end instant.
//
// Defaults (7, 4) --> 7pm-4am, a 9-hour window, used when an event hasn't had these customized.
const DEFAULT_EVENT_START_HOUR = 7;
const DEFAULT_EVENT_END_HOUR = 4;

export function eventSalesWindow(event) {
	if (!event.date) return null;
	const start = new Date(event.date);
	if (Number.isNaN(start.getTime())) return null;

	const rawStartHour = typeof event.event_start === 'number' ? event.event_start : DEFAULT_EVENT_START_HOUR;
	const rawEndHour = typeof event.event_end === 'number' ? event.event_end : DEFAULT_EVENT_END_HOUR;

	const startHour = rawStartHour < 12 ? rawStartHour + 12 : rawStartHour;
	const endHour = rawEndHour;

	const durationHours = ((endHour - startHour) % 24 + 24) % 24;
	const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);

	return { start, end };
}
