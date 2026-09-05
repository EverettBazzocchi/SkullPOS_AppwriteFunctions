# Stripe-RefundPayment

Refunds a whole completed transaction, server-side, end to end. Used by the
POS transactions/refund view.

Reads the transaction document itself (rather than trusting whatever the
client sends) and, based on what's actually on it:
- refunds the card portion via `stripe.refunds.create` if `stripe_id` is
  present (using the test/prod key matching the transaction's own
  `testing` flag, not a client-asserted one),
- credits back the giftcard portion if `giftcard_amount > 0`,
- and is the *only* place allowed to set the transaction's `status` to
  `"refunded"`.

This -- not a client `updateDocument` call -- is what makes "no refunds in
quick-access PIN mode" a real restriction rather than a client-side flag:
the client has no write permission on Transactions/giftcards at all (see
the POS repo's PIN-system security plan), so a cash-paid transaction can't
be marked refunded except through here, and this function's execute
permission is scoped to the staff `team:` IDs only.

Unlike `Stripe-CancelPaymentIntent` (which only works on an intent that
hasn't been captured yet), this works on a completed sale.

## Request body

```json
{ "transactionId": "..." }
```

## Response

Success: `{ "ok": true }`
Failure: `{ "error": "<message>" }` with a 4xx/5xx status. A giftcard or
transaction-record write failure after a successful Stripe refund still
returns an error (state may need manual reconciliation) -- the message
says which side succeeded.

## Configuration

| Setting     | Value                                            |
| ----------- | ------------------------------------------------- |
| Runtime     | Node (16.0), matching the other Stripe functions   |
| Entrypoint  | `src/main.js`                                      |
| Build       | `npm i`                                            |
| Execute     | `team:...` (staff only -- unchanged)               |
| Scopes      | `documents.read`, `documents.write`                |

## Environment Variables

- `testKey` - Stripe test-mode secret key
- `prodKey` - Stripe live-mode secret key

## Note on calling Appwrite's own API from within a function

This self-hosted instance's function-execution sandbox can't resolve its
own public hostname via the normal `getaddrinfo` path (used internally by
`fetch`/`http`) -- `dns.resolve4` (talks to nameservers directly,
bypassing `getaddrinfo`) works fine though. `src/appwriteClient.js` patches
the global `dns.lookup` so any HTTP client resolving this hostname gets the
known-good IP instead of hanging/`EAI_AGAIN`; the URL/Host header is
untouched, only the DNS step is bypassed. Every function that needs to
call Databases/Teams uses this same helper.
