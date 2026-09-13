# Transaction-RecordPayment

**Function ID:** `6a9c728a297df71f5919`

Records one payment leg — a cash amount, a verified card charge, or a gift-card
redemption — against a pending transaction, appending it to the transaction's
`payments` array. Call it once per leg until `payment_due` reaches 0; that is
what makes split tender possible (multiple cards, cash+card, giftcard+card, any
combination).

Replaces the retired single-method `Transaction-ApplyGiftcard` /
`Transaction-RecordCardPayment` functions and the cash-completion half of
`Transaction-SetStatus` (which now only cancels).

**This function runs after the card reader has captured.** Everything in it is
shaped by one rule: a re-price or a concurrency check may *detect* a problem, it
may never turn an already-captured payment into one that cannot be written down.

## Who may call it

Live `execute`: `users` — any signed-in session, anonymous PIN sessions included.
Verified 2026-09-13 with
`appwrite functions get --function-id 6a9c728a297df71f5919`. Checkout needs this;
there is no in-code caller check.

## Server-side re-pricing

`Transactions` is `create("users")`, so `cart`, `total`, `discount` and
`payment_due` are all written by the same client now asking to record a payment
against them — `amount <= payment_due` compares a client number to a client
number, and a $100 cart created with `payment_due: 1` would pass every other
check here. So every leg re-prices the cart from `pos_items.sale_price` and the
`discounts` collection (`src/pricing.js`).

The result is a **floor** on what must be paid before the sale may reach
`complete`, never a cap on a single leg — a price edited between ring-up and tap
must not make this function refuse a leg Stripe has already captured.

What a bad re-price may do:

- **`cash` / `giftcard` legs** — an unpriceable cart is refused (`400`, or `500`
  if the catalogue could not be read at all). Nothing irreversible has happened
  yet: the cash is in the drawer, the gift card is not debited until later in the
  same request.
- **`stripe` legs** — always recorded. The reason is stamped on the leg itself as
  `priceWarning`, returned to the till as `warning`, and logged at error level.
  The floor still applies, so a genuinely underpaid sale stays `pending` with the
  balance visible rather than silently completing.
- **An unverifiable discount** is simply not applied, which moves the price up,
  never down. Flagged, not refused.
- **`channel: "membership"`** skips cart pricing entirely: the kiosk rings one
  synthetic "Membership Dues" line with no `$id`, so the server price is the dues
  amount (4000 cents, kept in sync by hand with `MEMBERSHIP_DUES_CENTS` in
  `POS/src/components/selfCheckout/selfCheckout.js`). It is a floor, so raising
  dues in the client first still completes normally.

## What a card leg must prove

1. The PaymentIntent retrieves and its status is `succeeded`.
2. `captured amount − reported tip === amount`. A card-present sale can pick up a
   tip on the reader (`config_override.update_payment_intent: true` lets the
   reader rewrite the intent's amount and report the tip in
   `amount_details.tip.amount`), so the leg amount stays **tip-exclusive** and
   the tip rides alongside it as `leg.tip`. Both numbers come from Stripe, so a
   caller still cannot claim more than was captured; the tip is clamped into
   `[0, captured]` first so a malformed `amount_details` cannot inflate the base.
3. `metadata.transactionId === transactionId`. `Stripe-CreatePaymentIntent`
   stamps this at creation; without the match, an intent that succeeded against
   one sale could be replayed to pay a second one for free.
4. The same intent is not already a leg on this transaction, and (via a
   `Query.equal('stripe_id', …)` lookup) not already recorded against a different
   one.

## Idempotency and concurrency

- **`legId`** — an optional per-leg key the client generates once and re-sends
  unchanged on every retry (`newLegId` in `POS/src/utils/splitPayment.js`). A
  recognised replay returns the state that leg already produced instead of
  appending a second one. Checked *ahead* of the pending check, so a retry of the
  leg that finished the sale succeeds idempotently rather than coming back as
  "not pending".
- **Pre-commit re-read.** Up to three network round-trips happen between the
  opening read and the write, so the row is re-read immediately before
  committing. This does not make the write atomic (nothing in this runtime does),
  but it narrows the lost-update window from three calls wide to one, and
  `status` is never written from a snapshot taken before a Stripe round-trip.
  If the re-read itself fails, the function commits from the original snapshot
  anyway and says so loudly — refusing here is exactly the failure this file
  exists to prevent.
- **Lost the race.** If the leg turns out to have been recorded concurrently, a
  gift-card debit made by this execution is credited back.
- **Row no longer pending.** For `cash`/`giftcard`, refuse `409` (and credit the
  gift card back). For `stripe`, record the leg **without** touching `status` or
  `payment_due`, stamped with `statusAtRecord`, so the charge is visible on the
  row somebody now has to refund rather than existing only in Stripe.

## Request body

```json
{ "transactionId": "...", "method": "cash",     "amount": 500, "legId": "..." }
{ "transactionId": "...", "method": "giftcard", "amount": 500, "giftcardId": "...", "legId": "..." }
{ "transactionId": "...", "method": "stripe",   "amount": 500, "paymentIntentId": "pi_...", "legId": "..." }
```

`amount` is a positive integer in cents.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ ok: true, remaining, status }` | Leg recorded. `status` is `complete` once `remaining` hits 0. |
| `200` | `{ ok: true, remaining, status, replay: true }` | This leg was already recorded. Nothing new happened. |
| `200` | `{ ok: true, …, warning: "Recorded, but this sale could not be fully verified server-side: …" }` | The money is recorded. **Show this to staff** — the cart did not price against the catalogue, or the sale had already become non-pending and this card charge now needs a refund rather than a completion. |
| `400` | `{ error: "method must be one of: cash, stripe, giftcard" }` / `{ error: "amount must be a positive integer (cents)" }` | Malformed call. |
| `400` | `{ error: "Transaction is not pending (status: …)" }` | Sale already finished or cancelled. |
| `400` | `{ error: "Self-checkout transactions can only be paid by card" }` | `channel` is `self_checkout` or `membership`. Enforced here, not just in the kiosk UI. |
| `400` | `{ error: "Amount … exceeds remaining balance …" }` | The leg is bigger than what is outstanding by both ledgers. |
| `400` | `{ error: "This sale could not be priced server-side", reason }` | Unpriceable cart on a cash/gift-card leg. |
| `400` | gift-card messages: `"Amount … exceeds giftcard balance …"`, `"This voucher has been revoked"`, `"This gift card has been deactivated"`, `"This voucher is only valid during its own event"`, `"DJ vouchers can't be combined with a discount"` | A DJ voucher is a `giftcards` row with an `events` link. Revocation (`active: false`) is checked for **every** card, not only vouchers — `giftcards.events` is `onDelete: setNull`, so deleting an event used to strip the link and silently un-revoke its vouchers. |
| `400` | Stripe-leg messages: `"PaymentIntent is not succeeded (status: …)"`, `"PaymentIntent amount does not match this payment leg"`, `"PaymentIntent was not created for this transaction"`, `"This payment has already been recorded on this transaction"`, `"This payment has already been used on another transaction"` | The charge could not be tied to this sale. **The money may still be captured in Stripe** — check the intent before retrying. |
| `404` | `{ error: "Transaction not found" }` / `{ error: "Giftcard not found" }` | Bad id. |
| `409` | `{ error: "This sale is no longer pending (status: …) — the payment was not applied.", giftcardRestored }` | The row was cancelled or completed mid-leg. Cash/gift-card only. |
| `500` | `{ error: "Failed to update transaction", giftcardRestored, manualCredit }` | The leg write failed. If `giftcardRestored` is `false`, `manualCredit` names the card and amount that **must be credited by hand** — the execution log carries an `ORPHANED GIFTCARD DEBIT` line. |
| `500` | `{ error: "Failed to verify this sale", reason }` | The item/discount catalogue could not be read. |

## Membership-dues notification

When a leg completes a `channel: "membership"` transaction, finance is emailed
via Resend with the payer's name/email, amount and date, CC'ing the member on
their own dues receipt and setting `everett.bazzocchi@skullspace.ca` as
**Reply-To** rather than CC'ing them. It fires as a direct
consequence of the payment completing here, not as a separate client call that
could be skipped if the kiosk drops offline — and it never fails the payment
response. Recipient follows the transaction's own `testing` flag.

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Read the transaction, the gift card, `pos_items`, `discounts`, and the reuse-check query. |
| `documents.write` | Append the leg, update status/`payment_due`/`tip`/`stripe_id`/`giftcard_amount`, debit and credit gift-card balances. |

## Environment variables

| Name | Purpose |
| --- | --- |
| `testKey` | Stripe test secret key (`method: "stripe"` only) |
| `prodKey` | Stripe live secret key |
| `RESEND_API_KEY` | Resend key for the membership-dues notice |
| `FINANCE_NOTIFICATION_EMAIL_TEST` | Recipient for a `testing: true` membership sale |
| `FINANCE_NOTIFICATION_EMAIL_PROD` | Finance's real inbox |

## The `payments` column

A JSON string, same pattern as `cart`:

```json
[
  { "method": "giftcard", "amount": 500, "giftcardId": "abc123", "legId": "..." },
  { "method": "cash", "amount": 300 },
  { "method": "stripe", "amount": 700, "stripeId": "pi_...", "tip": 100 }
]
```

Rows written before this existed have none; readers (`Sales-Report`,
`Stripe-RefundPayment`, `Transaction-EmailReceipt`) synthesize one leg from the
legacy `stripe_id`/`giftcard_amount`/`payment_method` columns instead.
`payment_method` on the document becomes `"split"` once there is more than one
leg — cosmetic only, the real breakdown is `payments`.

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 15s |
| Schedule | none |

Deploy: `appwrite push function --function-id 6a9c728a297df71f5919`

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
