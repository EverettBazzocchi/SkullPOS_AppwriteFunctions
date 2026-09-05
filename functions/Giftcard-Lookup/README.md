# Giftcard-Lookup

Looks up a giftcard by its UPC/code, server-side. Used by the POS when a
giftcard is scanned/entered at checkout.

The client has no read access to the giftcards collection (removed as part
of the POS PIN-system security plan -- see `AppwriteFunctions`'s
repo-level notes and `POS/src/utils/giftcard.js`), since a blanket read
grant would let any session, anonymous quick-access PIN sessions included,
list every giftcard code and balance in the system. This function only
ever returns the single card matching the exact code it was asked about.

## Request body

```json
{ "code": "ABCD1234" }
```

## Response

`{ "found": true, "id": "...", "balance": 1500 }` or `{ "found": false }`.
Never reveals more than the one matched card.

## Configuration

| Setting     | Value                          |
| ----------- | -------------------------------- |
| Runtime     | Node (16.0)                      |
| Entrypoint  | `src/main.js`                    |
| Build       | `npm i`                          |
| Execute     | `users` (any session, PIN mode included -- checkout needs this) |
| Scopes      | `documents.read`                 |

## Note on calling Appwrite's own API from within a function

This self-hosted instance's function-execution sandbox can't resolve its
own public hostname via the normal `getaddrinfo` path (used internally by
`fetch`/`http`) -- `dns.resolve4` (talks to nameservers directly,
bypassing `getaddrinfo`) works fine though. `src/appwriteClient.js` patches
the global `dns.lookup` so any HTTP client resolving this hostname gets the
known-good IP instead of hanging/`EAI_AGAIN`; the URL/Host header is
untouched, only the DNS step is bypassed. Every function that needs to
call Databases/Teams uses this same helper.
