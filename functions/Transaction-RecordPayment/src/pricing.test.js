const { parseCart, cartItemIds, priceCart, discountCandidates, resolveDiscount, priceTransaction } = require("./pricing.js");

const line = (overrides = {}) => ({ $id: "i1", name: "Beer", price: 500, quantity: 1, ...overrides });

describe("parseCart", () => {
	test("parses a normal cart", () => {
		expect(parseCart(JSON.stringify([line()]))).toEqual([line()]);
	});

	test.each([null, undefined, "", "   ", "not json", "{}", '"a string"', "42"])(
		"returns null (not an empty cart) for %p",
		(raw) => {
			expect(parseCart(raw)).toBeNull();
		},
	);
});

describe("cartItemIds", () => {
	test("collects distinct ids in cart order", () => {
		const cart = [line({ $id: "a" }), line({ $id: "b" }), line({ $id: "a" })];

		expect(cartItemIds(cart)).toEqual(["a", "b"]);
	});

	test("skips lines with no usable id", () => {
		expect(cartItemIds([line({ $id: "" }), { quantity: 1 }, line({ $id: "a" })])).toEqual(["a"]);
	});
});

describe("priceCart", () => {
	test("prices off pos_items.sale_price, not the cart snapshot's own price", () => {
		// The snapshot says 100/ea; pos_items says 500/ea. The server price wins.
		const cart = [line({ $id: "i1", price: 100, quantity: 3 })];

		expect(priceCart(cart, { i1: 500 })).toEqual({ subtotal: 1500, unpriceable: [], estimated: [] });
	});

	test("sums multiple lines", () => {
		const cart = [line({ $id: "i1", quantity: 2 }), line({ $id: "i2", quantity: 1 })];

		expect(priceCart(cart, { i1: 500, i2: 725 }).subtotal).toBe(1725);
	});

	test("an item id that isn't in pos_items and names no price is reported, never priced at zero", () => {
		const result = priceCart([{ $id: "ghost", quantity: 1 }], {});

		expect(result.subtotal).toBe(0);
		expect(result.unpriceable).toEqual(["ghost (no such pos_item, and the cart line names no price)"]);
		expect(result.estimated).toEqual([]);
	});

	// An item deleted between ring-up and the customer tapping used to make the
	// whole cart unpriceable, which meant refusing a payment the reader had
	// already captured. The snapshot price is what the customer was quoted, so
	// it is used for that line only -- and reported, so the result is never
	// mistaken for a fully server-derived price.
	test("an item id that isn't in pos_items falls back to the price the cart was rung up at, and says so", () => {
		const result = priceCart([line({ $id: "ghost", price: 500, quantity: 2 })], { i1: 500 });

		expect(result.subtotal).toBe(1000);
		expect(result.unpriceable).toEqual([]);
		expect(result.estimated).toEqual(["ghost (no such pos_item -- valued at the 500 the cart was rung up at)"]);
	});

	test("the snapshot fallback never applies to an item pos_items does know", () => {
		const result = priceCart([line({ $id: "i1", price: 1, quantity: 2 })], { i1: 500 });

		expect(result.subtotal).toBe(1000);
		expect(result.estimated).toEqual([]);
	});

	test("a negative snapshot price is not a fallback, it is unpriceable", () => {
		const result = priceCart([line({ $id: "ghost", price: -500, quantity: 1 })], {});

		expect(result.subtotal).toBe(0);
		expect(result.unpriceable).toEqual(["ghost (no such pos_item, and the cart line names no price)"]);
	});

	test("a line with no id is reported", () => {
		expect(priceCart([{ name: "Membership Dues", price: 4000, quantity: 1 }], {}).unpriceable).toEqual([
			"line 0 (no item id)",
		]);
	});

	test.each([0, -1, 1.5, "two", null, undefined])("a quantity of %p is reported rather than coerced", (quantity) => {
		expect(priceCart([line({ quantity })], { i1: 500 }).unpriceable).toEqual(["i1 (invalid quantity)"]);
	});

	test("a whole-number quantity that arrived as a string still prices", () => {
		expect(priceCart([line({ quantity: "2" })], { i1: 500 })).toEqual({ subtotal: 1000, unpriceable: [], estimated: [] });
	});

	test("an empty cart is priceable and worth nothing", () => {
		expect(priceCart([], {})).toEqual({ subtotal: 0, unpriceable: [], estimated: [] });
	});
});

describe("discountCandidates", () => {
	test("percent discounts are truncated the way the register truncates them", () => {
		// 1055 * 10% = 105.5 -> parseInt in pos.js's calculateTotal -> 105
		expect(discountCandidates(1055, [{ type: "percent", amount: 10 }])).toEqual([105]);
	});

	test("cents discounts are taken as-is", () => {
		expect(discountCandidates(1000, [{ type: "cents", amount: 250 }])).toEqual([250]);
	});

	test("a discount larger than the subtotal is clamped to the subtotal", () => {
		expect(discountCandidates(300, [{ type: "cents", amount: 1000 }])).toEqual([300]);
		expect(discountCandidates(300, [{ type: "percent", amount: 150 }])).toEqual([300]);
	});
});

describe("resolveDiscount", () => {
	const options = [
		{ type: "percent", amount: 10 },
		{ type: "cents", amount: 250 },
	];

	test("no discount claimed is always fine", () => {
		expect(resolveDiscount(0, 1000, options)).toEqual({ discount: 0, verified: true });
	});

	test("a discount a configured row could have produced is honoured", () => {
		expect(resolveDiscount(100, 1000, options)).toEqual({ discount: 100, verified: true });
		expect(resolveDiscount(250, 1000, options)).toEqual({ discount: 250, verified: true });
	});

	test("a made-up discount is dropped, not honoured", () => {
		// The attack this exists for: cart worth $100, `discount: 9900` claimed
		// so the sale re-prices to $1. Dropping it can only raise what's owed.
		expect(resolveDiscount(9900, 10000, options)).toEqual({ discount: 0, verified: false });
	});

	test("a discount claimed when none are configured is dropped", () => {
		expect(resolveDiscount(500, 1000, [])).toEqual({ discount: 0, verified: false });
	});
});

describe("priceTransaction", () => {
	const salePriceById = { i1: 500, i2: 725 };

	test("prices a cart net of a verified discount", () => {
		const cart = [line({ $id: "i1", quantity: 2 }), line({ $id: "i2", quantity: 1 })];

		expect(priceTransaction({ cart, discount: 172 }, { salePriceById, discountOptions: [{ type: "percent", amount: 10 }] })).toEqual(
			{ ok: true, priceable: true, trusted: true, reason: null, subtotal: 1725, discount: 172, discountVerified: true, total: 1553 },
		);
	});

	test("an unverifiable discount leaves the sale at full price, and is not trusted", () => {
		const cart = [line({ $id: "i1", quantity: 2 })];

		const result = priceTransaction({ cart, discount: 999 }, { salePriceById, discountOptions: [] });

		expect(result).toEqual({
			ok: true,
			// The cart itself priced fine -- only the claimed discount didn't --
			// so this is never a reason to refuse a leg, just to flag one.
			priceable: true,
			trusted: false,
			reason: "discount 999 matches no configured discount for a subtotal of 1000",
			subtotal: 1000,
			discount: 0,
			discountVerified: false,
			total: 1000,
		});
	});

	test("a cart that isn't an array cannot be priced", () => {
		expect(priceTransaction({ cart: null, discount: 0 }, { salePriceById })).toEqual({
			ok: false,
			priceable: false,
			trusted: false,
			reason: "cart is missing or unreadable",
			subtotal: 0,
			discount: 0,
			discountVerified: false,
			total: 0,
		});
	});

	test("a cart with an unknown item is not priceable and not trusted, though it still carries a number", () => {
		const result = priceTransaction({ cart: [line({ $id: "ghost", price: 500, quantity: 1 })], discount: 0 }, { salePriceById });

		expect(result.priceable).toBe(false);
		expect(result.trusted).toBe(false);
		expect(result.reason).toMatch(/ghost/);
		// The number exists so a captured card leg can still be recorded against
		// it -- it is just not a number this function will stand behind.
		expect(result.total).toBe(500);
	});

	test("an unknown item with no snapshot price contributes nothing and is never priced as free", () => {
		const result = priceTransaction({ cart: [{ $id: "ghost", quantity: 4 }], discount: 0 }, { salePriceById });

		expect(result.priceable).toBe(false);
		expect(result.reason).toMatch(/could not be priced/);
		expect(result.total).toBe(0);
	});

	test("total never goes below zero", () => {
		const cart = [line({ $id: "i1", quantity: 1 })];

		expect(
			priceTransaction({ cart, discount: 500 }, { salePriceById, discountOptions: [{ type: "percent", amount: 100 }] }).total,
		).toBe(0);
	});
});
