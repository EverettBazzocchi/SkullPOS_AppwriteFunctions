import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';

// Runs daily (see appwrite.config.json's schedule) to cancel transactions that have been
// stuck in "pending" for 1+ hour -- a real card payment resolves in seconds/minutes, so a
// pending transaction that old is almost certainly abandoned (customer walked away, terminal
// disconnected, etc.), not one still genuinely in progress. Uses the exact same status
// transition Transaction-SetStatus already allows a staff member to do manually
// (pending -> cancelled only) -- this just does it automatically, on staleness instead of an
// explicit staff action.
//
// Also callable directly (admin-team execute permission) for manual/testing runs, but the
// primary trigger is the schedule.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const GIFTCARDS_COLLECTION_ID = 'giftcards';
const STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour
const PAGE_SIZE = 100;

// The methods a transaction's `payment_method` can carry that mean "a card charge was part of
// this sale's plan" -- set at creation time by the register/kiosk (POS/src/utils/checkout.js),
// before the terminal is ever tapped. A stale pending row with one of these and NO recorded
// stripe leg is ambiguous: usually an abandoned cart, but it is also the exact shape a card that
// WAS captured and then failed to record leaves behind (the leg only exists once
// Transaction-RecordPayment succeeds). Cancelling those is still right -- leaving every abandoned
// tap-that-never-happened pending forever helps nobody -- but each one has to come out of the run
// flagged, so the morning reconciliation can check it against Stripe instead of discovering it at
// a chargeback.
const CARD_CAPABLE_PAYMENT_METHODS = new Set(['stripe', 'giftcard+stripe', 'split']);

// A split-tender sale can have one or more legs already recorded (by
// Transaction-RecordPayment) against a transaction that's STILL "pending"
// (e.g. giftcard covered part of the total, the card portion never
// finished) -- auto-cancelling it outright would silently strand whatever
// those legs already moved. Only the modern `payments` JSON array can hold
// a leg on a still-pending transaction: transactions from before the
// split-payment migration never supported partial/split tender, so
// there's nothing legacy to derive here (contrast Stripe-RefundPayment's
// derivePaymentLegs, which also synthesizes a leg from legacy single-method
// fields -- only relevant for already-*complete* transactions).
function getRecordedLegs(transaction) {
	if (!transaction.payments) return [];
	try {
		const parsed = JSON.parse(transaction.payments);
		return Array.isArray(parsed) ? parsed : [];
	} catch (err) {
		return [];
	}
}

// A giftcard leg is the ONLY leg this unattended sweep knows how to reverse by itself (credit the
// balance back -- a pure ledger fix, no external money movement). Everything else means real money
// already moved outside this database: a stripe leg is a captured card that needs a real refund, a
// cash leg is notes already in the drawer that need a manual payout/void decision. Enumerating
// what to skip (the previous shape: `method === 'stripe'`) meant any method that wasn't explicitly
// listed -- cash, and any method added later -- fell through to a silent cancel with no reversal
// and no review entry, so the money it moved corresponded to no recorded sale. Enumerate what is
// SAFE instead, and treat everything else as needing a human.
function unreversibleLegs(legs) {
	return legs.filter((leg) => leg.method !== 'giftcard');
}

/** Why this stale transaction may already have taken money, or null if there's no sign it did. */
function chargeEvidence(transaction, legs) {
	const risky = unreversibleLegs(legs);
	if (risky.length > 0) {
		const summary = risky.map((leg) => `${leg.method || 'unknown'} ${leg.amount}${leg.stripeId ? ` (${leg.stripeId})` : ''}`).join(', ');
		return {
			hard: true,
			reason: `has recorded payment leg(s) this sweep cannot reverse on its own -- ${summary} -- settle them manually first`,
		};
	}
	if (transaction.stripe_id) {
		return { hard: true, reason: `carries stripe_id ${transaction.stripe_id} -- check Stripe and refund it properly before cancelling` };
	}
	if (CARD_CAPABLE_PAYMENT_METHODS.has(transaction.payment_method)) {
		return {
			hard: false,
			reason: `cancelled, but payment_method "${transaction.payment_method}" means a card charge was started and no leg was ever recorded -- reconcile against Stripe`,
		};
	}
	return null;
}

async function listStalePendingTransactions(databases, cutoffIso) {
	let all = [];
	let lastId = null;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const queries = [
			Query.equal('status', 'pending'),
			Query.lessThanEqual('$createdAt', cutoffIso),
			Query.orderAsc('$id'),
			Query.limit(PAGE_SIZE),
		];
		if (lastId) queries.push(Query.cursorAfter(lastId));

		const page = await databases.listDocuments(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, queries);
		const batch = page.documents || [];
		all = all.concat(batch);

		if (batch.length < PAGE_SIZE) break;
		lastId = batch[batch.length - 1].$id;
	}

	return all;
}

export default async ({ req, res, log, error }) => {
	const client = await createAppwriteClient(req);
	const databases = new Databases(client);

	const cutoff = new Date(Date.now() - STALE_AFTER_MS);

	let staleTransactions;
	try {
		staleTransactions = await listStalePendingTransactions(databases, cutoff.toISOString());
	} catch (err) {
		error('Failed to list pending transactions: ' + err.message);
		return res.json({ error: 'Failed to list pending transactions' }, 500);
	}

	let cancelled = 0;
	const failures = [];
	const needsManualReview = [];
	const cancelledPossiblyCharged = [];

	for (const transaction of staleTransactions) {
		const legs = getRecordedLegs(transaction);
		const evidence = chargeEvidence(transaction, legs);

		// Hard evidence (an unreversible recorded leg, or a stripe_id on the row) means real money
		// already moved and reversing it is not a status change this unattended sweep can make on
		// its own. Skip it (not a "failure") and surface it so a human decides: refund/void it
		// properly, or leave the sale as-is.
		if (evidence && evidence.hard) {
			error(`Skipping auto-cancel of ${transaction.$id}: it ${evidence.reason}.`);
			needsManualReview.push({ transactionId: transaction.$id, reason: evidence.reason });
			continue;
		}

		// Flip status FIRST, before reversing any giftcard leg below -- this is the idempotency
		// guard (mirrors Stripe-RefundPayment/Transaction-SetStatus). If a reversal fails and
		// this transaction is picked up again on a future run, it's no longer "pending" so it
		// won't be re-selected in the first place.
		try {
			await databases.updateDocument(DATABASE_ID, TRANSACTIONS_COLLECTION_ID, transaction.$id, { status: 'cancelled' });
			cancelled++;
		} catch (err) {
			error(`Failed to cancel transaction ${transaction.$id}: ` + err.message);
			failures.push({ transactionId: transaction.$id, error: err.message });
			continue;
		}

		// Soft evidence: cancelled, but it might have taken money without leaving a leg behind.
		// Reported (and logged as an error, not a log line) so it lands in front of a human.
		if (evidence) {
			error(`Auto-cancelled ${transaction.$id} but it may already have been charged: ${evidence.reason}.`);
			cancelledPossiblyCharged.push({
				transactionId: transaction.$id,
				paymentMethod: transaction.payment_method,
				amount: transaction.payment_due,
				reason: evidence.reason,
			});
		}

		const giftcardLegs = legs.filter((leg) => leg.method === 'giftcard' && leg.giftcardId);
		for (const leg of giftcardLegs) {
			try {
				const giftcard = await databases.getDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, leg.giftcardId);
				const newBalance = (parseInt(giftcard.balance) || 0) + (parseInt(leg.amount) || 0);
				await databases.updateDocument(DATABASE_ID, GIFTCARDS_COLLECTION_ID, leg.giftcardId, { balance: newBalance });
				log(`Giftcard ${leg.giftcardId} credited back ${leg.amount} (transaction ${transaction.$id} auto-cancelled)`);
			} catch (err) {
				error(`Transaction ${transaction.$id} was cancelled, but failed to reverse its giftcard leg ${leg.giftcardId}: ` + err.message);
				failures.push({
					transactionId: transaction.$id,
					error: `cancelled, but failed to restore giftcard ${leg.giftcardId}'s balance: ${err.message}`,
				});
			}
		}
	}

	log(
		`Cancelled ${cancelled}/${staleTransactions.length} stale pending transaction(s) (pending 1+ hour, cutoff ${cutoff.toISOString()}).` +
			(needsManualReview.length > 0 ? ` ${needsManualReview.length} skipped for manual review (money already moved).` : '') +
			(cancelledPossiblyCharged.length > 0 ? ` ${cancelledPossiblyCharged.length} cancelled but flagged as possibly charged.` : ''),
	);

	return res.json({
		cutoff: cutoff.toISOString(),
		staleFound: staleTransactions.length,
		cancelled,
		failures,
		needsManualReview,
		cancelledPossiblyCharged,
	});
};
