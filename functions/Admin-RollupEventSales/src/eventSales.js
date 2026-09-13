import { derivePaymentLegs } from './paymentLegs.js';

// Classification/aggregation logic ported from Sales-Report/src/main.js's buildReport() --
// kept behaviorally identical (same alcohol/Food/Non-Alcoholic/other bucketing, same COGS
// derivation) so a transaction is never counted differently here than in the existing Sales
// Report screen. Only the output shape differs, remapped onto the Events collection's own
// field names:
//   alcohol_sales   <- alcoholAmount
//   food_sales      <- foodAmount + otherAmountSold (this schema has no separate "other"
//                      bucket, and the "other" bucket in practice is a small catch-all for
//                      anything not explicitly alcohol/Food/Non-Alcoholic -- folded into food)
//   drink_sales     <- nonAlcoholicDrinksAmount
//   discount_amount <- discountAmount
//   gift_card_amount<- giftcardAmount
//   tips_earned     <- tips
//   cash_sales      <- cashAmount
//   card_sales      <- cardAmount
//   revenue         <- amountPaid (what actually got paid, net of discount, and EXCLUSIVE of
//                      tips -- tips are tracked separately as tips_earned and are not part of
//                      any of the sales/revenue figures here. The docstring used to claim
//                      "gross of tips", which was the exact opposite of what the code does and
//                      of what the live rows show: HAX 7.0's card+cash+giftcard sums to
//                      pos_revenue exactly, with tips_earned entirely outside it.)
//   cogs            <- cogs
//   profit          <- revenue - cogs (not computed by Sales-Report itself; POS's own
//                      salesReport.js UI derives it the same way for on-screen display only)
//
// Also returns `card_tips`, which is NOT an Events attribute -- main.js peels it off and uses
// it for the tip-inclusive card figure (see its use there). It is the card-reader tip money
// that landed in the same Stripe payout as card_sales, so card_sales + card_tips is the only
// number here that can be reconciled against a Stripe deposit.
//
// Membership dues (`channel === 'membership'`) are NOT fed to this function -- main.js filters
// them out before calling it, so an event's bar revenue is bar revenue. See the note there.
export function emptyEventSales() {
	return {
		card_tips: 0,
		alcohol_sales: 0,
		food_sales: 0,
		drink_sales: 0,
		discount_amount: 0,
		gift_card_amount: 0,
		tips_earned: 0,
		cash_sales: 0,
		card_sales: 0,
		revenue: 0,
		cogs: 0,
		profit: 0,
	};
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

export function buildEventSales(transactions, categoriesById, ingredientCostById) {
	if (transactions.length === 0) return emptyEventSales();

	let cardTips = 0,
		alcoholAmount = 0,
		foodAmount = 0,
		nonAlcoholicDrinksAmount = 0,
		otherAmountSold = 0,
		cogs = 0,
		tips = 0,
		giftcardAmount = 0,
		cashAmount = 0,
		cardAmount = 0,
		discountAmount = 0,
		amountPaid = 0;

	transactions.forEach((transaction) => {
		let cart;
		try {
			cart = JSON.parse(transaction.cart) || [];
		} catch (err) {
			cart = [];
		}

		cart.forEach((cartItem) => {
			const quantity = cartItem.quantity || 0;
			const itemCost = cartItem.price || 0;

			const catId =
				cartItem.categories && typeof cartItem.categories === 'object' ? cartItem.categories.$id : cartItem.categories;
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
				const perUnitCogs = cartItem.ingredients.reduce((sum, ingredientId) => sum + (ingredientCostById[ingredientId] || 0), 0);
				cogs += perUnitCogs * quantity;
			} else if (cartItem.container_cost && cartItem.drinks_per_cont) {
				let itemCoGS = cartItem.container_cost / cartItem.drinks_per_cont;
				itemCoGS = itemCoGS + (cartItem.additional_drink_costs || 0);
				cogs += itemCoGS * quantity;
			}
		});

		tips += transaction.tip || 0;
		discountAmount += transaction.discount || 0;

		// Bucket by payment leg rather than the whole transaction's single payment_method -- a
		// split sale (cash+card, giftcard+card, etc.) has amounts in more than one bucket.
		const legs = derivePaymentLegs(transaction);
		cardTips += cardTipsFor(transaction, legs);
		legs.forEach((leg) => {
			const amount = parseInt(leg.amount) || 0;
			amountPaid += amount;
			if (leg.method === 'cash') cashAmount += amount;
			else if (leg.method === 'stripe') cardAmount += amount;
			else if (leg.method === 'giftcard') giftcardAmount += amount;
		});
	});

	// Every one of these Events attributes is a strict Appwrite integer -- cogs (a per-unit cost
	// divided across quantity/case size) is the one value here that can come out fractional, and
	// profit inherits that through the subtraction, so round everything on the way out rather
	// than special-casing just those two.
	return {
		card_tips: Math.round(cardTips),
		alcohol_sales: Math.round(alcoholAmount),
		food_sales: Math.round(foodAmount + otherAmountSold),
		drink_sales: Math.round(nonAlcoholicDrinksAmount),
		discount_amount: Math.round(discountAmount),
		gift_card_amount: Math.round(giftcardAmount),
		tips_earned: Math.round(tips),
		cash_sales: Math.round(cashAmount),
		card_sales: Math.round(cardAmount),
		revenue: Math.round(amountPaid),
		cogs: Math.round(cogs),
		profit: Math.round(amountPaid - cogs),
	};
}
