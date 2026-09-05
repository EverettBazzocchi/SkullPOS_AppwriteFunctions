# Transaction-RecordCardPayment

Records a completed Stripe Terminal card payment on a pending transaction.
Verifies the PaymentIntent against the real Stripe API server-side --
status is `"succeeded"` and the amount matches what the transaction
actually expects -- before writing anything. The client can't just claim
a `stripe_id` succeeded, and can't point a transaction at an unrelated
PaymentIntent (which would otherwise let a later refund get misdirected at
someone else's real charge).

The Stripe Terminal charge itself (`chargeCard`) still has to happen
client-side -- it drives physical hardware -- this function only records
the result, and only after independently confirming it with Stripe.

## Request body

```json
{ "transactionId": "...", "paymentIntentId": "pi_..." }
```

## Response

`{ "ok": true, "tip": 500 }` or `{ "error": "<message>" }` with a 4xx/5xx
status.

## Configuration

| Setting     | Value                                        |
| ----------- | ----------------------------------------------- |
| Runtime     | Node (16.0)                                     |
| Entrypoint  | `src/main.js`                                   |
| Build       | `npm i`                                         |
| Execute     | `users` (any session, PIN mode included -- checkout needs this) |
| Scopes      | `documents.read`, `documents.write`             |

## Environment Variables

- `testKey` - Stripe test-mode secret key
- `prodKey` - Stripe live-mode secret key

(Same values as the other Stripe functions' `testKey`/`prodKey` -- set
independently here since Appwrite function variables aren't shared across
functions.)

## Note on calling Appwrite's own API from within a function

This self-hosted instance's function-execution sandbox can't resolve its
own public hostname via the normal `getaddrinfo` path (used internally by
`fetch`/`http`) -- `dns.resolve4` (talks to nameservers directly,
bypassing `getaddrinfo`) works fine though. `src/appwriteClient.js` patches
the global `dns.lookup` so any HTTP client resolving this hostname gets the
known-good IP instead of hanging/`EAI_AGAIN`; the URL/Host header is
untouched, only the DNS step is bypassed. Every function that needs to
call Databases/Teams uses this same helper.
