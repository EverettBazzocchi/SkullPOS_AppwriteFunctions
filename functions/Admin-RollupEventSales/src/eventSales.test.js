const { buildEventSales, emptyEventSales } = require("./eventSales.js");

const cartJson = (items) => JSON.stringify(items);

describe("buildEventSales", () => {
	test("returns all-zero sales for no transactions", () => {
		expect(buildEventSales([], {}, {})).toEqual(emptyEventSales());
	});

	test("classifies alcohol via the cart item's own flag or its category's alcohol flag", () => {
		const categoriesById = { "cat-beer": { $id: "cat-beer", name: "Beer", alcohol: true } };
		const transactions = [
			{ cart: cartJson([{ name: "Beer", price: 500, quantity: 2, categories: "cat-beer" }]), tip: 0, discount: 0, payment_due: 1000 },
			{ cart: cartJson([{ name: "Shot", price: 300, quantity: 1, alcohol: true }]), tip: 0, discount: 0, payment_due: 300 },
		];
		const sales = buildEventSales(transactions, categoriesById, {});
		expect(sales.alcohol_sales).toBe(500 * 2 + 300);
	});

	test("classifies Food and Non-Alcoholic Drinks categories, folds everything else into food_sales", () => {
		const categoriesById = {
			food: { $id: "food", name: "Food", alcohol: false },
			na: { $id: "na", name: "Non-Alcoholic Drinks", alcohol: false },
		};
		const transactions = [
			{
				cart: cartJson([
					{ name: "Burger", price: 1000, quantity: 1, categories: "food" },
					{ name: "Soda", price: 200, quantity: 1, categories: "na" },
					{ name: "Merch", price: 1500, quantity: 1, categories: "other-cat" },
				]),
				tip: 0,
				discount: 0,
				payment_due: 2700,
			},
		];
		const sales = buildEventSales(transactions, categoriesById, {});
		expect(sales.food_sales).toBe(1000 + 1500); // Food + the unclassified "other" bucket folded in
		expect(sales.drink_sales).toBe(200);
	});

	test("computes cogs from ingredient costs, falling back to container_cost/drinks_per_cont", () => {
		const ingredientCostById = { "ing-1": 50 };
		const transactions = [
			{
				cart: cartJson([
					{ name: "Cocktail", price: 1200, quantity: 2, ingredients: ["ing-1"] },
					{ name: "Draft Beer", price: 700, quantity: 3, container_cost: 6000, drinks_per_cont: 20, additional_drink_costs: 5 },
				]),
				tip: 0,
				discount: 0,
				payment_due: 4500,
			},
		];
		const sales = buildEventSales(transactions, {}, ingredientCostById);
		// Cocktail: 50/unit * 2 = 100. Draft beer: (6000/20 + 5) * 3 = 305 * 3 = 915.
		expect(sales.cogs).toBe(100 + 915);
	});

	test("sums tips, discounts, and buckets payment legs into cash/card/giftcard", () => {
		const transactions = [
			{ cart: cartJson([]), tip: 200, discount: 500, payments: JSON.stringify([{ method: "cash", amount: 1000 }]) },
			{ cart: cartJson([]), tip: 0, discount: 0, payments: JSON.stringify([{ method: "stripe", amount: 2000 }, { method: "giftcard", amount: 300 }]) },
		];
		const sales = buildEventSales(transactions, {}, {});
		expect(sales.tips_earned).toBe(200);
		expect(sales.discount_amount).toBe(500);
		expect(sales.cash_sales).toBe(1000);
		expect(sales.card_sales).toBe(2000);
		expect(sales.gift_card_amount).toBe(300);
		expect(sales.revenue).toBe(1000 + 2000 + 300);
	});

	test("falls back to legacy single-method fields when payments is absent", () => {
		const transactions = [{ cart: cartJson([]), tip: 0, discount: 0, payment_due: 800 }];
		const sales = buildEventSales(transactions, {}, {});
		expect(sales.cash_sales).toBe(800);
		expect(sales.revenue).toBe(800);
	});

	test("profit is revenue minus cogs", () => {
		const ingredientCostById = { "ing-1": 100 };
		const transactions = [
			{
				cart: cartJson([{ name: "Cocktail", price: 1500, quantity: 1, ingredients: ["ing-1"] }]),
				tip: 0,
				discount: 0,
				payment_due: 1500,
			},
		];
		const sales = buildEventSales(transactions, {}, ingredientCostById);
		expect(sales.revenue).toBe(1500);
		expect(sales.cogs).toBe(100);
		expect(sales.profit).toBe(1400);
	});

	test("rounds cogs (and profit, which subtracts it) to whole cents -- Appwrite's cogs attribute is a strict integer", () => {
		// 100/3 is not a whole number -- this must not produce a fractional cogs value.
		const ingredientCostById = { "ing-1": 100 / 3 };
		const transactions = [
			{ cart: cartJson([{ name: "Cocktail", price: 500, quantity: 1, ingredients: ["ing-1"] }]), tip: 0, discount: 0, payment_due: 500 },
		];
		const sales = buildEventSales(transactions, {}, ingredientCostById);
		expect(Number.isInteger(sales.cogs)).toBe(true);
		expect(Number.isInteger(sales.profit)).toBe(true);
	});

	test("tolerates an unparseable cart without throwing", () => {
		const transactions = [{ cart: "{not json", tip: 50, discount: 0, payment_due: 1000 }];
		const sales = buildEventSales(transactions, {}, {});
		expect(sales.revenue).toBe(1000);
		expect(sales.tips_earned).toBe(50);
	});
});
