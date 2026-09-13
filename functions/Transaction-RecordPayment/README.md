# Transaction-RecordPayment

Records one payment leg (cash amount, verified card charge, or giftcard
redemption) against a pending transaction, appending it to the
transaction's `payments` array. This is what makes a split sale possible
-- multiple cards, cash+card, giftcard+cash, giftcard+card, or any other
combination: call this once per leg until `payment_due` reaches 0.

Replaces the old single-method `Transaction-ApplyGiftcard` /
`Transaction-RecordCardPayment` functions (retired), and the
cash-completion half of `Transaction-SetStatus` (now only handles
`"cancelled"`). Every leg is validated the same way those functions
already did -- a card leg is independently verified against the real
Stripe API (status + amount), a giftcard leg re-reads the actual current
balance -- never trusting client-supplied amounts for anything but the
split itself.

## Server-side re-pricing, and what it is allowed to do

`Transactions` is `create("users")`, so `cart`, `total`, `discount` and
`payment_due` are all written by the same client that then asks to record a
payment against them -- `amount <= payment_due` compares a client number to a
client number. Every leg therefore re-prices the cart from `pos_items.sale_price`
and the `discounts` collection (`src/pricing.js`), and the result is used as a
**floor** on what must be paid before the sale may reach `complete`, never as a
cap on a single leg.

This function runs **after** the reader has captured, so the re-price is
deliberately bounded in what it may cause:

- It may **refuse** a leg only where refusing costs nothing -- `cash` (still in
  the drawer) and `giftcard` (not debited until later in the same request). A
  cart that cannot be priced gets a 400 there.
- On a `stripe` leg the money is already gone, so the leg is **always
  recorded**. The reason is stamped on the leg itself as `priceWarning`,
  returned to the till as `warning`, and logged at error level; the floor still
  applies, so a sale that really is underpaid stays `pending` with the balance
  visible. It is never refused -- "captured, then refused, sale unrecordable" is
  the failure this whole path exists to prevent.
- An item deleted between ring-up and the tap is valued at the price the cart
  was rung up at rather than treated as unpriceable, so the ordinary race
  settles normally (and is still flagged).
- An unverifiable **discount** is simply not applied, which moves the price up,
  never down. That is flagged, not refused.

## Request body

```json
{ "transactionId": "...", "method": "cash", "amount": 500 }
{ "transactionId": "...", "method": "giftcard", "amount": 500, "giftcardId": "..." }
{ "transactionId": "...", "method": "stripe", "amount": 500, "paymentIntentId": "pi_..." }
```

## Response

`{ "ok": true, "remaining": 0, "status": "complete" }` (or `status:
"pending"` if more legs are still needed) or `{ "error": "<message>" }`
with a 4xx/5xx status.

A recorded leg whose sale could not be fully verified server-side also carries
`warning: "<why>"` -- the payment IS recorded, and the till should show this to
staff. A failed giftcard leg additionally reports `giftcardRestored` (and
`manualCredit: {giftcardId, amount}` when the balance could not be put back).

## Payments array shape

Stored as `JSON.stringify(...)` in the `payments` string field (same
pattern as the existing `cart`/`transaction_data` fields):

```json
[
  { "method": "giftcard", "amount": 500, "giftcardId": "abc123" },
  { "method": "cash", "amount": 300 },
  { "method": "stripe", "amount": 700, "stripeId": "pi_...", "tip": 100 }
]
```

Older transactions written before this existed have no `payments` array
-- readers (Sales-Report, Stripe-RefundPayment, the refund confirmation
UI) fall back to synthesizing one leg from the legacy `stripe_id`/
`giftcard_amount`/`payment_method` fields instead.

## Channel-based restrictions

A transaction with `channel: "self_checkout"` or `channel: "membership"`
can only ever be paid by a `stripe` leg -- both are kiosk-originated with
no cash/giftcard handling in their UI, and this is the real enforcement of
that (not just the kiosk never offering another button).

## Membership dues notification

When a leg completes a transaction with `channel: "membership"`, this
function automatically emails finance (via Resend's HTTP API, same
pattern as `Transaction-EmailReceipt`) with the payer's name/email (from
the transaction's `member_name`/`member_email` fields), the amount, and
the date. Fires as a direct consequence of the payment completing here,
not a separate client-triggered call -- and never fails the payment
response if the notification itself fails to send (logged only; the
payment already succeeded).

The recipient depends on the transaction's own `testing` flag -- same
switch already used for the Stripe key above -- so a `testing:true` sale
(the default on localhost/self-checkout during development) never
notifies finance's real inbox.

## Configuration

| Setting     | Value                                        |
| ----------- | ----------------------------------------------- |
| Runtime     | Node (16.0)                                     |
| Entrypoint  | `src/main.js`                                   |
| Build       | `npm i`                                         |
| Execute     | `users` (any session, PIN mode included -- checkout needs this) |
| Scopes      | `documents.read`, `documents.write`             |

## Environment Variables

- `testKey` - Stripe test-mode secret key (only used for `method: "stripe"`)
- `prodKey` - Stripe live-mode secret key
- `RESEND_API_KEY` - Resend API key (same one used by `Transaction-EmailReceipt`)
- `FINANCE_NOTIFICATION_EMAIL_TEST` - where membership-dues notifications go for
  a `testing:true` transaction
- `FINANCE_NOTIFICATION_EMAIL_PROD` - where they go for a real (non-testing)
  transaction -- finance's actual inbox

## Note on calling Appwrite's own API from within a function

This self-hosted instance's function-execution sandbox can't resolve its
own public hostname via the normal `getaddrinfo` path (used internally by
`fetch`/`http`) -- `dns.resolve4` (talks to nameservers directly,
bypassing `getaddrinfo`) works fine though. `src/appwriteClient.js` patches
the global `dns.lookup` so any HTTP client resolving this hostname gets the
known-good IP instead of hanging/`EAI_AGAIN`; the URL/Host header is
untouched, only the DNS step is bypassed. Every function that needs to
call Databases/Teams/Users uses this same helper.
