import { Databases, Users, Query } from 'node-appwrite';
import { createAppwriteClient } from './appwriteClient.js';
import { derivePaymentLegs } from './paymentLegs.js';

// Generates the sales report, server-side. The date range a caller can
// request is clamped to the last 24 hours UNLESS the function's execution
// context says the caller is a member of the admin team -- checked via
// the Users API against req.headers['x-appwrite-user-id'], which Appwrite
// sets itself from the verified session and can't be spoofed by the
// client. This is what makes the "PIN mode capped to 24h" restriction
// real: the client has no read access to Transactions at all, so every
// report request -- admin or not -- goes through here.
//
// Only admin-team members count as unrestricted here -- POS-team members
// get the exact same 24h clamp as a quick-access PIN cashier or a
// no-team Google account (see POS/src/App.js's three-tier mapping this
// mirrors). POS team membership still grants other things (e.g. refund
// execute-permission on Stripe-RefundPayment), just not this.
//
// Admin callers also get a `previous` field: the same-shape aggregate for
// the immediately-preceding period of equal length, for the UI's
// comparison deltas. Withheld for everyone else -- a delta against a
// period further back than 24h would otherwise leak aggregate revenue
// data the 24h clamp is supposed to hide.
const DATABASE_ID = '67c9ffd9003d68236514';
const TRANSACTIONS_COLLECTION_ID = '68e4cd3500179ce661c6';
const CATEGORIES_COLLECTION_ID = '67c9ffdd0039c4e09c9a';
const INGREDIENTS_COLLECTION_ID = 'ingredients';
const ADMIN_TEAM_ID = '68e35aed00144b8cde9d';
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

async function isAdmin(users, callerId, error) {
	if (!callerId) return false;
	try {
		const result = await users.listMemberships(callerId);
		return (result.memberships || []).some((m) => m.teamId === ADMIN_TEAM_ID && m.confirm);
	} catch (err) {
		error('Failed to check team membership (treating as non-admin): ' + err.message);
		return false;
	}
}

// Tips are only ever taken on the card reader: Transaction-RecordPayment reads
// `amount_details.tip.amount` off the captured PaymentIntent, keeps `leg.amount`
// tip-EXCLUSIVE and carries the tip alongside it as `leg.tip` (main.js:255-327 there). So what
// Stripe actually deposited for a sale is the stripe leg amount PLUS the stripe leg tip, and
// that sum is the only figure that reconciles against a payout. Legacy rows predate the
// per-leg field and carry only `transaction.tip`; by the same reasoning that tip was taken on
// the reader, so it is attributed to the card leg when the sale had one -- and to nothing at
// all when it did not, rather than inventing card money that was never deposited.
function cardTipsFor(transaction, legs) {
	const perLegTotal = legs.reduce((sum, leg) => sum + (parseInt(leg.tip) || 0), 0);
	if (perLegTotal > 0) {
		return legs.reduce((sum, leg) => sum + (leg.method === 'stripe' ? parseInt(leg.tip) || 0 : 0), 0);
	}
	const recordedTip = parseInt(transaction.tip) || 0;
	return legs.some((leg) => leg.method === 'stripe') ? recordedTip : 0;
}

function emptyReport() {
	return {
		ItemsSold: [],
		totalSales: 0,
		tips: 0,
		giftcardAmount: 0,
		cashAmount: 0,
		cardAmount: 0,
		cardAmountInclTips: 0,
		discountAmount: 0,
		amountPaid: 0,
		amountPaidInclTips: 0,
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
		cardTips = 0,
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
		const legs = derivePaymentLegs(item);
		cardTips += cardTipsFor(item, legs);
		legs.forEach((leg) => {
			const amount = parseInt(leg.amount) || 0;
			amountPaid += amount;
			if (leg.method === 'cash') cashAmount += amount;
			else if (leg.method === 'stripe') cardAmount += amount;
			else if (leg.method === 'giftcard') giftcardAmount += amount;
		});
	});

	// `cardAmount`/`amountPaid` are what was paid toward the CART, exclusive of tips -- which is
	// the right number for item/category revenue but reconciles against nothing: the Stripe payout
	// and the customer's statement both include the tip. So both are also reported tip-inclusive,
	// as their own fields rather than by redefining the existing ones (every existing caller reads
	// the tip-exclusive figures and the category breakdown has to keep summing to them).
	// `cardAmountInclTips` counts only the tips attributable to a card leg -- it is specifically
	// the Stripe-payout figure -- while `amountPaidInclTips` counts every recorded tip, because it
	// answers "how much money changed hands", including a tip on a sale that never touched a card.
	return {
		ItemsSold,
		totalSales,
		tips,
		giftcardAmount,
		cashAmount,
		cardAmount,
		cardAmountInclTips: cardAmount + cardTips,
		discountAmount,
		amountPaid,
		amountPaidInclTips: amountPaid + tips,
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
	const admin = await isAdmin(users, callerId, error);

	let endDate = body.endDate ? new Date(body.endDate) : new Date();
	let startDate = body.startDate ? new Date(body.startDate) : null;
	const hadBoundedStart = !!startDate;

	const earliestAllowed = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
	if (!admin && (!startDate || startDate < earliestAllowed)) {
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

	// Comparison period: admin only, and only when the request actually
	// had a bounded start (an "All Time" request has no equal-length prior
	// period to compare against).
	let previous = null;
	if (admin && hadBoundedStart) {
		const rangeMs = endDate.getTime() - startDate.getTime();
		const prevEnd = new Date(startDate.getTime());
		const prevStart = new Date(startDate.getTime() - rangeMs);
		const prevTransactions = await fetchTransactionsInRange(prevStart.toISOString(), prevEnd.toISOString());
		previous = buildReport(prevTransactions, categoriesById, ingredientCostById);
	}

	return res.json({ ...current, previous, restricted: !admin });
};
