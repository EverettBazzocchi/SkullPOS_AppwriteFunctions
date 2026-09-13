// Computes the [start, end] instants a bartender pin should actually work for.
//
// PREFERRED -- the event carries real timestamps: `barOpensAt`/`barClosesAt` for the bar's own
// shift and `startsAt`/`endsAt` for the event itself. Each is a full instant written by the admin
// app, which is the only place a real timezone (America/Winnipeg) exists, so nothing on the server
// ever recombines a calendar day with a wall clock or infers a zone. It only ever compares instants.
//
// FALLBACK -- a row that has not been backfilled yet: the legacy shape, `date` as the start instant
// extended by the open-to-close DURATION derived from the `barOpenTime`/`barCloseTime` "HH:mm"
// strings. Kept behaviour-for-behaviour identical to what shipped before the migration, so an
// un-backfilled row still authenticates exactly the bartender it always did and any deploy order
// (or a rollback of any single component) is safe.
//
// Why the legacy path is the one that needed fixing: `date`'s TIME half is junk -- the owner's own
// words are "the date is the date of the event, the time it says is irrelevant". Taking its raw
// instant as the window START means a row stored as 20:00 against an 18:00 bar open locks the
// bartender out of the first two hours of her own shift. `barOpensAt` deletes that guess entirely.
//
// The window spans the UNION of the bar's hours and the event's own, so a bartender rostered before
// doors (or kept on past last call) is never cut off by whichever of the two is narrower. The
// caller still pads this by its own ±1h buffer (PIN_VALID_WINDOW_MS).

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

// An Appwrite datetime attribute arrives as an ISO string; a Date is accepted too so a caller that
// has already parsed one doesn't have to stringify it back. Anything absent, empty or unparseable
// is null, which is what makes the fallback chain below fire instead of producing a NaN window.
function toMs(value) {
	if (value === null || value === undefined || value === '') return null;
	const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
	return Number.isNaN(ms) ? null : ms;
}

// Open-to-close duration in minutes from the legacy HH:mm strings, or null when they aren't usable.
function legacyBarDurationMinutes(event) {
	const openMinutes = parseTimeToMinutes(event.barOpenTime);
	const closeMinutes = parseTimeToMinutes(event.barCloseTime);
	if (openMinutes === null || closeMinutes === null) return null;
	// Wraps past midnight correctly (open 22:00 / close 02:00 -> 240 minutes, not negative).
	return (((closeMinutes - openMinutes) % 1440) + 1440) % 1440;
}

export function computeEventWindow(event) {
	if (!event) return null;

	const starts = [toMs(event.barOpensAt), toMs(event.startsAt)].filter((ms) => ms !== null);
	const ends = [toMs(event.barClosesAt), toMs(event.endsAt)].filter((ms) => ms !== null);

	// A row with no new timestamp at all anchors on `date`, exactly as before. A half-migrated row
	// (say `barClosesAt` written but `barOpensAt` not yet) anchors on whichever side it does have,
	// so a partial backfill can only ever improve the window, never void it.
	const startMs = starts.length > 0 ? Math.min(...starts) : toMs(event.date);
	if (startMs === null) return null;

	if (ends.length > 0) {
		// Clamped at startMs: bad data with an end before the start would otherwise produce a
		// negative-length window, leaving the pin valid only inside the caller's buffer -- i.e.
		// quietly locking a bartender out mid-shift rather than failing visibly.
		return { startMs, endMs: Math.max(startMs, ...ends) };
	}

	const durationMinutes = legacyBarDurationMinutes(event);
	if (durationMinutes === null) {
		// No bar hours configured -- nothing to extend by, so the window is just the start instant
		// (the caller still pads this by its own before/after buffer).
		return { startMs, endMs: startMs };
	}
	return { startMs, endMs: startMs + durationMinutes * 60 * 1000 };
}
