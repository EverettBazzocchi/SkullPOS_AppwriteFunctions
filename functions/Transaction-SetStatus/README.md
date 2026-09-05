# Transaction-SetStatus

Sets a pending transaction to `"complete"` (cash payment confirmed) or
`"cancelled"` (staff cancelled an in-progress card attempt). Never accepts
`"refunded"` -- that's exclusively `Stripe-RefundPayment`'s job -- and only
transitions out of `"pending"`, so it can't be replayed against an
already-finalized transaction.

The client has no write access to Transactions at all (see the POS
PIN-system security plan), which is what makes "no refunds in quick-access
PIN mode" a real restriction rather than a client-side flag: a cash-paid
transaction can't be marked refunded except through `Stripe-RefundPayment`,
whose execute permission is staff-team-only.

## Request body

```json
{ "transactionId": "...", "status": "complete" }
```

`status` must be `"complete"` or `"cancelled"`.

## Response

`{ "ok": true, "status": "complete" }` or `{ "error": "<message>" }` with a
4xx/5xx status.

## Configuration

| Setting     | Value                                        |
| ----------- | ----------------------------------------------- |
| Runtime     | Node (16.0)                                     |
| Entrypoint  | `src/main.js`                                   |
| Build       | `npm i`                                         |
| Execute     | `users` (any session, PIN mode included -- checkout needs this) |
| Scopes      | `documents.read`, `documents.write`             |

## Note on calling Appwrite's own API from within a function

This self-hosted instance's function-execution sandbox can't resolve its
own public hostname via the normal `getaddrinfo` path (used internally by
`fetch`/`http`) -- `dns.resolve4` (talks to nameservers directly,
bypassing `getaddrinfo`) works fine though. `src/appwriteClient.js` patches
the global `dns.lookup` so any HTTP client resolving this hostname gets the
known-good IP instead of hanging/`EAI_AGAIN`; the URL/Host header is
untouched, only the DNS step is bypassed. Every function that needs to
call Databases/Teams uses this same helper.
