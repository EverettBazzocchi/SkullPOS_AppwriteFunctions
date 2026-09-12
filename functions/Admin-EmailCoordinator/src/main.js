import { Databases } from 'node-appwrite';
import fetch from 'node-fetch';
import { createAppwriteClient } from './appwriteClient.js';

// Sends an event coordinator a free-form on-demand message. Admin-execute-only (Appwrite
// function Execute permission), same as Admin-EmailDj/Admin-EmailBartender. Coordinators don't
// get an automatic email of their own -- they're already CC'ed on the DJ/bartender event
// notices (see those functions' coordinatorEmailsForEvent) -- this is just for the admin to
// reach one directly.
const DATABASE_ID = '67c9ffd9003d68236514';
const EVENT_COORDINATORS_COLLECTION_ID = 'event_coordinators';
const SENDER = 'SkullPOS <SkullPOS@mail.shotty.tech>';
const ALWAYS_CC = 'everett.bazzocchi@skullspace.ca';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FOOTER_HTML = '<p style="color:#999;font-size:0.8em;margin-top:24px;">Questions or concerns? Email <a href="mailto:admin@skullspace.ca">admin@skullspace.ca</a>.</p>';

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function buildCustomHtml({ coordinatorName, message }) {
	return `
		<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
			<p>Hi ${escapeHtml(coordinatorName)},</p>
			<p style="white-space:pre-wrap;">${escapeHtml(message)}</p>
			${FOOTER_HTML}
		</div>`;
}

function resolveRecipient(email, testing) {
	if (testing) return { to: ALWAYS_CC, cc: [] };
	if (!email || !EMAIL_PATTERN.test(email)) return null;
	return { to: email, cc: [ALWAYS_CC] };
}

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const { coordinatorId, testing } = body;
	const subject = String(body.subject || '').trim();
	const message = String(body.message || '').trim();
	if (!coordinatorId) return res.json({ error: 'Missing coordinatorId' }, 400);
	if (!subject || !message) return res.json({ error: 'Missing subject or message' }, 400);

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	let coordinator;
	try {
		coordinator = await databases.getDocument(DATABASE_ID, EVENT_COORDINATORS_COLLECTION_ID, coordinatorId);
	} catch (err) {
		error('Failed to read coordinator: ' + err.message);
		return res.json({ error: 'Coordinator not found' }, 404);
	}

	const recipient = resolveRecipient(coordinator.email, testing);
	if (!recipient) return res.json({ error: 'No email on file for this coordinator' }, 400);

	try {
		const apiKey = process.env.RESEND_API_KEY;
		const response = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: SENDER,
				to: [recipient.to],
				...(recipient.cc.length ? { cc: recipient.cc } : {}),
				subject,
				html: buildCustomHtml({ coordinatorName: coordinator.name || 'there', message }),
			}),
		});
		if (!response.ok) {
			const detail = await response.text();
			error(`Resend API returned ${response.status}: ${detail}`);
			return res.json({ error: 'Failed to send email' }, 500);
		}
	} catch (err) {
		error('Failed to send email: ' + err.message);
		return res.json({ error: 'Failed to send email' }, 500);
	}

	log(`Custom email sent to coordinator ${coordinatorId} (${recipient.to})`);
	return res.json({ ok: true });
};
