import { Databases } from 'node-appwrite';
import fetch from 'node-fetch';
import { createAppwriteClient } from './appwriteClient.js';
import { derivePaymentLegs } from './paymentLegs.js';

// Emails a receipt for an already-completed (or refunded) sale to a
// customer-supplied address. Separate from Appwrite's own auth-email SMTP
// (used only for verification/recovery/magic-URL emails) -- this calls
// Resend's plain HTTP API directly, since a receipt is arbitrary custom
// content, not one of Appwrite's built-in auth email types.
//
// This runtime is node-16.0 (the only Node runtime this self-hosted
// instance offers), which predates global fetch -- node-fetch polyfills it
// rather than pulling in a full HTTP client/SDK.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const RECEIPT_SENDER = 'SkullPOS <SkullPOS@mail.shotty.tech>';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

	let items;
	try {
		items = JSON.parse(transaction.cart) || [];
	} catch (err) {
		items = [];
	}

	const legs = derivePaymentLegs(transaction);
	const html = buildReceiptHtml(transaction, items, legs);
	const apiKey = process.env.RESEND_API_KEY;

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
