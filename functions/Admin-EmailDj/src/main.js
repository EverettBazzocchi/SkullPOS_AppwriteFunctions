import { Databases, Query, Storage, ID } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import fetch from 'node-fetch';
import bwipjs from 'bwip-js';
import { createAppwriteClient } from './appwriteClient.js';

// Emails a DJ either their voucher (event name + a scannable barcode of
// their giftcard code + usage instructions) or a free-form message.
// Admin-execute-only (Appwrite function Execute permission), same as
// Admin-GeneratePin/Stripe-RefundPayment -- no in-code role check needed.
//
// `voucher` is called automatically whenever the admin app issues a DJ a
// new voucher (SkullAdminApp's djService.issueDjVoucher), and can also be
// called again on demand ("resend") since a DJ can now hold many vouchers
// (one per event) rather than just one current one.
const DATABASE_ID = '67c9ffd9003d68236514';
const GIFTCARDS_COLLECTION_ID = 'giftcards';
const DJS_COLLECTION_ID = 'djs';
const EVENTS_COLLECTION_ID = '68e400210008d19bb5c9';
const SENDER = 'SkullPOS <SkullPOS@mail.shotty.tech>';
const ALWAYS_CC = 'everett.bazzocchi@skullspace.ca';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ACTIONS = ['voucher', 'custom'];
const BARCODE_BUCKET_ID = 'voucher-barcodes';
const FOOTER_HTML = '<p style="color:#999;font-size:0.8em;margin-top:24px;">Questions or concerns? Email <a href="mailto:admin@skullspace.ca">admin@skullspace.ca</a>.</p>';

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatCAD(cents) {
	return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format((parseInt(cents) || 0) / 100);
}

// A base64 data: URI never renders in Gmail (and most other clients) -- they strip inline
// images outright rather than just prompting to load them, unlike a real hosted URL. Uploading
// to a public-read Storage bucket and linking to it is the only reliable way to get an actual
// barcode to show up in the email itself.
async function uploadBarcodeImage(storage, code) {
	const png = await bwipjs.toBuffer({
		bcid: 'code128',
		text: code,
		scale: 3,
		height: 12,
		includetext: true,
		textxalign: 'center',
	});
	const fileId = ID.unique();
	await storage.createFile(BARCODE_BUCKET_ID, fileId, InputFile.fromBuffer(png, `${code}.png`));
	const endpoint = process.env.APPWRITE_FUNCTION_API_ENDPOINT;
	const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID;
	return `${endpoint}/storage/buckets/${BARCODE_BUCKET_ID}/files/${fileId}/view?project=${projectId}`;
}

function buildVoucherHtml({ djName, eventName, amount, code, barcodeUrl }) {
	return `
		<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
			<h2 style="margin-bottom:0;">Your SkullSpace DJ Voucher</h2>
			<p>Hi ${escapeHtml(djName)},</p>
			<p>You've been added to <strong>${escapeHtml(eventName)}</strong> and given a
				<strong>${formatCAD(amount)}</strong> bar credit for that event.</p>
			<div style="text-align:center;margin:24px 0;">
				<img src="${barcodeUrl}" alt="Voucher barcode" style="max-width:100%;" />
				<p style="font-family:monospace;font-size:1.1em;letter-spacing:1px;">${escapeHtml(code)}</p>
			</div>
			<p>Show this barcode at the bar to redeem your ${formatCAD(amount)} credit for
				<strong>${escapeHtml(eventName)}</strong>. It can be used on any item(s) at the bar, and
				doesn't have to be used all at once -- spend it across as many purchases as you like
				throughout the night. It's valid only during this event -- it stops working once the
				event ends -- and can't be combined with any other discount.</p>
			<p style="color:#999;font-size:0.85em;margin-top:24px;">See you on the decks!</p>
			${FOOTER_HTML}
		</div>`;
}

function buildCustomHtml({ djName, message }) {
	return `
		<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
			<p>Hi ${escapeHtml(djName)},</p>
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

// Resolves whether this send is allowed and who it actually goes to. When
// `testing`, every email is redirected to ALWAYS_CC instead of the DJ's real
// address (and CC is dropped, since sending both `to` and `cc` to the same
// inbox would just duplicate it) -- so nothing sent while building/testing
// this feature ever reaches a real DJ or a real event coordinator.
function resolveRecipient(djEmail, testing) {
	if (testing) return { to: ALWAYS_CC, cc: [] };
	if (!djEmail || !EMAIL_PATTERN.test(djEmail)) return null;
	return { to: djEmail, cc: [ALWAYS_CC] };
}

// Coordinators assigned to an event get CC'ed on the voucher-assignment email alongside the
// admin, so they stay in the loop on which DJs were added and given credit for their event.
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
	const storage = new Storage(client);

	if (action === 'voucher') {
		const giftcardId = body.giftcardId;
		if (!giftcardId) return res.json({ error: 'Missing giftcardId' }, 400);

		let giftcard;
		try {
			giftcard = await databases.getDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, giftcardId);
		} catch (err) {
			error('Failed to read giftcard: ' + err.message);
			return res.json({ error: 'Giftcard not found' }, 404);
		}

		const djId = giftcard.djs?.$id || giftcard.djs || null;
		if (!djId) return res.json({ error: 'This giftcard has no linked DJ' }, 400);

		let dj;
		try {
			dj = await databases.getDocument(DATABASE_ID, DJS_COLLECTION_ID, djId);
		} catch (err) {
			error('Failed to read dj: ' + err.message);
			return res.json({ error: 'DJ not found' }, 404);
		}

		const recipient = resolveRecipient(dj.email, testing);
		if (!recipient) return res.json({ error: 'No email on file for this DJ' }, 400);

		const eventId = giftcard.events?.$id || giftcard.events || null;
		let event = null;
		if (eventId) {
			try {
				event = await databases.getDocument(DATABASE_ID, EVENTS_COLLECTION_ID, eventId, [Query.select(['*', 'coordinators.*'])]);
			} catch (err) {
				error('Failed to read event (continuing with a generic name): ' + err.message);
			}
		}

		if (!testing) {
			recipient.cc = Array.from(new Set([...recipient.cc, ...coordinatorEmailsFromEvent(event)]));
		}

		const amount = giftcard.balance || 0;
		const eventName = event?.name || 'your event';

		let barcodeUrl;
		try {
			barcodeUrl = await uploadBarcodeImage(storage, giftcard.UPC);
		} catch (err) {
			error('Failed to generate barcode: ' + err.message);
			return res.json({ error: 'Failed to generate voucher barcode' }, 500);
		}

		try {
			await sendEmail({
				to: recipient.to,
				cc: recipient.cc,
				subject: `Your ${formatCAD(amount)} DJ voucher for ${eventName}`,
				html: buildVoucherHtml({ djName: dj.name || 'there', eventName, amount, code: giftcard.UPC, barcodeUrl }),
			});
		} catch (err) {
			error('Failed to send voucher email: ' + err.message);
			return res.json({ error: 'Failed to send voucher email' }, 500);
		}

		log(`Voucher email sent for giftcard ${giftcardId} to ${recipient.to}`);
		return res.json({ ok: true });
	}

	// action === 'custom'
	const djId = body.djId;
	const subject = String(body.subject || '').trim();
	const message = String(body.message || '').trim();
	if (!djId) return res.json({ error: 'Missing djId' }, 400);
	if (!subject || !message) return res.json({ error: 'Missing subject or message' }, 400);

	let dj;
	try {
		dj = await databases.getDocument(DATABASE_ID, DJS_COLLECTION_ID, djId);
	} catch (err) {
		error('Failed to read dj: ' + err.message);
		return res.json({ error: 'DJ not found' }, 404);
	}

	const recipient = resolveRecipient(dj.email, testing);
	if (!recipient) return res.json({ error: 'No email on file for this DJ' }, 400);

	try {
		await sendEmail({
			to: recipient.to,
			cc: recipient.cc,
			subject,
			html: buildCustomHtml({ djName: dj.name || 'there', message }),
		});
	} catch (err) {
		error('Failed to send email: ' + err.message);
		return res.json({ error: 'Failed to send email' }, 500);
	}

	log(`Custom email sent to dj ${djId} (${recipient.to})`);
	return res.json({ ok: true });
};
