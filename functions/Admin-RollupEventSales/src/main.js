import { Databases, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { eventSalesWindow } from './eventWindow.js';
import { buildEventSales } from './eventSales.js';

// Runs daily. For every event whose computed window (see eventWindow.js) has already ended,
// (re)computes its sales figures from live (non-test), complete Transactions created within
// that window and writes them onto the Events document -- alcohol_sales, food_sales,
// drink_sales, discount_amount, gift_card_amount, tips_earned, cash_sales, card_sales, revenue,
// cogs, profit. Recomputes every past event on every run (idempotent overwrite) rather than
// tracking a "already rolled up" flag -- correctness (a late-arriving transaction, a refund,
// keeps the numbers fresh) matters more than the trivial cost of re-aggregating at this data
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

	const dueEvents = events
		.map((event) => ({ event, window: eventSalesWindow(event) }))
		.filter(({ window }) => window && window.end <= now);

	if (dueEvents.length === 0) {
		log('No events with a completed window to roll up.');
		return res.json({ processed: 0, updated: [], failures: [] });
	}

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

	for (const { event, window } of dueEvents) {
		try {
			const transactions = await fetchAllDocuments(databases, DATABASE_ID, TRANSACTIONS_COLLECTION_ID, [
				Query.equal('status', 'complete'),
				Query.notEqual('testing', true),
				Query.greaterThanEqual('$createdAt', window.start.toISOString()),
				Query.lessThanEqual('$createdAt', window.end.toISOString()),
			]);

			const sales = buildEventSales(transactions, categoriesById, ingredientCostById);
			await databases.updateDocument(DATABASE_ID, EVENTS_COLLECTION_ID, event.$id, sales);
			updated.push(event.$id);
		} catch (err) {
			error(`Failed to roll up sales for event ${event.$id} ("${event.name}"): ` + err.message);
			failures.push({ id: event.$id, name: event.name, error: err.message });
		}
	}

	log(`Rolled up sales for ${updated.length}/${dueEvents.length} due event(s).`);
	return res.json({ processed: dueEvents.length, updated, failures });
};
