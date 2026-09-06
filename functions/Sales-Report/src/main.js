import { Databases, Users, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { derivePaymentLegs } from './paymentLegs.js';

// Generates the sales report, server-side. The date range a caller can
// request is clamped to the last 24 hours UNLESS the function's execution
// context says the caller is a member of a staff team -- checked via the
// Users API against req.headers['x-appwrite-user-id'], which Appwrite sets
// itself from the verified session and can't be spoofed by the client.
// This is what makes the "PIN mode capped to 24h" restriction real: the
// client has no read access to Transactions at all, so every report
// request -- staff or not -- goes through here.
//
// Staff callers also get a `previous` field: the same-shape aggregate for
// the immediately-preceding period of equal length, for the UI's
// comparison deltas. Withheld for non-staff callers -- a delta against a
// period further back than 24h would otherwise leak aggregate revenue
// data the 24h clamp is supposed to hide.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const CATEGORIES_COLLECTION_ID = '67c9ffdd0039c4e09c9a';
const INGREDIENTS_COLLECTION_ID = 'ingredients';
const STAFF_TEAM_IDS = ['68e35aed00144b8cde9d', '68ffce9a0015d2dc0b0d', '68ffcecc0026f78f0af8'];
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

async function isStaff(users, callerId, error) {
	if (!callerId) return false;
	try {
		const result = await users.listMemberships(callerId);
		return (result.memberships || []).some((m) => STAFF_TEAM_IDS.includes(m.teamId) && m.confirm);
	} catch (err) {
		error('Failed to check team membership (treating as non-staff): ' + err.message);
		return false;
	}
}

function emptyReport() {
	return {
		ItemsSold: [],
		totalSales: 0,
		tips: 0,
		giftcardAmount: 0,
		cashAmount: 0,
		cardAmount: 0,
		discountAmount: 0,
		amountPaid: 0,
		cogs: 0,
		alcoholAmount: 0,
		foodAmount: 0,
		nonAlcoholicDrinksAmount: 0,
		otherAmountSold: 0,
	};
}

function buildReport(transactions, categoriesById, ingredientCostById) {
	if (transactions.length === 0) return emptyReport();

	let ItemsSold = [],
		totalSales = 0,
		tips = 0,
		giftcardAmount = 0,
		cashAmount = 0,
		cardAmount = 0,
		discountAmount = 0,
		cogs = 0,
		amountPaid = 0,
		alcoholAmount = 0,
		foodAmount = 0,
		nonAlcoholicDrinksAmount = 0,
		otherAmountSold = 0;

	transactions.forEach((item) => {
		let cart;
		try {
			cart = JSON.parse(item.cart) || [];
		} catch (err) {
			cart = [];
		}

		cart.forEach((cartItem) => {
			if (!ItemsSold.find((i) => i.name === cartItem.name)) {
				ItemsSold.push({ name: cartItem.name, quantity: 0, revenue: 0, cogs: 0 });
			}
			let existingItem = ItemsSold.find((i) => i.name === cartItem.name);
			const quantity = cartItem.quantity || 0;
			const itemCost = cartItem.price || 0;

			existingItem.quantity += quantity;
			existingItem.revenue += itemCost * quantity;

			const catId =
				cartItem.categories && typeof cartItem.categories === 'object'
					? cartItem.categories.$id
					: cartItem.categories;
			const cat = categoriesById[catId];
			const isAlcohol = cartItem.alcohol === true || cat?.alcohol === true;
			const catName = cat?.name || '';

			if (isAlcohol) {
				alcoholAmount += itemCost * quantity;
			} else if (catName === 'Food') {
				foodAmount += itemCost * quantity;
			} else if (catName.includes('Non-Alcoholic')) {
				nonAlcoholicDrinksAmount += itemCost * quantity;
			} else {
				otherAmountSold += itemCost * quantity;
			}

			if (Array.isArray(cartItem.ingredients) && cartItem.ingredients.length > 0) {
				const perUnitCogs = cartItem.ingredients.reduce(
					(sum, ingredientId) => sum + (ingredientCostById[ingredientId] || 0),
					0,
				);
				const itemCogs = perUnitCogs * quantity;
				existingItem.cogs += itemCogs;
				cogs += itemCogs;
			} else if (cartItem.container_cost && cartItem.drinks_per_cont) {
				let itemCoGS = cartItem.container_cost / cartItem.drinks_per_cont;
				itemCoGS = itemCoGS + (cartItem.additional_drink_costs || 0);
				const itemCogs = itemCoGS * quantity;
				existingItem.cogs += itemCogs;
				cogs += itemCogs;
			}
		});

		totalSales += (item.total || 0) + (item.discount || 0);
		tips += item.tip || 0;
		discountAmount += item.discount || 0;

		// Bucket by payment leg rather than the whole transaction's single
		// payment_method -- a split sale (cash+card, giftcard+card, etc.)
		// has amounts in more than one bucket.
		derivePaymentLegs(item).forEach((leg) => {
			const amount = parseInt(leg.amount) || 0;
			amountPaid += amount;
			if (leg.method === 'cash') cashAmount += amount;
			else if (leg.method === 'stripe') cardAmount += amount;
			else if (leg.method === 'giftcard') giftcardAmount += amount;
		});
	});

	return {
		ItemsSold,
		totalSales,
		tips,
		giftcardAmount,
		cashAmount,
		cardAmount,
		discountAmount,
		amountPaid,
		cogs,
		alcoholAmount,
		foodAmount,
		nonAlcoholicDrinksAmount,
		otherAmountSold,
	};
}

export default async ({ req, res, log, error }) => {
	let body;
	try {
		body = JSON.parse(req.body || '{}');
	} catch (err) {
		return res.json({ error: 'Invalid request body' }, 400);
	}

	const client = await createAppwriteClient(req);
	const databases = new Databases(client);
	const users = new Users(client);

	const callerId = req.headers['x-appwrite-user-id'];
	const staff = await isStaff(users, callerId, error);

	let endDate = body.endDate ? new Date(body.endDate) : new Date();
	let startDate = body.startDate ? new Date(body.startDate) : null;
	const hadBoundedStart = !!startDate;

	const earliestAllowed = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
	if (!staff && (!startDate || startDate < earliestAllowed)) {
		startDate = earliestAllowed;
	}

	const startIso = (startDate || new Date(0)).toISOString();
	const endIso = endDate.toISOString();
	const test = !!body.test;

	const categories = await fetchAllDocuments(databases, DATABASE_ID, CATEGORIES_COLLECTION_ID);
	const categoriesById = {};
	categories.forEach((c) => {
		categoriesById[c.$id] = c;
	});

	let ingredientCostById = {};
	try {
		const ingredientDocs = await fetchAllDocuments(databases, DATABASE_ID, INGREDIENTS_COLLECTION_ID);
		ingredientDocs.forEach((ing) => {
			const caseQty = ing.case_qty || 1;
			const contQty = ing.cont_qty || 1;
			ingredientCostById[ing.$id] = (ing.case_cost || 0) / (caseQty * contQty);
		});
	} catch (err) {
		error('Error getting ingredients for COGS: ' + err.message);
	}

	// `channel` ("pos" | "self_checkout") lets staff compare kiosk sales
	// against regular POS sales -- omitted entirely (no filter, all
	// channels combined) when the caller doesn't ask for one, so every
	// existing caller is unaffected.
	async function fetchTransactionsInRange(startI, endI) {
		return fetchAllDocuments(databases, DATABASE_ID, TRANSACTIONS_COLLECTION_ID, [
			Query.equal('status', 'complete'),
			test ? Query.equal('testing', true) : Query.notEqual('testing', true),
			Query.greaterThanEqual('$createdAt', startI),
			Query.lessThanEqual('$createdAt', endI),
			...(body.channel ? [Query.equal('channel', body.channel)] : []),
		]);
	}

	const transactions = await fetchTransactionsInRange(startIso, endIso);
	const current = buildReport(transactions, categoriesById, ingredientCostById);

	// Comparison period: staff only, and only when the request actually
	// had a bounded start (an "All Time" request has no equal-length prior
	// period to compare against).
	let previous = null;
	if (staff && hadBoundedStart) {
		const rangeMs = endDate.getTime() - startDate.getTime();
		const prevEnd = new Date(startDate.getTime());
		const prevStart = new Date(startDate.getTime() - rangeMs);
		const prevTransactions = await fetchTransactionsInRange(prevStart.toISOString(), prevEnd.toISOString());
		previous = buildReport(prevTransactions, categoriesById, ingredientCostById);
	}

	return res.json({ ...current, previous, restricted: !staff });
};
