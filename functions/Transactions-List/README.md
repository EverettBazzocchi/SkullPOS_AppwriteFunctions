# Transactions-List

Returns raw transaction documents (every status, not just `"complete"`)
from the last 24 hours -- always, regardless of caller -- for the
transactions/refund view. This range is fixed server-side, not
client-adjustable, since the UI never offers a wider range to anyone
(unlike Sales-Report, there's no team-membership distinction here).

The client has no read access to the Transactions collection at all (see
the POS PIN-system security plan), so this is the only way to see this
list. Ports the logic that used to live in the POS client's
`fetchTransactions` (`POS/src/utils/api.js`).

## Request body

```json
{ "test": false }
```

`test` selects dev-site (`testing: true`) vs live-site transactions, same
convention the client already used.

## Response

`{ "documents": [...] }` -- same document shape as before, newest first.

## Configuration

| Setting     | Value                                        |
| ----------- | ----------------------------------------------- |
| Runtime     | Node (16.0)                                     |
| Entrypoint  | `src/main.js`                                   |
| Build       | `npm i`                                         |
| Execute     | `users`                                         |
| Scopes      | `documents.read`                                |

## Note on calling Appwrite's own API from within a function

This self-hosted instance's function-execution sandbox can't resolve its
own public hostname via the normal `getaddrinfo` path (used internally by
`fetch`/`http`) -- `dns.resolve4` (talks to nameservers directly,
bypassing `getaddrinfo`) works fine though. `src/appwriteClient.js` patches
the global `dns.lookup` so any HTTP client resolving this hostname gets the
known-good IP instead of hanging/`EAI_AGAIN`; the URL/Host header is
untouched, only the DNS step is bypassed. Every function that needs to
call Databases/Teams/Users uses this same helper.
