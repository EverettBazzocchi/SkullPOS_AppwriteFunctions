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
//   1. who may call this function at all, which Appwrite decides from the `execute` list (see
//      classifyCaller below),
//   2. a sale attached to a member account can only be receipted to the address on that sale, and
//   3. one caller's sends are capped per 15 minutes (sendLimit.js), reserved before the mail goes
//      out so the cap holds even when the counter write fails.
// Rule 3 fails CLOSED (503) when it cannot run, which needs the documents.write scope: nothing else
// caps this mailer, and its counter can only fail while the Appwrite Databases API is failing, at
// which point the transaction below cannot be read either. Rule 1 deliberately does NOT work that
// way -- see classifyCaller.
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
// Every email this system sends carries this address as `reply_to` (replies reach the admin
// without copying them on every send) and closes with the same contact line -- see the identical
// constants in Transaction-RecordPayment/Admin-EmailDj/Admin-EmailBartender/
// Admin-EmailCoordinator (each function stays self-contained, no shared email module).
// Deliberately NOT a CC any more -- was ALWAYS_CC.
const ADMIN_EMAIL = 'everett.bazzocchi@skullspace.ca';
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

// WHO MAY CALL THIS FUNCTION IS APPWRITE'S DECISION, NOT THIS FILE'S. Identical in shape and
// reasoning to stripe-getConnectionToken's and Giftcard-Lookup's guard -- the three must stay the
// same shape, because an inconsistency between them is how the next incident starts.
//
// The function's `execute` list names three teams -- admin (68e35aed00144b8cde9d), POS
// (68ffcecc0026f78f0af8) and PIN Payment Access (6a9cbb1c95ea7d59dd8c), the team Verify-Pin joins a
// device to once a PIN is accepted -- and the platform checks that list when the execution is
// created, before this module is ever loaded. Appwrite grants a caller the `team:<id>` role only
// for a membership whose `confirm` is true, so "a confirmed member of one of those three teams" has
// already been proven by the time this code runs; a bare anonymous session belongs to none of them
// and never reaches here. Verified against the live function on 2026-09-13 with
// `appwrite functions get --function-id 6a9cd1ed552967ba3560`: `execute` is those three teams and
// nothing else.
//
// So this function checks the ONE thing that allowlist does not cover: whether there is a caller at
// all. A project API key carrying `execution.write` can invoke a function directly -- Appwrite
// cancels permission checks for API-key requests, so the `execute` list is not consulted -- and
// such an execution has no session user, so `x-appwrite-user-id` arrives absent or empty.
//
// There is deliberately NO third "I could not tell" state, and nothing on this path calls out to
// another service. An earlier version re-derived team membership here through
// users.listMemberships() and refused with a 503 whenever that call could not answer -- the same
// code that, on 2026-09-13, 503'd a live Terminal reader and the bar's giftcard scanning when the
// Users API answered `User with the requested ID could not be found` for a caller id it could not
// resolve. Re-proving what Appwrite has already proven can only ever agree or be wrong, and being
// wrong takes a till offline.
//
// Whatever replaces this must keep both properties: an API-key-only invocation is refused, and no
// external lookup can turn a session caller away. Both are covered by tests in main.test.js.
function classifyCaller(req) {
	// 'allowed' | 'denied' -- two states, because every input this needs is already on the request.
	const callerId = req.headers['x-appwrite-user-id'];
	if (!callerId) {
		// No session user: a direct invocation with a project API key carrying `execution.write`,
		// which is the one way past the execute allowlist. Appwrite sends this header with an empty
		// value rather than omitting it, so "" must be refused as firmly as a missing header.
		return 'denied';
	}
	return 'allowed';
}

// Admin is a PRIVILEGE UPGRADE, not the authorization decision above, and the difference is what
// keeps this lookup safe to make. An admin is exempt from the recipient binding and the send cap
// (they can read every transaction directly anyway, and the admin app resends receipts to corrected
// addresses), and nothing but the Users API can tell us whether a caller is one -- Appwrite injects
// no team roles into a function's headers.
//
// Because it only ever grants something extra, a failure here is a DEGRADATION, never a refusal:
// any answer other than a definitive "yes, confirmed member of the admin team" means the caller is
// treated as an ordinary till, which is the same path every POS device takes and which still works
// end to end. It cannot produce a 503, and it cannot stop a receipt being sent to the address the
// sale already names. The one visible residual is that an admin cannot REDIRECT a member sale's
// receipt while this lookup is failing -- see the recipient binding in the handler; that refusal
// falls back to the safe default (the address on the sale) rather than taking the endpoint down.
async function isAdminCaller(req, users, callerId, error) {
	if (!req.headers['x-appwrite-key']) {
		// Appwrite injects the key only for a function that declares scopes. Without it the Users
		// API cannot be called at all -- so treat the caller as an ordinary till and carry on.
		error('No x-appwrite-key injected, so admin status cannot be checked -- treating this caller as a normal till. Grant this function the users.read scope to restore the admin exemptions.');
		return false;
	}
	try {
		const result = await users.listMemberships(callerId);
		return (result.memberships || []).some((m) => m.teamId === ADMIN_TEAM_ID && m.confirm);
	} catch (err) {
		error('Could not check admin status, treating this caller as a normal till (the receipt is still sent): ' + err.message);
		return false;
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

	if (classifyCaller(req) !== 'allowed') {
		error('Refused receipt request: no session user, so this was a direct API-key invocation.');
		return res.json({ error: 'Unauthorized' }, 403);
	}
	const callerId = req.headers['x-appwrite-user-id'];

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);
	const users = new Users(client);

	const admin = await isAdminCaller(req, users, callerId, error);

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
	// receipts to corrected addresses. If the admin lookup could not run (see isAdminCaller), the
	// caller is not treated as admin and lands here -- so a redirect is refused while the Users API
	// is unavailable. That is the deliberate residual: it falls back to the address the sale already
	// names, which is a narrowed privilege for one operator action, not an endpoint going dark.
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
				reply_to: ADMIN_EMAIL,
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
