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
//   revenue         <- amountPaid (what actually got paid, net of discount, gross of tips)
//   cogs            <- cogs
//   profit          <- revenue - cogs (not computed by Sales-Report itself; POS's own
//                      salesReport.js UI derives it the same way for on-screen display only)
export function emptyEventSales() {
	return {
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

export function buildEventSales(transactions, categoriesById, ingredientCostById) {
	if (transactions.length === 0) return emptyEventSales();

	let alcoholAmount = 0,
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
		derivePaymentLegs(transaction).forEach((leg) => {
			const amount = parseInt(leg.amount) || 0;
			amountPaid += amount;
			if (leg.method === 'cash') cashAmount += amount;
			else if (leg.method === 'stripe') cardAmount += amount;
			else if (leg.method === 'giftcard') giftcardAmount += amount;
		});
	});

	return {
		alcohol_sales: alcoholAmount,
		food_sales: foodAmount + otherAmountSold,
		drink_sales: nonAlcoholicDrinksAmount,
		discount_amount: discountAmount,
		gift_card_amount: giftcardAmount,
		tips_earned: tips,
		cash_sales: cashAmount,
		card_sales: cardAmount,
		revenue: amountPaid,
		cogs,
		profit: amountPaid - cogs,
	};
}
