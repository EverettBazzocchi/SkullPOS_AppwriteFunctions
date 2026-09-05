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

## Note on calling Appwrite's own API from within a function

This self-hosted instance's function-execution sandbox can't resolve its
own public hostname via the normal `getaddrinfo` path (used internally by
`fetch`/`http`) -- `dns.resolve4` (talks to nameservers directly,
bypassing `getaddrinfo`) works fine though. `src/appwriteClient.js` patches
the global `dns.lookup` so any HTTP client resolving this hostname gets the
known-good IP instead of hanging/`EAI_AGAIN`; the URL/Host header is
untouched, only the DNS step is bypassed. Every function that needs to
call Databases/Teams/Users uses this same helper.
