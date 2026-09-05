# Transaction-ApplyGiftcard

Applies a giftcard payment to a pending transaction, server-side: re-reads
the transaction and giftcard fresh (never trusts a client-supplied
balance), computes the applied/remaining split, writes the transaction's
payment fields, and decrements the giftcard balance -- all in one call.

The client has no write access to Transactions or giftcards (removed as
part of the POS PIN-system security plan), since a blanket update grant
would let any session set an arbitrary giftcard balance directly. Only a
transaction currently `pending` with no giftcard already applied can be
targeted, so this can't be replayed against an already-finalized sale.

## Request body

```json
{ "transactionId": "...", "giftcardId": "..." }
```

## Response

`{ "ok": true, "applied": 1500, "remaining": 0, "status": "complete", "paymentMethod": "giftcard" }`
or `{ "error": "<message>" }` with a 4xx/5xx status.

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
