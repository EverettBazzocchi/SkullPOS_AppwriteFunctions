import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { eventSalesWindow } from './eventWindow.js';
import { buildEventSales } from './eventSales.js';
import { fetchEventTicketRevenue, buildTicketBoundsByEventId } from './ticketRevenue.js';

// Runs daily. For every event whose computed window (see eventWindow.js) has already ended,
// (re)computes its sales figures from live (non-test), complete Transactions created within
// that window, plus ticket sales for that event (matched by name, live/non-test only), and
// writes them onto the Events document:
//   - alcohol_sales/food_sales/drink_sales/discount_amount/gift_card_amount/tips_earned/
//     cash_sales/card_sales/cogs -- POS-only, from buildEventSales()
//   - pos_revenue -- POS-only revenue (what buildEventSales calls "revenue")
//   - revenue -- pos_revenue + ticket sales combined (the event's actual total take)
//   - profit -- revenue (combined) - cogs (POS-only; tickets have no COGS concept here)
// Recomputes every past event on every run (idempotent overwrite) rather than tracking a
// "already rolled up" flag -- correctness (a late-arriving transaction, a refund, a ticket sale
// recorded after the fact) matters more than the trivial cost of re-aggregating at this data
// volume. inventory, sales, and djs are deliberately left untouched.
const DATABASE_ID = '67c9ffd9003d68236514';
const EVENTS_COLLECTION_ID = '68e400210008d19bb5c9';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const CATEGORIES_COLLECTION_ID = '67c9ffdd0039c4e09c9a';
const INGREDIENTS_COLLECTION_ID = 'ingredients';
const PAGE_SIZE = 100;

async function fetchAllDocuments(databases, databaseId, collectionId, extraQueries = []) {
	let allDocuments = [];
	let lastId = null;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const queries = [...extraQueries, Query.orderAsc('$id'), Query.limit(PAGE_SIZE)];
		if (lastId) queries.push(Query.cursorAfter(lastId));

		const page = await databases.listDocuments(databaseId, collectionId, queries);
		const docs = page.documents || [];
		allDocuments = allDocuments.concat(docs);

		if (docs.length < PAGE_SIZE) break;
		lastId = docs[docs.length - 1].$id;
	}

	return allDocuments;
}

export default async ({ req, res, log, error }) => {
	const client = await createAppwriteClient(req);
	const databases = new Databases(client);
	const now = new Date();

	let events;
	try {
		events = await fetchAllDocuments(databases, DATABASE_ID, EVENTS_COLLECTION_ID);
	} catch (err) {
		error('Failed to list events: ' + err.message);
		return res.json({ error: 'Failed to list events' }, 500);
	}

	const withWindows = events.map((event) => ({ event, window: eventSalesWindow(event) }));

	// An event with a date but no usable window (its bar open and close are the same, so the window
	// is zero-length) must NOT be rolled up: it matches no transactions, and writing that result
	// would overwrite the event's already-correct figures with zeroes and report it as a success.
	// Reported instead, the way a per-event failure already is. An event with no date at all is a
	// draft that was never scheduled -- skipped silently, as always.
	const skipped = withWindows
		.filter(({ event, window }) => !window && event.date)
		.map(({ event }) => ({
			id: event.$id,
			name: event.name,
			reason: 'no usable sales window (check barOpenTime/barCloseTime -- open and close are the same, or unparseable)',
		}));
	skipped.forEach((s) => error(`Skipping rollup for event ${s.id} ("${s.name}"): ${s.reason}.`));

	const dueEvents = withWindows.filter(({ window }) => window && window.end <= now);

	if (dueEvents.length === 0) {
		log('No events with a completed window to roll up.');
		return res.json({ processed: 0, updated: [], failures: [], skipped, needsReview: [] });
	}

	// Computed across ALL events with a window, not just the due ones -- a repeating event name's
	// next occurrence may still be in the future, and it is what bounds this one's tickets.
	const ticketBoundsByEventId = buildTicketBoundsByEventId(withWindows.filter(({ window }) => window));

	let categoriesById = {};
	let ingredientCostById = {};
	try {
		const categories = await fetchAllDocuments(databases, DATABASE_ID, CATEGORIES_COLLECTION_ID);
		categories.forEach((c) => {
			categoriesById[c.$id] = c;
		});
	} catch (err) {
		error('Failed to list categories (alcohol/food classification will be less accurate): ' + err.message);
	}
	try {
		const ingredients = await fetchAllDocuments(databases, DATABASE_ID, INGREDIENTS_COLLECTION_ID);
		ingredients.forEach((ing) => {
			const caseQty = ing.case_qty || 1;
			const contQty = ing.cont_qty || 1;
			ingredientCostById[ing.$id] = (ing.case_cost || 0) / (caseQty * contQty);
		});
	} catch (err) {
		error('Failed to list ingredients (COGS will be incomplete): ' + err.message);
	}

	const updated = [];
	const failures = [];
	const needsReview = [];

	for (const { event, window } of dueEvents) {
		try {
			const transactions = await fetchAllDocuments(databases, DATABASE_ID, TRANSACTIONS_COLLECTION_ID, [
				Query.equal('status', 'complete'),
				Query.notEqual('testing', true),
				Query.greaterThanEqual('$createdAt', window.start.toISOString()),
				Query.lessThanEqual('$createdAt', window.end.toISOString()),
			]);

			const posSales = buildEventSales(transactions, categoriesById, ingredientCostById);
			const ticketRevenue = await fetchEventTicketRevenue(
				databases,
				DATABASE_ID,
				event.name,
				fetchAllDocuments,
				ticketBoundsByEventId[event.$id] || null,
			);

			// Tickets are joined to an event by its free-text NAME, which an admin can edit at any
			// time while the already-written tickets keep the old string. Recomputing zero ticket
			// revenue for an event that currently records some is the exact signature of that
			// rename (or of tickets having been re-pointed elsewhere) -- and the write below is an
			// unconditional overwrite, so going ahead would silently erase real, already-banked
			// ticket revenue with nothing logged. Refuse the write and report it; a real
			// full-refund of every ticket produces the same signature, and is rare enough to be
			// worth a human confirming rather than losing the figure to a typo fix.
			const recordedTicketRevenue = (event.revenue || 0) - (event.pos_revenue || 0);
			if (ticketRevenue === 0 && recordedTicketRevenue > 0) {
				const reason =
					`rollup found no tickets matching the name "${event.name}" but the event already records ` +
					`${recordedTicketRevenue} in ticket revenue -- refusing to overwrite it (was the event renamed?)`;
				error(`Skipping rollup for event ${event.$id}: ${reason}.`);
				needsReview.push({ id: event.$id, name: event.name, reason });
				continue;
			}

			const sales = {
				...posSales,
				pos_revenue: posSales.revenue,
				revenue: posSales.revenue + ticketRevenue,
				profit: posSales.revenue + ticketRevenue - posSales.cogs,
			};
			await databases.updateDocument(DATABASE_ID, EVENTS_COLLECTION_ID, event.$id, sales);
			updated.push(event.$id);
		} catch (err) {
			error(`Failed to roll up sales for event ${event.$id} ("${event.name}"): ` + err.message);
			failures.push({ id: event.$id, name: event.name, error: err.message });
		}
	}

	log(
		`Rolled up sales for ${updated.length}/${dueEvents.length} due event(s).` +
			(skipped.length > 0 ? ` ${skipped.length} skipped for having no usable window.` : '') +
			(needsReview.length > 0 ? ` ${needsReview.length} left untouched pending review.` : ''),
	);
	return res.json({ processed: dueEvents.length, updated, failures, skipped, needsReview });
};
