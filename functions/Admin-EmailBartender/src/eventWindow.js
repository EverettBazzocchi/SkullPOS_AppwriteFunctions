// Computes the [start, end] instants a bartender pin should actually work for: from the event's
// `date` (trusted as the real start instant, already an absolute timestamp -- no timezone
// reconstruction needed) extended by the bar's open-to-close DURATION, so it covers the whole
// shift rather than just a fixed window around the start. Mirrors Admin-RollupEventSales's own
// eventSalesWindow() -- same "add a duration on top of `date`" approach, just derived from
// barOpenTime/barCloseTime (admin-editable HH:mm strings) instead of event_start/event_end.
//
// `date`'s local wall-clock time is expected to line up with barOpenTime (an event created for
// "10pm-2am" has `date` set to that 10pm instant) -- the duration is purely open-to-close, with
// no assumption about which absolute timezone that is, so this works correctly regardless of DST.

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

export function computeEventWindow(event) {
	if (!event || !event.date) return null;
	const startMs = new Date(event.date).getTime();
	if (Number.isNaN(startMs)) return null;

	const openMinutes = parseTimeToMinutes(event.barOpenTime);
	const closeMinutes = parseTimeToMinutes(event.barCloseTime);
	if (openMinutes === null || closeMinutes === null) {
		// No bar hours configured -- nothing to extend by, so the window is just the start instant
		// (the caller still pads this by its own before/after buffer).
		return { startMs, endMs: startMs };
	}

	// Wraps past midnight correctly (open 22:00 / close 02:00 -> 240 minutes, not negative).
	const durationMinutes = (((closeMinutes - openMinutes) % 1440) + 1440) % 1440;
	return { startMs, endMs: startMs + durationMinutes * 60 * 1000 };
}
