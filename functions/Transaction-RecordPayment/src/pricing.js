// Server-side re-pricing of a transaction's cart, kept in its own (directly
// unit-tested) module the same way Sales-Report keeps derivePaymentLegs --
// this is the one computation that decides whether a sale is allowed to reach
// `complete`, so it gets tested on its own rather than only through the
// handler.
//
// Why it exists: `Transactions` is `create("users")`, so `cart`, `total`,
// `discount` and `payment_due` are all authored by the same client that then
// asks to record a payment against them. Checking a leg against `payment_due`
// alone therefore checks a client number against another client number -- a
// $100 cart can be created with `payment_due: 1`, paid for a cent, and every
// other check in main.js passes. Everything below re-derives what the sale is
// actually worth from `pos_items.sale_price` and the `discounts` collection.
//
// Cart shape: the POS stores a snapshot of the whole pos_items document per
// line plus a `quantity` (POS/src/utils/cartUtils.js's addItemToCart), so
// every line carries `$id`. The snapshot's own `price` field is deliberately
// ignored whenever the item can be read server-side -- the entire point is to
// price off `sale_price` as it stands rather than off a number the caller
// wrote. It is used only as a LAST RESORT for a line whose pos_item no longer
// exists (an item deleted or disabled-and-removed between ring-up and the
// customer tapping), because the alternative -- treating that line as
// unpriceable -- meant refusing a payment the card reader had already
// captured. Any line priced that way marks the whole result untrusted, so the
// caller can refuse before capture and flag loudly after it.

// Returns the parsed cart array, or null if `cart` is missing/unreadable/not
// an array (all of which mean "this sale cannot be priced", never "it's free").
export function parseCart(raw) {
	if (typeof raw !== 'string' || raw.trim() === '') return null;
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : null;
	} catch (err) {
		return null;
	}
}

function lineItemId(line) {
	if (!line || typeof line !== 'object') return null;
	const id = line.$id;
	return typeof id === 'string' && id.trim() !== '' ? id : null;
}

// Quantities the POS can actually produce are whole numbers >= 1
// (cartUtils.js only ever sets 1 or increments/decrements). Anything else is
// treated as unpriceable rather than quietly coerced to 0, which would make
// the line free.
function lineQuantity(line) {
	const quantity = Number(line && line.quantity);
	if (!Number.isInteger(quantity) || quantity < 1) return null;
	return quantity;
}

// The distinct pos_items ids to look up, in cart order.
export function cartItemIds(cart) {
	const ids = [];
	(cart || []).forEach((line) => {
		const id = lineItemId(line);
		if (id && !ids.includes(id)) ids.push(id);
	});
	return ids;
}

// The price the cart snapshot itself recorded for a line, in cents, or null if
// the snapshot carries nothing usable. POS/src/utils/api.js's normalizePosItem
// aliases `price: doc.sale_price`, so this is the number the customer was
// actually quoted -- untrustworthy as evidence (the client wrote it) but the
// only record of a line whose pos_item has since been deleted.
function snapshotPrice(line) {
	const raw = line && (line.price !== undefined ? line.price : line.sale_price);
	const cents = parseInt(raw);
	return Number.isFinite(cents) && cents >= 0 ? cents : null;
}

// Prices the cart against `salePriceById` ({ [$id]: sale_price in cents }).
//
// A line the server can price contributes `sale_price * quantity`. A line
// whose id is not in pos_items falls back to the cart snapshot's own price and
// is listed in `estimated`; a line that cannot be valued at all -- no id, a
// nonsense quantity, or no snapshot price either -- contributes nothing and is
// listed in `unpriceable`. Both lists make the result untrusted: neither is
// ever silently priced as if the line were free, and neither is a reason to
// throw away money that has already been captured (see main.js).
export function priceCart(cart, salePriceById) {
	let subtotal = 0;
	const unpriceable = [];
	const estimated = [];

	(cart || []).forEach((line, index) => {
		const id = lineItemId(line);
		if (!id) {
			unpriceable.push(`line ${index} (no item id)`);
			return;
		}
		const quantity = lineQuantity(line);
		if (quantity === null) {
			unpriceable.push(`${id} (invalid quantity)`);
			return;
		}
		const salePrice = salePriceById ? salePriceById[id] : undefined;
		if (Number.isFinite(salePrice)) {
			subtotal += salePrice * quantity;
			return;
		}
		const fallback = snapshotPrice(line);
		if (fallback === null) {
			unpriceable.push(`${id} (no such pos_item, and the cart line names no price)`);
			return;
		}
		subtotal += fallback * quantity;
		estimated.push(`${id} (no such pos_item -- valued at the ${fallback} the cart was rung up at)`);
	});

	return { subtotal, unpriceable, estimated };
}

// Every discount amount the `discounts` collection could legitimately have
// produced for this subtotal, computed exactly the way the register computes
// it (POS/src/components/pos/pos.js's calculateTotal: percent of the subtotal
// or a flat cents amount, truncated and clamped to the subtotal).
export function discountCandidates(subtotal, discountOptions) {
	return (discountOptions || []).map((option) => {
		const amount = parseInt(option && option.amount) || 0;
		const raw = option && option.type === 'percent' ? Math.trunc((subtotal * amount) / 100) : amount;
		return Math.min(raw, subtotal);
	});
}

// The transaction stores only the computed discount in cents, not which
// `discounts` row produced it, so the check is "could any configured discount
// have produced exactly this number for this subtotal".
//
// An unrecognised discount is dropped (treated as 0) rather than rejected:
// dropping it can only make the sale cost MORE server-side, which is the safe
// direction, whereas rejecting the leg outright would throw away a card
// payment Stripe has already captured.
export function resolveDiscount(claimed, subtotal, discountOptions) {
	const wanted = parseInt(claimed) || 0;
	if (wanted <= 0) return { discount: 0, verified: true };
	if (discountCandidates(subtotal, discountOptions).includes(wanted)) {
		return { discount: Math.min(wanted, subtotal), verified: true };
	}
	return { discount: 0, verified: false };
}

// Full server-side price of a transaction:
//
//   { ok, trusted, reason, total, subtotal, discount, discountVerified }
//
// `total` is net of the discount and exclusive of any tip -- the same
// convention `Transactions.total` and derivePaymentLegs already use.
//
// The two flags are deliberately separate, because they answer different
// questions and only one of them may ever refuse a payment:
//   `ok`        -- a number was produced at all. False only when the cart
//                  itself is missing/unreadable, i.e. there is nothing to
//                  price.
//   `priceable` -- every LINE of the cart was valued from pos_items. False
//                  when a line had to be valued from the client's own
//                  snapshot, or could not be valued at all.
//   `trusted`   -- `priceable`, AND the claimed discount matches a configured
//                  one. A discount that doesn't is simply not applied, which
//                  can only make the sale cost more server-side, so it is
//                  flagged rather than treated as "this sale is unpriceable".
//
// An untrusted price is still a price. main.js refuses an unpriceable cart
// only on a leg where nothing has been captured yet, and records-and-flags it
// on a leg whose money is already gone -- a re-price must never be the reason
// a captured card payment cannot be written down (P0-1).
export function priceTransaction({ cart, discount }, { salePriceById, discountOptions } = {}) {
	if (!Array.isArray(cart)) {
		return {
			ok: false,
			priceable: false,
			trusted: false,
			reason: 'cart is missing or unreadable',
			subtotal: 0,
			discount: 0,
			discountVerified: false,
			total: 0,
		};
	}

	const { subtotal, unpriceable, estimated } = priceCart(cart, salePriceById);
	const resolved = resolveDiscount(discount, subtotal, discountOptions);

	const reasons = [];
	if (unpriceable.length > 0) reasons.push(`cart lines could not be priced: ${unpriceable.join(', ')}`);
	if (estimated.length > 0) reasons.push(`cart lines are not priceable server-side: ${estimated.join(', ')}`);
	if (!resolved.verified) {
		reasons.push(`discount ${parseInt(discount) || 0} matches no configured discount for a subtotal of ${subtotal}`);
	}

	return {
		ok: true,
		priceable: unpriceable.length === 0 && estimated.length === 0,
		trusted: reasons.length === 0,
		reason: reasons.length > 0 ? reasons.join('; ') : null,
		subtotal,
		discount: resolved.discount,
		discountVerified: resolved.verified,
		total: Math.max(subtotal - resolved.discount, 0),
	};
}
