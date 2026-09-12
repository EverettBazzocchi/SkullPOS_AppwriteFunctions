import { Databases, Query } from 'node-appwrite';
import fetch from 'node-fetch';
import { createAppwriteClient } from './appwriteClient.js';
import { computeEventWindow } from './eventWindow.js';

// Emails a bartender either an automatic notice when they're assigned to an event (the event's
// name/time, the exact window their pin will actually work in -- see Verify-Pin/eventWindow.js
// -- and the pin itself), or a free-form on-demand message. Admin-execute-only (Appwrite
// function Execute permission), same as Admin-EmailDj/Admin-GeneratePin -- no in-code role
// check needed.
const DATABASE_ID = '67c9ffd9003d68236514';
const BARTENDERS_COLLECTION_ID = 'bartenders';
const EVENTS_COLLECTION_ID = '68e400210008d19bb5c9';
const SENDER = 'SkullPOS <SkullPOS@mail.shotty.tech>';
const ALWAYS_CC = 'everett.bazzocchi@skullspace.ca';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ACTIONS = ['event_assigned', 'custom'];
const PIN_VALID_WINDOW_MS = 60 * 60 * 1000; // matches Verify-Pin's own window exactly
const FOOTER_HTML = '<p style="color:#999;font-size:0.8em;margin-top:24px;">Questions or concerns? Email <a href="mailto:admin@skullspace.ca">admin@skullspace.ca</a>.</p>';

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// `event.date` is stored as an absolute UTC instant -- without an explicit timeZone here,
// toLocaleString renders it in whatever timezone the function's own server happens to run in
// (not necessarily the venue's), which is how a 10pm Winnipeg start once showed up as some other
// hour. SkullSpace is a single fixed venue (Winnipeg, MB), so this is hardcoded, not inferred.
const VENUE_TIME_ZONE = 'America/Winnipeg';

function formatDateTime(iso) {
	try {
		return new Date(iso).toLocaleString('en-CA', { dateStyle: 'full', timeStyle: 'short', timeZone: VENUE_TIME_ZONE });
	} catch (err) {
		return iso;
	}
}

function buildEventAssignedHtml({ bartenderName, eventName, eventDate, window, pin }) {
	// `window` is null when the event has no bar hours set -- falls back to the flat ±1h-around-
	// start wording so the email still makes sense (matches Verify-Pin's own fallback).
	const startMs = window ? window.startMs : new Date(eventDate).getTime();
	const endMs = window ? window.endMs : startMs;
	const validFrom = formatDateTime(new Date(startMs - PIN_VALID_WINDOW_MS).toISOString());
	const validUntil = formatDateTime(new Date(endMs + PIN_VALID_WINDOW_MS).toISOString());
	const windowExplanation =
		window && window.endMs > window.startMs
			? "covers the whole event (open to close) plus an hour of buffer on either side"
			: "1 hour on either side of the event's start time";
	return `
		<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
			<h2 style="margin-bottom:0;">You're on the schedule</h2>
			<p>Hi ${escapeHtml(bartenderName)},</p>
			<p>You've been added as a bartender for <strong>${escapeHtml(eventName)}</strong>,
				starting ${escapeHtml(formatDateTime(eventDate))}.</p>
			<div style="text-align:center;margin:24px 0;">
				<p style="font-family:monospace;font-size:1.6em;letter-spacing:4px;font-weight:900;">${escapeHtml(pin)}</p>
				<p style="color:#666;font-size:0.9em;">Your POS pin</p>
			</div>
			<p>This pin only works from <strong>${escapeHtml(validFrom)}</strong> to
				<strong>${escapeHtml(validUntil)}</strong> -- ${windowExplanation}. It won't work outside
				that window.</p>
			${FOOTER_HTML}
		</div>`;
}

function buildCustomHtml({ bartenderName, message }) {
	return `
		<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
			<p>Hi ${escapeHtml(bartenderName)},</p>
			<p style="white-space:pre-wrap;">${escapeHtml(message)}</p>
			${FOOTER_HTML}
		</div>`;
}

async function sendEmail({ to, cc, subject, html }) {
	const apiKey = process.env.RESEND_API_KEY;
	const response = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: SENDER,
			to: [to],
			...(cc && cc.length ? { cc } : {}),
			subject,
			html,
		}),
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Resend API returned ${response.status}: ${detail}`);
	}
}

// Same testing convention as Admin-EmailDj: redirect everything to ALWAYS_CC and drop the CC
// (avoids a duplicate send to the same inbox) so nothing reaches a real bartender while testing.
function resolveRecipient(email, testing) {
	if (testing) return { to: ALWAYS_CC, cc: [] };
	if (!email || !EMAIL_PATTERN.test(email)) return null;
	return { to: email, cc: [ALWAYS_CC] };
}

// Coordinators assigned to an event get CC'ed on this too, same as the DJ voucher email.
// `event_coordinators.events` is a many-to-many relationship -- Appwrite flatly rejects
// Query.equal on a relationship attribute ("Cannot query on virtual relationship attribute"),
// so this can't be looked up by querying that collection directly. Reading the *event's* own
// reverse `coordinators` attribute (via select) is the only way to get this list.
function coordinatorEmailsFromEvent(event) {
	return (event?.coordinators || []).map((c) => c.email).filter((email) => email && EMAIL_PATTERN.test(email));
}

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const { action, testing } = body;
	if (!VALID_ACTIONS.includes(action)) {
		return res.json({ error: `action must be one of: ${VALID_ACTIONS.join(', ')}` }, 400);
	}

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	if (action === 'event_assigned') {
		const bartenderId = body.bartenderId;
		const eventId = body.eventId;
		if (!bartenderId || !eventId) return res.json({ error: 'Missing bartenderId or eventId' }, 400);

		let bartender;
		try {
			bartender = await databases.getDocument(DATABASE_ID, BARTENDERS_COLLECTION_ID, bartenderId);
		} catch (err) {
			error('Failed to read bartender: ' + err.message);
			return res.json({ error: 'Bartender not found' }, 404);
		}

		if (!bartender.pin) {
			return res.json({ error: 'This bartender has no pin generated yet' }, 400);
		}

		const recipient = resolveRecipient(bartender.email, testing);
		if (!recipient) return res.json({ error: 'No email on file for this bartender' }, 400);

		let event;
		try {
			event = await databases.getDocument(DATABASE_ID, EVENTS_COLLECTION_ID, eventId, [Query.select(['*', 'coordinators.*'])]);
		} catch (err) {
			error('Failed to read event: ' + err.message);
			return res.json({ error: 'Event not found' }, 404);
		}
		if (!event.date) {
			return res.json({ error: "This event has no date set, so a pin-valid-window can't be shown" }, 400);
		}

		if (!testing) {
			recipient.cc = Array.from(new Set([...recipient.cc, ...coordinatorEmailsFromEvent(event)]));
		}

		try {
			await sendEmail({
				to: recipient.to,
				cc: recipient.cc,
				subject: `You're bartending ${event.name}`,
				html: buildEventAssignedHtml({
					bartenderName: bartender.name || 'there',
					eventName: event.name,
					eventDate: event.date,
					window: computeEventWindow(event),
					pin: bartender.pin,
				}),
			});
		} catch (err) {
			error('Failed to send bartender event-assigned email: ' + err.message);
			return res.json({ error: 'Failed to send email' }, 500);
		}

		log(`Event-assigned email sent for bartender ${bartenderId} / event ${eventId} to ${recipient.to}`);
		return res.json({ ok: true });
	}

	// action === 'custom'
	const bartenderId = body.bartenderId;
	const subject = String(body.subject || '').trim();
	const message = String(body.message || '').trim();
	if (!bartenderId) return res.json({ error: 'Missing bartenderId' }, 400);
	if (!subject || !message) return res.json({ error: 'Missing subject or message' }, 400);

	let bartender;
	try {
		bartender = await databases.getDocument(DATABASE_ID, BARTENDERS_COLLECTION_ID, bartenderId);
	} catch (err) {
		error('Failed to read bartender: ' + err.message);
		return res.json({ error: 'Bartender not found' }, 404);
	}

	const recipient = resolveRecipient(bartender.email, testing);
	if (!recipient) return res.json({ error: 'No email on file for this bartender' }, 400);

	try {
		await sendEmail({
			to: recipient.to,
			cc: recipient.cc,
			subject,
			html: buildCustomHtml({ bartenderName: bartender.name || 'there', message }),
		});
	} catch (err) {
		error('Failed to send email: ' + err.message);
		return res.json({ error: 'Failed to send email' }, 500);
	}

	log(`Custom email sent to bartender ${bartenderId} (${recipient.to})`);
	return res.json({ ok: true });
};
