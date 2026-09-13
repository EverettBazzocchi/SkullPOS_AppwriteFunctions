// Computes the [start, end] instants a bartender pin should actually work for.
//
// PREFERRED -- the event carries real timestamps: `barOpensAt`/`barClosesAt` for the bar's own
// shift and `startsAt`/`endsAt` for the event itself. Each is a full instant written by the admin
// app, which is the only place a real timezone (America/Winnipeg) exists, so nothing on the server
// ever recombines a calendar day with a wall clock or infers a zone. It only ever compares instants.
//
// FALLBACK -- `date`, itself an absolute instant, as the START anchor for a row that carries none
// of the four. That is now the whole of the legacy shape. The open-to-close DURATION this module
// used to derive from the `barOpenTime`/`barCloseTime` "HH:mm" pair is gone with the attributes
// themselves: they are being deleted from the Events schema, so there is no legacy route to an END
// any more, only to a start.
//
// `date` survives here only because it is still a real column, and it is still only ever read as a
// start. Its TIME half is junk -- the owner's own words are "the date is the date of the event, the
// time it says is irrelevant" -- so a row stored as 20:00 against an 18:00 bar open starts the
// window two hours late and locks the bartender out of the first two hours of her own shift. That
// is why `barOpensAt` sits ahead of it in the chain below, and why `date` is expected to follow the
// HH:mm strings out of the schema in a later pass rather than being leaned on for anything new.
//
// A START WITH NO END IS A START-ONLY WINDOW, NOT A REFUSAL. With no duration left to extend by, a
// row carrying `barOpensAt` (or `startsAt`, or only `date`) but neither `barClosesAt` nor `endsAt`
// collapses to endMs === startMs, and the pin is live only inside the caller's own buffer. That is
// a deliberate choice over returning null. Null means the pin NEVER verifies for that event, and
// Verify-Pin answers an out-of-window pin with a body byte-identical to a wrong one -- so the
// bartender standing at the till gets a flat "no" with no reason attached and no fix she can make
// from the floor. A short window is a bad night; no window is a dead till. Admin-RollupEventSales
// decides the very same shape the other way, and should: there the cost of inventing a window is
// silently overwriting an event's real revenue with zeroes, and nobody is waiting at a till on it.
//
// No live row is in that shape -- all three carry all four instants -- but a save that composes
// `barOpensAt` from a bar open time while the close time is unparseable ("late") still produces
// one, which is why it needs a stated answer rather than an accident.
//
// The window spans the UNION of the bar's hours and the event's own, so a bartender rostered before
// doors (or kept on past last call) is never cut off by whichever of the two is narrower. The
// caller still pads this by its own ±1h buffer (PIN_VALID_WINDOW_MS).

// An Appwrite datetime attribute arrives as an ISO string; a Date is accepted too so a caller that
// has already parsed one doesn't have to stringify it back. Anything absent, empty or unparseable
// is null, which is what makes the fallback chain below fire instead of producing a NaN window.
function toMs(value) {
	if (value === null || value === undefined || value === '') return null;
	const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
	return Number.isNaN(ms) ? null : ms;
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

	// Nothing left to extend the start by, so the caller's own before/after buffer IS the window.
	// See the header for why that beats refusing to produce one.
	if (ends.length === 0) return { startMs, endMs: startMs };

	// Clamped at startMs: bad data with an end before the start would otherwise produce a
	// negative-length window, which is strictly worse than the flat buffer above -- once the caller
	// pads it, an inverted pair can exclude the start instant itself, i.e. quietly locking a
	// bartender out mid-shift rather than failing visibly.
	return { startMs, endMs: Math.max(startMs, ...ends) };
}
