import crypto from 'crypto';
import { Databases, Users } from 'node-appwrite';
import fetch from 'node-fetch';
import { createAppwriteClient } from './appwriteClient.js';
import { derivePaymentLegs } from './paymentLegs.js';
import { checkSendQuota, recordSend } from './sendLimit.js';

// Emails a receipt for an already-completed (or refunded) sale to a
// customer-supplied address. Separate from Appwrite's own auth-email SMTP
// (used only for verification/recovery/magic-URL emails) -- this calls
// Resend's plain HTTP API directly, since a receipt is arbitrary custom
// content, not one of Appwrite's built-in auth email types.
//
// Both inputs used to come straight off the request with nothing else checked, which made this a
// read primitive for the whole ledger: any caller who knew (or harvested) a transaction id could
// have its full itemized receipt -- items, quantities, unit prices, discount, tip, total and the
// per-leg payment breakdown -- mailed to an address of their choosing. Three rules now stand in
// front of that:
//   1. the caller must belong to a till/admin team,
//   2. a sale attached to a member account can only be receipted to the address on that sale, and
//   3. one caller's sends are capped per 15 minutes (sendLimit.js), reserved before the mail goes
//      out so the cap holds even when the counter write fails.
// `execute` has been narrowed off `users` in appwrite.config.json, but only a push makes that
// live, and a list is only ever as tight as its last deploy -- so rules 1 and 3 both fail CLOSED
// (503) when they cannot run, rather than waving the request through with a log line. Running
// them at all requires the users.read and documents.write scopes; without those this function now
// refuses every receipt instead of mailing every receipt.
//
// This runtime is node-16.0 (the only Node runtime this self-hosted
// instance offers), which predates global fetch -- node-fetch polyfills it
// rather than pulling in a full HTTP client/SDK.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const RATE_LIMIT_COLLECTION_ID = 'rate_limits';
const RECEIPT_SENDER = 'SkullPOS <SkullPOS@mail.shotty.tech>';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ADMIN_TEAM_ID = '68e35aed00144b8cde9d';
// Mirrors what this function's `execute` list should be: the admin team, the POS team, and the
// team Verify-Pin joins a device to once a PIN is accepted. A bare anonymous session belongs to
// none of them.
const ALLOWED_TEAM_IDS = [
	ADMIN_TEAM_ID,
	'68ffcecc0026f78f0af8', // POS
	'6a9cbb1c95ea7d59dd8c', // PIN Payment Access
];
// Every email this system sends CCs this address and closes with the same contact line --
// see the identical constants in Transaction-RecordPayment/Admin-EmailDj/Admin-EmailBartender/
// Admin-EmailCoordinator (each function stays self-contained, no shared email module).
const ALWAYS_CC = 'everett.bazzocchi@skullspace.ca';
const FOOTER_HTML = '<p style="color:#999;font-size:0.8em;margin-top:24px;">Questions or concerns? Email <a href="mailto:admin@skullspace.ca">admin@skullspace.ca</a>.</p>';

const PAYMENT_METHOD_LABELS = {
	cash: 'Cash',
	stripe: 'Card',
	giftcard: 'Gift Card',
};

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatCAD(cents) {
	return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format((parseInt(cents) || 0) / 100);
}

function buildReceiptHtml(transaction, items, legs) {
	const itemRows = items
		.map(
			(item) => `
				<tr>
					<td style="padding:4px 8px;">${escapeHtml(item.name)}</td>
					<td style="padding:4px 8px;text-align:center;">${parseInt(item.quantity) || 0}</td>
					<td style="padding:4px 8px;text-align:right;">${formatCAD(item.price)}</td>
					<td style="padding:4px 8px;text-align:right;">${formatCAD((parseInt(item.price) || 0) * (parseInt(item.quantity) || 0))}</td>
				</tr>`,
		)
		.join('');

	const legRows = legs
		.map(
			(leg, i) => `
				<tr>
					<td style="padding:4px 8px;">${escapeHtml(PAYMENT_METHOD_LABELS[leg.method] || leg.method)}${legs.length > 1 ? ` (leg ${i + 1})` : ''}</td>
					<td style="padding:4px 8px;text-align:right;">${formatCAD(leg.amount)}</td>
				</tr>`,
		)
		.join('');

	const date = new Date(transaction.$createdAt || Date.now()).toLocaleString('en-CA');
	const refundedNote =
		transaction.status === 'refunded'
			? '<p style="color:#b91c1c;font-weight:bold;">This transaction was refunded.</p>'
			: '';

	return `
		<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
			<h2 style="margin-bottom:0;">SkullPOS Receipt</h2>
			<p style="color:#666;margin-top:4px;">${escapeHtml(date)} &middot; #${escapeHtml(transaction.$id.slice(-8))}</p>
			${refundedNote}
			<table style="width:100%;border-collapse:collapse;">
				<thead>
					<tr style="border-bottom:1px solid #ccc;">
						<th style="padding:4px 8px;text-align:left;">Item</th>
						<th style="padding:4px 8px;">Qty</th>
						<th style="padding:4px 8px;text-align:right;">Price</th>
						<th style="padding:4px 8px;text-align:right;">Subtotal</th>
					</tr>
				</thead>
				<tbody>${itemRows}</tbody>
			</table>
			<table style="width:100%;border-collapse:collapse;margin-top:12px;">
				${transaction.discount ? `<tr><td style="padding:4px 8px;">Discount</td><td style="padding:4px 8px;text-align:right;">-${formatCAD(transaction.discount)}</td></tr>` : ''}
				${transaction.tip ? `<tr><td style="padding:4px 8px;">Tip</td><td style="padding:4px 8px;text-align:right;">${formatCAD(transaction.tip)}</td></tr>` : ''}
				<tr style="font-weight:bold;border-top:1px solid #ccc;">
					<td style="padding:4px 8px;">Total</td>
					<td style="padding:4px 8px;text-align:right;">${formatCAD(transaction.total)}</td>
				</tr>
			</table>
			<h3 style="margin-bottom:4px;">Paid by</h3>
			<table style="width:100%;border-collapse:collapse;">${legRows}</table>
			<p style="color:#999;font-size:0.85em;margin-top:24px;">Thank you for your purchase!</p>
			${FOOTER_HTML}
		</div>`;
}

// Resolves both questions this function asks about the caller from one Users API call: may they
// call it at all, and are they admin (exempt from the recipient binding and the send cap, since
// an admin can already read every transaction directly).
//
// Fail-closed, because `execute` is still `users` (with anonymous sessions enabled, the public
// internet): this check IS the access control on a function that will mail any sale's full
// itemized receipt anywhere. It used to return allowed:true whenever it could not run, and with
// no users.read scope declared it could never run at all -- Appwrite injects x-appwrite-key only
// for a function that declares scopes, so listMemberships had no key and always threw. So both
// "cannot run" states are now `unverified`, which refuses.
async function resolveCaller(req, users, log, error) {
	const callerId = req.headers['x-appwrite-user-id'];
	if (!callerId) {
		// No user session at all -- a direct invocation with a project API key carrying
		// `execution.write`, which bypasses the execute allowlist entirely.
		return { callerId: null, allowed: false, unverified: false, admin: false };
	}
	if (!req.headers['x-appwrite-key']) {
		error(
			'No x-appwrite-key injected: team membership cannot be verified, so this receipt is refused. Grant this function the users.read scope.',
		);
		return { callerId, allowed: false, unverified: true, admin: false };
	}
	try {
		const result = await users.listMemberships(callerId);
		const memberships = (result.memberships || []).filter((m) => m.confirm);
		const allowed = memberships.some((m) => ALLOWED_TEAM_IDS.includes(m.teamId));
		if (!allowed) log(`Caller ${callerId} is in none of the allowed teams`);
		return { callerId, allowed, unverified: false, admin: memberships.some((m) => m.teamId === ADMIN_TEAM_ID) };
	} catch (err) {
		error('Could not check team membership, refusing this receipt: ' + err.message);
		return { callerId, allowed: false, unverified: true, admin: false };
	}
}

// Appwrite document IDs must be a restricted charset -- a short hash of the caller id keeps this
// valid whatever shape the id takes. Prefixed distinctly from Verify-Pin's `pin_...`,
// Giftcard-Lookup's `gcl_...` and quick-access-login's `qa_...` docs in the same collection.
function sendLimitDocId(callerId) {
	return 'rcp_' + crypto.createHash('sha1').update(String(callerId)).digest('hex').slice(0, 16);
}

function minutesFromMs(ms) {
	return Math.max(1, Math.ceil(ms / 60000));
}

// A 404 is the normal "this caller has sent nothing recently" answer. Any other failure means the
// cap cannot be enforced for this request, and an uncapped version of this endpoint is a mailer
// that leaks a sale per call -- so it is reported, and refused upstream, rather than being read
// as "no sends on record".
async function loadSendState(databases, docId, error) {
	try {
		const doc = await databases.getDocument(DATABASE_ID, RATE_LIMIT_COLLECTION_ID, docId);
		return { state: doc || null, ok: true };
	} catch (err) {
		if (err && err.code === 404) return { state: null, ok: true };
		error('Send-quota lookup failed, refusing this send rather than sending uncapped: ' + err.message);
		return { state: null, ok: false };
	}
}

// Returns whether the counter was actually persisted. A swallowed failure here is what made the
// cap decorative: with no documents.write scope every create/update threw, the counter never
// advanced past nothing, and checkSendQuota could never exceed.
async function saveSendState(databases, docId, existed, data, error) {
	try {
		if (existed) {
			await databases.updateDocument(DATABASE_ID, RATE_LIMIT_COLLECTION_ID, docId, data);
		} else {
			await databases.createDocument(DATABASE_ID, RATE_LIMIT_COLLECTION_ID, docId, data);
		}
		return true;
	} catch (err) {
		error('Failed to persist send quota: ' + err.message + ' (the documents.write scope is required)');
		return false;
	}
}

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const transactionId = body.transactionId;
	const email = String(body.email || '').trim();

	if (!transactionId) {
		return res.json({ error: 'Missing transactionId' }, 400);
	}
	if (!email || !EMAIL_PATTERN.test(email)) {
		return res.json({ error: 'A valid email address is required' }, 400);
	}

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);
	const users = new Users(client);

	const { callerId, allowed, unverified, admin } = await resolveCaller(req, users, log, error);
	if (unverified) {
		// Distinct from a refusal: this one is an operator problem (a missing scope or an Appwrite
		// blip) and it must not be answerable by simply asking again with a different id.
		return res.json({ error: 'Could not verify this device right now -- try again' }, 503);
	}
	if (!allowed) {
		error('Refused receipt request from a caller outside the allowed teams.');
		return res.json({ error: 'Unauthorized' }, 403);
	}

	// Checked before the transaction is read, so a caller who has blown the quota cannot use this
	// endpoint to probe which transaction ids exist either.
	const sendLimitKey = admin ? null : sendLimitDocId(callerId);
	let sendState = null;
	if (sendLimitKey) {
		const loaded = await loadSendState(databases, sendLimitKey, error);
		if (!loaded.ok) {
			return res.json({ error: 'Receipts are temporarily unavailable -- try again' }, 503);
		}
		sendState = loaded.state;
		const quota = checkSendQuota(sendState, Date.now());
		if (quota.exceeded) {
			log(`Receipt send quota exhausted for ${callerId} -- ${Math.ceil(quota.retryAfterMs / 1000)}s remaining`);
			return res.json(
				{ error: `Too many receipts sent from this device. Try again in ${minutesFromMs(quota.retryAfterMs)} minute(s).` },
				429,
			);
		}
	}

	let transaction;
	try {
		transaction = await databases.getDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transactionId);
	} catch (err) {
		error('Failed to read transaction: ' + err.message);
		return res.json({ error: 'Transaction not found' }, 404);
	}

	if (transaction.status !== 'complete' && transaction.status !== 'refunded') {
		return res.json({ error: `Only a completed or refunded sale can be receipted (current status: ${transaction.status})` }, 400);
	}

	// Bind the recipient to the sale wherever the sale names one. A membership purchase already
	// carries the buyer's address, so there is no legitimate reason for a till to redirect that
	// receipt somewhere else -- and it is the case where the receipt is provably not the
	// requester's own. A walk-up cash sale names nobody, so the address typed at the till is the
	// only one available; the team check and the send cap above are what bound that path.
	// Admins are exempt: they can read the transaction directly anyway, and the admin app resends
	// receipts to corrected addresses.
	const boundEmail = String(transaction.member_email || '').trim();
	if (!admin && boundEmail && boundEmail.toLowerCase() !== email.toLowerCase()) {
		log(`Refused receipt for ${transactionId}: requested recipient does not match the address on the sale`);
		return res.json({ error: 'This sale is attached to a member account -- its receipt can only be sent to the address on file.' }, 403);
	}

	let items;
	try {
		items = JSON.parse(transaction.cart) || [];
	} catch (err) {
		items = [];
	}

	const legs = derivePaymentLegs(transaction);
	const html = buildReceiptHtml(transaction, items, legs);
	const apiKey = process.env.RESEND_API_KEY;

	// Counted BEFORE the mail goes out, not after. Counting afterwards cannot enforce a cap at
	// all: by the time the write fails the mail has already been sent, so a caller whose writes
	// always fail (which is every caller, while this function lacks documents.write) sends without
	// limit. Reserving first costs one slot out of MAX_SENDS per Resend failure, which is the
	// cheaper side of the trade by a wide margin.
	if (sendLimitKey) {
		const counted = await saveSendState(databases, sendLimitKey, !!sendState, recordSend(sendState, Date.now()), error);
		if (!counted) {
			return res.json({ error: 'Receipts are temporarily unavailable -- try again' }, 503);
		}
	}

	try {
		const resendResponse = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: RECEIPT_SENDER,
				to: [email],
				cc: [ALWAYS_CC],
				subject: 'Your receipt from SkullPOS',
				html,
			}),
		});

		if (!resendResponse.ok) {
			const detail = await resendResponse.text();
			error(`Resend API returned ${resendResponse.status}: ${detail}`);
			return res.json({ error: 'Failed to send receipt email' }, 500);
		}
	} catch (err) {
		error('Failed to reach Resend API: ' + err.message);
		return res.json({ error: 'Failed to send receipt email' }, 500);
	}

	log(`Receipt for ${transactionId} emailed to ${email}`);
	return res.json({ ok: true });
};
